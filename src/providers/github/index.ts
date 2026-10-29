import { AppTokenSource, type InstallationToken, type TokenSource } from './app-auth.ts';
import { API_VERSION, DEFAULT_BASE_URL, mapError, nextCursor, USER_AGENT } from './common.ts';
import { codeFromStatus, RepoError } from '../../errors.ts';
import {
  expectArray,
  expectBoolean,
  expectNumber,
  expectRecord,
  expectString,
} from '../../decode.ts';
import { HttpClient } from '../../http.ts';
import { assertSameOriginUrl, decodeCursor } from '../../pagination.ts';
import {
  clampPerPage,
  commitWebUrlBuilder,
  encodeRefPath,
  filenameFromContentDisposition,
  toCloneUrl,
} from '../shared.ts';
import type {
  Archive,
  AuthenticatedUser,
  Branch,
  CloneCredentials,
  CloneUrl,
  Commit,
  CreateWebhookParams,
  DeleteWebhookParams,
  DownloadArchiveParams,
  GetAuthenticatedUserParams,
  GetBranchParams,
  GetCloneCredentialsParams,
  GetCloneUrlParams,
  GetCommitParams,
  GetRepositoryParams,
  GetTagParams,
  GetWebhookParams,
  GitActor,
  ListBranchesParams,
  ListCommitsParams,
  ListNamespacesParams,
  ListRepositoriesParams,
  ListTagsParams,
  ListWebhooksParams,
  Namespace,
  Page,
  ProviderSearchRefsParams,
  ProviderRefMatch,
  Repository,
  Tag,
  TokenProvider,
  UpdateWebhookParams,
  RepoCapabilities,
  RepoProvider,
  Webhook,
  WebhookEventType,
} from '../../types.ts';

export interface GitHubTokenAuth {
  token: string;
}

export interface GitHubAppAuth {
  appId: string | number;
  privateKey: string;
  installationId?: string | number;
  /** Account (org or user) whose installation to act as; alternative to installationId. */
  owner?: string;
  /**
   * Restrict the minted installation token to these repository names within the
   * installation's account. Omitted: every repository the installation can access.
   */
  repositories?: string[];
  /**
   * Restrict the minted installation token to these repository ids. Ids survive a
   * repository rename, so prefer them over `repositories` when the repository is
   * stored long-term. Mutually exclusive with `repositories`.
   */
  repositoryIds?: Array<string | number>;
}

export interface GitHubTokenProviderAuth {
  /** Mints a bearer token per request; re-invoked with `forceRefresh` after a 401, then retried once. */
  tokenProvider: TokenProvider;
}

export type GitHubAuth = GitHubTokenAuth | GitHubAppAuth | GitHubTokenProviderAuth;

export interface GitHubProviderOptions {
  auth: GitHubAuth;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export type GitHubInstallationToken = InstallationToken;

export interface GitHubRepoProvider extends RepoProvider {
  /**
   * The current GitHub App installation token (minted or refreshed on demand),
   * for handing to tools outside the SDK such as the `git` CLI. Requires
   * GitHub App auth; throws `unsupported` under token auth.
   */
  getInstallationToken(): Promise<GitHubInstallationToken>;
}

const CAPABILITIES: Omit<RepoCapabilities, 'userProfile'> = {
  tagDates: false,
  repoSearch: true,
  ownedRepoFilter: true,
  commitUserRef: true,
  refSearch: true,
  webhookEvents: ['push', 'tag_push', 'release'],
  webhookVerification: 'hmac-sha256',
  archiveFormats: ['zip', 'tar.gz'],
};

function createStaticTokenSource(auth: GitHubTokenAuth): TokenSource {
  const { token } = auth;
  return {
    kind: 'token',
    getToken: () => Promise.resolve(token),
    getTokenWithExpiry: () => Promise.resolve({ token }),
    getSecrets: () => [token],
  };
}

function createProviderTokenSource(auth: GitHubTokenProviderAuth): TokenSource {
  let lastToken: string | undefined;
  const fetchToken = async (forceRefresh: boolean): Promise<string> => {
    lastToken = await auth.tokenProvider({ forceRefresh });
    return lastToken;
  };
  return {
    kind: 'token',
    getToken: (forceRefresh = false) => fetchToken(forceRefresh),
    getTokenWithExpiry: async () => ({ token: await fetchToken(false) }),
    getSecrets: () => (lastToken === undefined ? [] : [lastToken]),
  };
}

function createTokenSource(
  auth: GitHubAuth,
  baseUrl: string,
  fetchImpl: typeof fetch,
): TokenSource {
  if ('token' in auth) {
    return createStaticTokenSource(auth);
  }
  if ('tokenProvider' in auth) {
    return createProviderTokenSource(auth);
  }
  return new AppTokenSource({
    appId: auth.appId,
    privateKey: auth.privateKey,
    installationId: auth.installationId,
    owner: auth.owner,
    repositories: auth.repositories,
    repositoryIds: auth.repositoryIds,
    baseUrl,
    fetchImpl,
    apiVersion: API_VERSION,
    userAgent: USER_AGENT,
  });
}

interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string;
}

interface GitHubEmail {
  email: string;
  primary?: boolean;
  verified?: boolean;
}

interface GitHubOrg {
  id: number;
  login: string;
  avatar_url?: string;
}

interface GitHubIdentity {
  id: number;
  login: string;
  avatar_url?: string;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; type?: string; avatar_url?: string };
  default_branch?: string;
  private: boolean;
  archived?: boolean;
  html_url?: string;
  clone_url?: string;
  ssh_url?: string;
}

interface GitHubActor {
  name?: string;
  email?: string;
  date?: string;
}

interface GitHubCommit {
  sha: string;
  html_url?: string;
  parents?: { sha: string }[];
  author?: GitHubIdentity | null;
  committer?: GitHubIdentity | null;
  commit?: {
    message?: string;
    author?: GitHubActor;
    committer?: GitHubActor;
  };
}

interface GitHubTag {
  name: string;
  commit: { sha: string };
}

interface GitHubBranch {
  name: string;
  commit: { sha: string };
}

interface GitHubRef {
  ref: string;
  object: { sha: string; type: string };
}

interface GitHubTagObject {
  sha: string;
  tag: string;
  message?: string | null;
  tagger?: { date?: string };
  object: { sha: string; type: string };
}

interface GitHubHookConfig {
  url?: string;
  content_type?: string;
  insecure_ssl?: string;
  secret?: string;
}

interface GitHubHook {
  id: number;
  active: boolean;
  events?: string[];
  config?: GitHubHookConfig;
}

function gitHostFromBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return url.hostname === 'api.github.com' ? 'github.com' : url.host;
}

function decodeUser(value: unknown): GitHubUser {
  const user = expectRecord(value, 'user');
  expectNumber(user.id, 'user.id');
  expectString(user.login, 'user.login');
  return value as GitHubUser;
}

function decodeEmail(value: unknown): GitHubEmail {
  expectRecord(value, 'email');
  return value as GitHubEmail;
}

function decodeEmails(value: unknown): GitHubEmail[] {
  return expectArray(value, 'emails').map(decodeEmail);
}

function decodeOrg(value: unknown): GitHubOrg {
  const org = expectRecord(value, 'organization');
  expectNumber(org.id, 'organization.id');
  expectString(org.login, 'organization.login');
  return value as GitHubOrg;
}

function decodeOrgs(value: unknown): GitHubOrg[] {
  return expectArray(value, 'organizations').map(decodeOrg);
}

function decodeRepository(value: unknown): GitHubRepo {
  const repo = expectRecord(value, 'repository');
  expectNumber(repo.id, 'repository.id');
  expectString(repo.name, 'repository.name');
  expectString(repo.full_name, 'repository.full_name');
  expectString(expectRecord(repo.owner, 'repository.owner').login, 'repository.owner.login');
  expectBoolean(repo.private, 'repository.private');
  return value as GitHubRepo;
}

function decodeRepositories(value: unknown): GitHubRepo[] {
  return expectArray(value, 'repositories').map(decodeRepository);
}

function decodeSearchRepositories(value: unknown): GitHubRepo[] {
  return decodeRepositories(expectRecord(value, 'repositories').items);
}

function decodeInstallationRepositories(value: unknown): GitHubRepo[] {
  return decodeRepositories(expectRecord(value, 'repositories').repositories ?? []);
}

// The list endpoints answer with a bare array, search wraps its page in `{ items }` and the
// installation endpoint in `{ repositories }`, and a cursor may point at any of them.
function decodeRepositoryPage(value: unknown): GitHubRepo[] {
  if (Array.isArray(value)) return decodeRepositories(value);
  const page = expectRecord(value, 'repositories');
  return decodeRepositories(page.items ?? page.repositories);
}

function decodeCommit(value: unknown): GitHubCommit {
  const commit = expectRecord(value, 'commit');
  expectString(commit.sha, 'commit.sha');
  return value as GitHubCommit;
}

function decodeCommits(value: unknown): GitHubCommit[] {
  return expectArray(value, 'commits').map(decodeCommit);
}

function decodeTag(value: unknown): GitHubTag {
  const tag = expectRecord(value, 'tag');
  expectString(tag.name, 'tag.name');
  expectString(expectRecord(tag.commit, 'tag.commit').sha, 'tag.commit.sha');
  return value as GitHubTag;
}

function decodeTags(value: unknown): GitHubTag[] {
  return expectArray(value, 'tags').map(decodeTag);
}

function decodeBranch(value: unknown): GitHubBranch {
  const branch = expectRecord(value, 'branch');
  expectString(branch.name, 'branch.name');
  expectString(expectRecord(branch.commit, 'branch.commit').sha, 'branch.commit.sha');
  return value as GitHubBranch;
}

function decodeBranches(value: unknown): GitHubBranch[] {
  return expectArray(value, 'branches').map(decodeBranch);
}

function decodeRef(value: unknown): GitHubRef {
  const ref = expectRecord(value, 'ref');
  expectString(ref.ref, 'ref.ref');
  const object = expectRecord(ref.object, 'ref.object');
  expectString(object.sha, 'ref.object.sha');
  expectString(object.type, 'ref.object.type');
  return value as GitHubRef;
}

function decodeRefs(value: unknown): GitHubRef[] {
  return expectArray(value, 'refs').map(decodeRef);
}

function decodeTagObject(value: unknown): GitHubTagObject {
  const tag = expectRecord(value, 'tag object');
  const object = expectRecord(tag.object, 'tag object.object');
  expectString(object.sha, 'tag object.object.sha');
  expectString(object.type, 'tag object.object.type');
  return value as GitHubTagObject;
}

function decodeHook(value: unknown): GitHubHook {
  const hook = expectRecord(value, 'webhook');
  expectNumber(hook.id, 'webhook.id');
  expectBoolean(hook.active, 'webhook.active');
  return value as GitHubHook;
}

function decodeHooks(value: unknown): GitHubHook[] {
  return expectArray(value, 'webhooks').map(decodeHook);
}

function toAuthenticatedUser(user: GitHubUser): AuthenticatedUser {
  return {
    id: String(user.id),
    username: user.login,
    name: user.name ?? undefined,
    email: user.email ?? undefined,
    avatarUrl: user.avatar_url,
    raw: user,
  };
}

function toAppNamespacePage(repos: GitHubRepo[]): Page<Namespace> {
  const owner = repos[0]?.owner;
  if (!owner) return { data: [] };
  const namespace: Namespace = {
    id: owner.login,
    slug: owner.login,
    name: owner.login,
    kind: owner.type === 'Organization' ? 'organization' : 'user',
    avatarUrl: owner.avatar_url,
    raw: owner,
  };
  return { data: [namespace] };
}

function toUserNamespace(user: GitHubUser): Namespace {
  return {
    id: String(user.id),
    slug: user.login,
    name: user.login,
    kind: 'user',
    avatarUrl: user.avatar_url,
    raw: user,
  };
}

function toOrgNamespace(org: GitHubOrg): Namespace {
  return {
    id: String(org.id),
    slug: org.login,
    name: org.login,
    kind: 'organization',
    avatarUrl: org.avatar_url,
    raw: org,
  };
}

function toRepository(repo: GitHubRepo, webBase: string): Repository {
  return {
    id: String(repo.id),
    name: repo.name,
    path: repo.full_name,
    namespace: repo.owner.login,
    defaultBranch: repo.default_branch,
    private: repo.private,
    archived: repo.archived,
    urls: {
      web: repo.html_url ?? `${webBase}/${repo.full_name}`,
      cloneHttp: repo.clone_url,
      cloneSsh: repo.ssh_url,
    },
    raw: repo,
  };
}

function toActor(actor: GitHubActor | undefined, identity?: GitHubIdentity | null): GitActor {
  return {
    name: actor?.name ?? '',
    email: actor?.email ?? undefined,
    date: actor?.date ? new Date(actor.date) : new Date(0),
    user: identity
      ? { id: String(identity.id), username: identity.login, avatarUrl: identity.avatar_url }
      : undefined,
  };
}

function toCommit(commit: GitHubCommit): Commit {
  return {
    sha: commit.sha,
    message: commit.commit?.message ?? '',
    author: toActor(commit.commit?.author, commit.author),
    committer: commit.commit?.committer
      ? toActor(commit.commit.committer, commit.committer)
      : undefined,
    parents: (commit.parents ?? []).map((parent) => parent.sha),
    url: commit.html_url,
    raw: commit,
  };
}

function toTag(tag: GitHubTag): Tag {
  return { name: tag.name, sha: tag.commit.sha, raw: tag };
}

function toBranch(branch: GitHubBranch): Branch {
  return { name: branch.name, sha: branch.commit.sha, raw: branch };
}

function toTagRef(ref: GitHubRef) {
  return {
    name: ref.ref.replace(/^refs\/tags\//, ''),
    type: ref.object.type,
    sha: ref.object.sha,
    raw: ref,
  };
}

function toTagTarget(tag: GitHubTagObject) {
  return {
    type: tag.object.type,
    sha: tag.object.sha,
    message: tag.message ?? undefined,
    date: tag.tagger?.date ? new Date(tag.tagger.date) : undefined,
    raw: tag,
  };
}

function toHookConfig(existing: GitHubHook, url: string | undefined): GitHubHookConfig {
  return {
    url: url ?? existing.config?.url,
    content_type: existing.config?.content_type ?? 'json',
    insecure_ssl: existing.config?.insecure_ssl ?? '0',
  };
}

function toGitHubEvents(events: WebhookEventType[]): string[] {
  const result = new Set<string>();
  for (const event of events) {
    if (event === 'push') result.add('push');
    else if (event === 'tag_push') {
      result.add('create');
      result.add('delete');
    } else if (event === 'release') result.add('release');
  }
  return [...result];
}

function fromGitHubEvents(events: string[]): WebhookEventType[] {
  const result = new Set<WebhookEventType>();
  for (const event of events) {
    if (event === 'push') result.add('push');
    else if (event === 'create' || event === 'delete') result.add('tag_push');
    else if (event === 'release') result.add('release');
  }
  return [...result];
}

const parseWebhook = (body: unknown): Webhook => toWebhook(decodeHook(body));

function toWebhook(hook: GitHubHook): Webhook {
  return {
    id: String(hook.id),
    url: hook.config?.url ?? '',
    events: fromGitHubEvents(hook.events ?? []),
    active: hook.active,
    raw: hook,
  };
}

/**
 * Builds the human-facing web URL for a commit from the repository's web URL
 * (`Repository.urls.web`) and a commit SHA — no API request needed.
 */
export const commitWebUrl = commitWebUrlBuilder('commit');

export function github(options: GitHubProviderOptions): GitHubRepoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;
  const tokenSource = createTokenSource(options.auth, baseUrl, fetchImpl);
  const webBase = `https://${gitHostFromBaseUrl(baseUrl)}`;
  const mapRepository = (repo: GitHubRepo): Repository => toRepository(repo, webBase);
  const parseRepositories = (body: unknown): Repository[] =>
    decodeRepositories(body).map(mapRepository);

  const http = new HttpClient({
    provider: 'github',
    baseUrl,
    fetchImpl,
    authHeaders: async ({ forceRefresh }) => {
      const token = await tokenSource.getToken(forceRefresh);
      return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': API_VERSION,
        'User-Agent': USER_AGENT,
      };
    },
    mapError,
    secrets: () => tokenSource.getSecrets(),
    retryUnauthorized: 'tokenProvider' in options.auth,
  });

  async function fetchPrimaryEmail(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const { data } = await http.json(
        '/user/emails',
        (body) => decodeEmails(body).find((entry) => entry.primary && entry.verified)?.email,
        { signal },
      );
      return data;
    } catch (error) {
      if (error instanceof RepoError && error.code === 'forbidden') return undefined;
      throw error;
    }
  }

  let cachedLogin: string | undefined;
  async function getLogin(signal?: AbortSignal): Promise<string> {
    if (tokenSource.kind === 'app') {
      // Installation tokens have no user identity, so `/user` 403s. Owned/
      // search-by-self resolution simply isn't available under GitHub App auth.
      throw new RepoError(
        'Resolving the authenticated user (owned repositories / search-by-self) is not supported under GitHub App authentication',
        { code: 'unsupported', provider: 'github' },
      );
    }
    if (cachedLogin === undefined) {
      const { data } = await http.json('/user', (body) => decodeUser(body).login, { signal });
      cachedLogin = data;
    }
    return cachedLogin;
  }

  function repoPath(repo: string): string {
    return `/repos/${repo}`;
  }

  // An installation token can only see the account it is installed on, so we
  // surface that single account as the one namespace. Pragmatic shortcut: rather
  // than resolve the installation account separately, we derive it from the first
  // accessible repository's owner. Zero repositories → empty page.
  async function listAppNamespaces(signal?: AbortSignal): Promise<Page<Namespace>> {
    const { data } = await http.json(
      '/installation/repositories',
      (body) => toAppNamespacePage(decodeInstallationRepositories(body)),
      { query: { per_page: 1 }, signal },
    );
    return data;
  }

  function getCloneCredentials(params: GetCloneCredentialsParams): Promise<CloneCredentials> {
    const host = gitHostFromBaseUrl(baseUrl);
    return tokenSource.getTokenWithExpiry().then(({ token, expiresAt }) => ({
      expiresAt,
      password: token,
      url: `https://${host}/${params.repo}.git`,
      username: 'x-access-token',
    }));
  }

  return {
    name: 'github',
    // Installation tokens have no user identity, so `/user` 403s under App auth.
    capabilities: { ...CAPABILITIES, userProfile: tokenSource.kind === 'token' },

    async getAuthenticatedUser(params: GetAuthenticatedUserParams): Promise<AuthenticatedUser> {
      if (tokenSource.kind === 'app') {
        throw new RepoError(
          'Resolving the authenticated user is not supported under GitHub App authentication',
          { code: 'unsupported', provider: 'github' },
        );
      }
      const { data: user } = await http.json(
        '/user',
        (body) => toAuthenticatedUser(decodeUser(body)),
        { signal: params.signal },
      );
      // `/user` hides the email for private-email accounts; `includeEmail`
      // resolves it via `/user/emails` (user:email scope) with the missing
      // scope leaving the email unset rather than failing the whole call.
      if (user.email === undefined && params.includeEmail) {
        user.email = await fetchPrimaryEmail(params.signal);
      }
      return user;
    },

    getInstallationToken(): Promise<GitHubInstallationToken> {
      if (!(tokenSource instanceof AppTokenSource)) {
        return Promise.reject(
          new RepoError('getInstallationToken requires GitHub App authentication', {
            code: 'unsupported',
            provider: 'github',
          }),
        );
      }
      return tokenSource.getInstallationToken();
    },

    async listNamespaces(params: ListNamespacesParams): Promise<Page<Namespace>> {
      if (tokenSource.kind === 'app') {
        return listAppNamespaces(params.signal);
      }
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('github', params.cursor);
        assertSameOriginUrl('github', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => decodeOrgs(body).map(toOrgNamespace),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }
      const { data: user } = await http.json('/user', (body) => toUserNamespace(decodeUser(body)), {
        signal: params.signal,
      });
      const { data: orgs, response } = await http.json(
        '/user/orgs',
        (body) => decodeOrgs(body).map(toOrgNamespace),
        { query: { per_page: clampPerPage(params.limit) }, signal: params.signal },
      );
      return {
        data: [user, ...orgs],
        cursor: nextCursor(response),
      };
    },

    async listRepositories(params: ListRepositoriesParams): Promise<Page<Repository>> {
      const perPage = clampPerPage(params.limit);

      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('github', params.cursor);
        assertSameOriginUrl('github', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => decodeRepositoryPage(body).map(mapRepository),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }

      if (params.query !== undefined) {
        let q = params.query;
        if (params.namespace) q += ` user:${params.namespace}`;
        else if (params.owned) q += ` user:${await getLogin(params.signal)}`;
        const { data, response } = await http.json(
          '/search/repositories',
          (body) => decodeSearchRepositories(body).map(mapRepository),
          {
            query: { q, per_page: perPage },
            signal: params.signal,
          },
        );
        return { data, cursor: nextCursor(response) };
      }

      if (params.namespace) {
        // Under app auth the `/users/{username}/repos` fallback below would hide
        // private repositories on user accounts (it only ever lists public
        // ones), so list the installation's own repositories instead. The owner
        // filter is a guard: an installation belongs to exactly one account.
        if (tokenSource.kind === 'app') {
          const namespaceLower = params.namespace.toLowerCase();
          const { data, response } = await http.json(
            '/installation/repositories',
            (body) =>
              decodeInstallationRepositories(body)
                .filter((repo) => repo.owner.login.toLowerCase() === namespaceLower)
                .map(mapRepository),
            { query: { per_page: perPage }, signal: params.signal },
          );
          return { data, cursor: nextCursor(response) };
        }
        try {
          const { data, response } = await http.json(
            `/orgs/${encodeURIComponent(params.namespace)}/repos`,
            parseRepositories,
            { query: { per_page: perPage }, signal: params.signal },
          );
          return { data, cursor: nextCursor(response) };
        } catch (error) {
          if (!(error instanceof RepoError && error.code === 'not_found')) throw error;
        }
        const login = await getLogin(params.signal);
        if (login.toLowerCase() === params.namespace.toLowerCase()) {
          const { data, response } = await http.json('/user/repos', parseRepositories, {
            query: { affiliation: 'owner', per_page: perPage },
            signal: params.signal,
          });
          return { data, cursor: nextCursor(response) };
        }
        const { data, response } = await http.json(
          `/users/${encodeURIComponent(params.namespace)}/repos`,
          parseRepositories,
          { query: { per_page: perPage }, signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }

      // Default (and owned) listing. Under app auth `/user/repos` 403s; the
      // installation's accessible repositories are the correct equivalent.
      if (tokenSource.kind === 'app') {
        const { data, response } = await http.json(
          '/installation/repositories',
          (body) => decodeInstallationRepositories(body).map(mapRepository),
          { query: { per_page: perPage }, signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }

      const { data, response } = await http.json('/user/repos', parseRepositories, {
        query: { affiliation: params.owned ? 'owner' : undefined, per_page: perPage },
        signal: params.signal,
      });
      return { data, cursor: nextCursor(response) };
    },

    async getRepository(params: GetRepositoryParams): Promise<Repository> {
      const { data } = await http.json(
        repoPath(params.repo),
        (body) => mapRepository(decodeRepository(body)),
        {
          signal: params.signal,
        },
      );
      return data;
    },

    async listCommits(params: ListCommitsParams): Promise<Page<Commit>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('github', params.cursor);
        assertSameOriginUrl('github', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => decodeCommits(body).map(toCommit),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }
      const { data, response } = await http.json(
        `${repoPath(params.repo)}/commits`,
        (body) => decodeCommits(body).map(toCommit),
        {
          query: {
            sha: params.ref,
            path: params.path,
            author: params.author,
            since: params.since?.toISOString(),
            until: params.until?.toISOString(),
            per_page: clampPerPage(params.limit),
          },
          signal: params.signal,
        },
      );
      return { data, cursor: nextCursor(response) };
    },

    async getCommit(params: GetCommitParams): Promise<Commit> {
      const { data } = await http.json(
        `${repoPath(params.repo)}/commits/${encodeURIComponent(params.ref)}`,
        (body) => toCommit(decodeCommit(body)),
        { signal: params.signal },
      );
      return data;
    },

    async listTags(params: ListTagsParams): Promise<Page<Tag>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('github', params.cursor);
        assertSameOriginUrl('github', baseUrl, url);
        const { data, response } = await http.json(url, (body) => decodeTags(body).map(toTag), {
          signal: params.signal,
        });
        return { data, cursor: nextCursor(response) };
      }
      const { data, response } = await http.json(
        `${repoPath(params.repo)}/tags`,
        (body) => decodeTags(body).map(toTag),
        { query: { per_page: clampPerPage(params.limit) }, signal: params.signal },
      );
      return { data, cursor: nextCursor(response) };
    },

    async listBranches(params: ListBranchesParams): Promise<Page<Branch>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('github', params.cursor);
        assertSameOriginUrl('github', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => decodeBranches(body).map(toBranch),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }
      const { data, response } = await http.json(
        `${repoPath(params.repo)}/branches`,
        (body) => decodeBranches(body).map(toBranch),
        {
          query: { per_page: clampPerPage(params.limit) },
          signal: params.signal,
        },
      );
      return { data, cursor: nextCursor(response) };
    },

    async getBranch(params: GetBranchParams): Promise<Branch> {
      const { data } = await http.json(
        `${repoPath(params.repo)}/branches/${encodeRefPath(params.name)}`,
        (body) => toBranch(decodeBranch(body)),
        { signal: params.signal },
      );
      return data;
    },

    async getTag(params: GetTagParams): Promise<Tag> {
      const { data: ref } = await http.json(
        `${repoPath(params.repo)}/git/ref/tags/${encodeRefPath(params.name)}`,
        (body) => toTagRef(decodeRef(body)),
        { signal: params.signal },
      );
      const name = ref.name;
      if (ref.type !== 'tag') {
        return { name, sha: ref.sha, isAnnotated: false, raw: ref.raw };
      }
      // Annotated tags may point at further tag objects; peel a bounded chain.
      let sha = ref.sha;
      for (let hops = 0; hops < 5; hops++) {
        const { data } = await http.json(
          `${repoPath(params.repo)}/git/tags/${sha}`,
          (body) => toTagTarget(decodeTagObject(body)),
          { signal: params.signal },
        );
        sha = data.sha;
        if (data.type !== 'tag') {
          return {
            name,
            sha,
            message: data.message,
            date: data.date,
            isAnnotated: true,
            raw: data.raw,
          };
        }
      }
      throw new RepoError(`Tag ${name} points at a tag chain deeper than 5 objects`, {
        code: 'provider_error',
        provider: 'github',
      });
    },

    async searchRefs(params: ProviderSearchRefsParams): Promise<ProviderRefMatch[]> {
      const namespaces = { branch: 'heads', tag: 'tags' } as const;
      // The matching-refs endpoint prefix-matches and is unpaginated; truncate to `limit`.
      const matches = await Promise.all(
        (['branch', 'tag'] as const)
          .filter((type) => params.types.includes(type))
          .map(async (type) => {
            const prefix = `refs/${namespaces[type]}/`;
            const { data } = await http.json(
              `${repoPath(params.repo)}/git/matching-refs/${namespaces[type]}/${encodeRefPath(params.query)}`,
              (body) =>
                decodeRefs(body).map((ref): ProviderRefMatch => ({
                  type,
                  name: ref.ref.slice(prefix.length),
                  sha: ref.object.sha,
                  raw: ref,
                })),
              { signal: params.signal },
            );
            return data;
          }),
      );
      return matches.flat().slice(0, params.limit);
    },

    async downloadArchive(params: DownloadArchiveParams): Promise<Archive> {
      const format = params.format ?? 'zip';
      const endpoint = format === 'zip' ? 'zipball' : 'tarball';
      const response = await http.raw(
        `${repoPath(params.repo)}/${endpoint}/${encodeURIComponent(params.ref)}`,
        { redirect: 'manual', signal: params.signal },
      );

      let archiveResponse = response;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new RepoError('GitHub archive redirect is missing a location header', {
            code: 'provider_error',
            provider: 'github',
          });
        }
        // Signed codeload URL — never forward the Authorization header to it.
        try {
          archiveResponse = await fetchImpl(location, { signal: params.signal });
        } catch (error) {
          throw new RepoError('GitHub archive download request failed', {
            code: 'network_error',
            provider: 'github',
            cause: error,
            secrets: tokenSource.getSecrets(),
          });
        }
        if (!archiveResponse.ok) {
          throw new RepoError(
            `GitHub archive download failed with status ${archiveResponse.status}`,
            {
              code: codeFromStatus(archiveResponse.status),
              provider: 'github',
              status: archiveResponse.status,
            },
          );
        }
      }

      if (!archiveResponse.body) {
        throw new RepoError('GitHub archive response has no body', {
          code: 'provider_error',
          provider: 'github',
        });
      }
      return {
        stream: archiveResponse.body,
        contentType: archiveResponse.headers.get('content-type') ?? undefined,
        filename: filenameFromContentDisposition(
          archiveResponse.headers.get('content-disposition'),
        ),
      };
    },

    getCloneCredentials,

    async getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl> {
      return toCloneUrl(await getCloneCredentials(params));
    },

    async createWebhook(params: CreateWebhookParams): Promise<Webhook> {
      const { data } = await http.json(`${repoPath(params.repo)}/hooks`, parseWebhook, {
        method: 'POST',
        body: {
          name: 'web',
          active: params.active ?? true,
          events: toGitHubEvents(params.events),
          config: {
            url: params.url,
            content_type: 'json',
            insecure_ssl: '0',
            secret: params.secret,
          },
        },
        signal: params.signal,
      });
      return data;
    },

    async listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('github', params.cursor);
        assertSameOriginUrl('github', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => decodeHooks(body).map(toWebhook),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }
      const { data, response } = await http.json(
        `${repoPath(params.repo)}/hooks`,
        (body) => decodeHooks(body).map(toWebhook),
        { query: { per_page: clampPerPage(params.limit) }, signal: params.signal },
      );
      return { data, cursor: nextCursor(response) };
    },

    async getWebhook(params: GetWebhookParams): Promise<Webhook> {
      const { data } = await http.json(
        `${repoPath(params.repo)}/hooks/${params.id}`,
        parseWebhook,
        { signal: params.signal },
      );
      return data;
    },

    async updateWebhook(params: UpdateWebhookParams): Promise<Webhook> {
      const hookPath = `${repoPath(params.repo)}/hooks/${params.id}`;
      // GitHub's PATCH replaces the ENTIRE config object and requires config.url
      // whenever config is present. Sending a partial config would wipe the
      // stored secret and other fields, so hydrate from the existing hook and
      // merge. When only active/events change we send NO config block, leaving
      // the stored config (and its secret) untouched.
      const needsConfig = params.url !== undefined || params.secret !== undefined;
      let config: GitHubHookConfig | undefined;
      if (needsConfig) {
        const { data: existingConfig } = await http.json(
          hookPath,
          (body) => toHookConfig(decodeHook(body), params.url),
          { signal: params.signal },
        );
        config = existingConfig;
        // Omit the secret key entirely to preserve the stored secret; only send
        // it when the caller explicitly provides a new one. GitHub keeps the
        // existing secret when the key is absent from the config object.
        if (params.secret !== undefined) config.secret = params.secret;
      }
      const { data } = await http.json(hookPath, parseWebhook, {
        method: 'PATCH',
        body: {
          active: params.active,
          events: params.events ? toGitHubEvents(params.events) : undefined,
          config,
        },
        signal: params.signal,
      });
      return data;
    },

    async deleteWebhook(params: DeleteWebhookParams): Promise<void> {
      await http.raw(`${repoPath(params.repo)}/hooks/${params.id}`, {
        method: 'DELETE',
        signal: params.signal,
      });
    },
  };
}

import { RepoError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { assertSameOriginUrl, decodeCursor, encodeCursor } from '../../pagination.ts';
import {
  clampPerPage,
  commitWebUrlBuilder,
  encodeRefPath,
  filenameFromContentDisposition,
  isRecord,
  parseLinkNext,
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

const DEFAULT_BASE_URL = 'https://gitea.com/api/v1';

export interface GiteaProviderOptions {
  /** A static token, or a `tokenProvider` minting bearer tokens per request (retried once on a 401). */
  auth: { token: string } | { tokenProvider: TokenProvider };
  /**
   * Full API base URL. Defaults to `https://gitea.com/api/v1`. For self-hosted
   * instances (including Forgejo) pass the complete base including `/api/v1`
   * (used verbatim).
   */
  baseUrl?: string;
  fetch?: typeof fetch;
}

const CAPABILITIES: RepoCapabilities = {
  userProfile: true,
  tagDates: false,
  repoSearch: true,
  ownedRepoFilter: true,
  commitUserRef: true,
  refSearch: true,
  webhookEvents: ['push', 'tag_push', 'release'],
  webhookVerification: 'hmac-sha256',
  archiveFormats: ['zip', 'tar.gz'],
};

interface GiteaUser {
  id: number;
  login?: string;
  username?: string;
  full_name?: string;
  email?: string;
  avatar_url?: string;
}

interface GiteaOrg {
  id: number;
  name?: string;
  username?: string;
  full_name?: string;
  avatar_url?: string;
}

interface GiteaRepo {
  id: number;
  name: string;
  full_name: string;
  owner?: { login?: string; username?: string };
  default_branch?: string;
  private: boolean;
  archived?: boolean;
  html_url?: string;
  clone_url?: string;
  ssh_url?: string;
}

interface GiteaActor {
  name?: string;
  email?: string;
  date?: string;
}

interface GiteaCommit {
  sha: string;
  html_url?: string;
  parents?: { sha: string }[];
  author?: GiteaUser | null;
  committer?: GiteaUser | null;
  commit?: {
    message?: string;
    author?: GiteaActor;
    committer?: GiteaActor;
  };
}

interface GiteaTag {
  name: string;
  message?: string | null;
  /** SHA of the tag object; equals the commit SHA for lightweight tags. */
  id?: string;
  commit?: { sha?: string };
}

interface GiteaBranch {
  name: string;
  commit: { id: string };
}

interface GiteaRef {
  ref: string;
  object: { sha: string; type: string };
}

interface GiteaHookConfig {
  url?: string;
  content_type?: string;
  secret?: string;
}

interface GiteaHook {
  id: number;
  active: boolean;
  events?: string[];
  config?: GiteaHookConfig;
}

function nextCursor(response: Response): string | undefined {
  const next = parseLinkNext(response.headers.get('link'));
  return next === undefined ? undefined : encodeCursor('gitea', { url: next });
}

function reposFromBody(body: unknown): GiteaRepo[] {
  if (Array.isArray(body)) return body as GiteaRepo[];
  if (isRecord(body) && Array.isArray(body.data)) return body.data as GiteaRepo[];
  return [];
}

// A server that is not Gitea may answer the organizations path with a JSON object; mapping it
// would throw a bare TypeError, so it fails as a RepoError like every other bad response.
function orgsFromBody(body: unknown): GiteaOrg[] {
  if (Array.isArray(body)) return body as GiteaOrg[];
  throw new RepoError('gitea returned an unexpected response for the organizations list', {
    code: 'invalid_response',
    provider: 'gitea',
  });
}

function toUserNamespace(user: GiteaUser): Namespace {
  const slug = user.login ?? user.username ?? '';
  return {
    id: String(user.id),
    slug,
    name: user.full_name || slug,
    kind: 'user',
    avatarUrl: user.avatar_url,
    raw: user,
  };
}

function toOrgNamespace(org: GiteaOrg): Namespace {
  const slug = org.username ?? org.name ?? '';
  return {
    id: String(org.id),
    slug,
    name: org.full_name || slug,
    kind: 'organization',
    avatarUrl: org.avatar_url,
    raw: org,
  };
}

function toRepository(repo: GiteaRepo, webBase: string): Repository {
  return {
    id: String(repo.id),
    name: repo.name,
    path: repo.full_name,
    namespace: repo.owner?.login ?? repo.owner?.username ?? repo.full_name.split('/')[0] ?? '',
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

function toActor(actor: GiteaActor | undefined, identity?: GiteaUser | null): GitActor {
  return {
    name: actor?.name ?? '',
    email: actor?.email ?? undefined,
    date: actor?.date ? new Date(actor.date) : new Date(0),
    user: identity
      ? {
          id: String(identity.id),
          username: identity.login ?? identity.username ?? '',
          avatarUrl: identity.avatar_url,
        }
      : undefined,
  };
}

function toCommit(commit: GiteaCommit): Commit {
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

function toTag(tag: GiteaTag): Tag {
  const commitSha = tag.commit?.sha;
  return {
    name: tag.name,
    sha: commitSha ?? tag.id ?? '',
    message: tag.message || undefined,
    isAnnotated: tag.id != null && commitSha != null ? tag.id !== commitSha : undefined,
    raw: tag,
  };
}

function toBranch(branch: GiteaBranch): Branch {
  return { name: branch.name, sha: branch.commit.id, raw: branch };
}

// Gitea has no server-side author filter — filter the returned page locally.
function filterByAuthor(commits: GiteaCommit[], author: string | undefined): GiteaCommit[] {
  if (!author) return commits;
  return commits.filter((commit) => {
    const actor = commit.commit?.author;
    return (actor?.name ?? '').includes(author) || (actor?.email ?? '').includes(author);
  });
}

function toGiteaEvents(events: WebhookEventType[]): string[] {
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

function fromGiteaEvents(events: string[]): WebhookEventType[] {
  const result = new Set<WebhookEventType>();
  for (const event of events) {
    if (event === 'push') result.add('push');
    else if (event === 'create' || event === 'delete') result.add('tag_push');
    else if (event === 'release') result.add('release');
  }
  return [...result];
}

function toWebhook(hook: GiteaHook): Webhook {
  return {
    id: String(hook.id),
    url: hook.config?.url ?? '',
    events: fromGiteaEvents(hook.events ?? []),
    active: hook.active,
    raw: hook,
  };
}

function parseWebhook(body: unknown): Webhook {
  return toWebhook(body as GiteaHook);
}

function mapError(_status: number, body: unknown): ProviderErrorInfo {
  const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
  // Status→code mapping is handled by the core HTTP layer; Gitea has no
  // built-in rate limiter, so a 429 can only come from a fronting proxy.
  return { message };
}

/**
 * Builds the human-facing web URL for a commit from the repository's web URL
 * (`Repository.urls.web`) and a commit SHA — no API request needed.
 */
export const commitWebUrl = commitWebUrlBuilder('commit');

export function gitea(options: GiteaProviderOptions): RepoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;
  const auth = options.auth;
  const webBase = new URL(baseUrl).origin;
  const mapRepository = (repo: GiteaRepo): Repository => toRepository(repo, webBase);
  const parseRepositories = (body: unknown): Repository[] =>
    (body as GiteaRepo[]).map(mapRepository);

  let lastToken: string | undefined = 'token' in auth ? auth.token : undefined;
  async function currentToken(forceRefresh: boolean): Promise<string> {
    if ('token' in auth) return auth.token;
    lastToken = await auth.tokenProvider({ forceRefresh });
    return lastToken;
  }

  const http = new HttpClient({
    provider: 'gitea',
    baseUrl,
    fetchImpl,
    // Gitea requires the literal `token` scheme for personal access tokens,
    // while `Bearer` is for OAuth2-issued tokens — which is what a
    // tokenProvider mints.
    authHeaders: async ({ forceRefresh }) => ({
      Authorization:
        'token' in auth ? `token ${auth.token}` : `Bearer ${await currentToken(forceRefresh)}`,
    }),
    mapError,
    secrets: () => (lastToken === undefined ? [] : [lastToken]),
    retryUnauthorized: 'tokenProvider' in auth,
  });

  let cachedUid: number | undefined;
  async function getUid(signal?: AbortSignal): Promise<number> {
    if (cachedUid === undefined) {
      const { data } = await http.json('/user', (body) => (body as GiteaUser).id, { signal });
      cachedUid = data;
    }
    return cachedUid;
  }

  // Orgs are users internally, so both resolve to ids in the same space —
  // usable as the `uid` owner filter of `/repos/search`.
  async function resolveNamespaceId(namespace: string, signal?: AbortSignal): Promise<number> {
    try {
      const { data } = await http.json(
        `/orgs/${encodeURIComponent(namespace)}`,
        (body) => (body as GiteaOrg).id,
        { signal },
      );
      return data;
    } catch (error) {
      if (!(error instanceof RepoError && error.code === 'not_found')) throw error;
    }
    const { data } = await http.json(
      `/users/${encodeURIComponent(namespace)}`,
      (body) => (body as GiteaUser).id,
      { signal },
    );
    return data;
  }

  function repoPath(repo: string): string {
    return `/repos/${repo}`;
  }

  async function getCloneCredentials(params: GetCloneCredentialsParams): Promise<CloneCredentials> {
    const host = new URL(baseUrl).host;
    // Gitea accepts the access token as the basic-auth username with no password.
    return {
      password: null,
      url: `https://${host}/${params.repo}.git`,
      username: await currentToken(false),
    };
  }

  return {
    name: 'gitea',
    capabilities: CAPABILITIES,

    async getAuthenticatedUser(params: GetAuthenticatedUserParams): Promise<AuthenticatedUser> {
      const { data } = await http.json(
        '/user',
        (body) => {
          const user = body as GiteaUser;
          return {
            id: String(user.id),
            username: user.login ?? user.username ?? '',
            name: user.full_name ? user.full_name : undefined,
            email: user.email,
            avatarUrl: user.avatar_url,
            raw: user,
          };
        },
        { signal: params.signal },
      );
      return data;
    },

    async listNamespaces(params: ListNamespacesParams): Promise<Page<Namespace>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => orgsFromBody(body).map(toOrgNamespace),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }
      const { data: user } = await http.json(
        '/user',
        (body) => toUserNamespace(body as GiteaUser),
        { signal: params.signal },
      );
      const { data: orgs, response } = await http.json(
        '/user/orgs',
        (body) => orgsFromBody(body).map(toOrgNamespace),
        { query: { limit: clampPerPage(params.limit) }, signal: params.signal },
      );
      return {
        data: [user, ...orgs],
        cursor: nextCursor(response),
      };
    },

    async listRepositories(params: ListRepositoriesParams): Promise<Page<Repository>> {
      const perPage = clampPerPage(params.limit);

      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => reposFromBody(body).map(mapRepository),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }

      if (params.query !== undefined || params.owned) {
        const uid = params.namespace
          ? await resolveNamespaceId(params.namespace, params.signal)
          : params.owned
            ? await getUid(params.signal)
            : undefined;
        const { data, response } = await http.json(
          '/repos/search',
          (body) => ((body as { data?: GiteaRepo[] }).data ?? []).map(mapRepository),
          {
            query: {
              q: params.query,
              uid,
              exclusive: uid !== undefined ? true : undefined,
              limit: perPage,
            },
            signal: params.signal,
          },
        );
        return { data, cursor: nextCursor(response) };
      }

      if (params.namespace) {
        try {
          const { data, response } = await http.json(
            `/orgs/${encodeURIComponent(params.namespace)}/repos`,
            parseRepositories,
            { query: { limit: perPage }, signal: params.signal },
          );
          return { data, cursor: nextCursor(response) };
        } catch (error) {
          if (!(error instanceof RepoError && error.code === 'not_found')) throw error;
        }
        const { data, response } = await http.json(
          `/users/${encodeURIComponent(params.namespace)}/repos`,
          parseRepositories,
          { query: { limit: perPage }, signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }

      const { data, response } = await http.json('/user/repos', parseRepositories, {
        query: { limit: perPage },
        signal: params.signal,
      });
      return { data, cursor: nextCursor(response) };
    },

    async getRepository(params: GetRepositoryParams): Promise<Repository> {
      const { data } = await http.json(
        repoPath(params.repo),
        (body) => mapRepository(body as GiteaRepo),
        { signal: params.signal },
      );
      return data;
    },

    async listCommits(params: ListCommitsParams): Promise<Page<Commit>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => filterByAuthor(body as GiteaCommit[], params.author).map(toCommit),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }
      const { data, response } = await http.json(
        `${repoPath(params.repo)}/commits`,
        (body) => filterByAuthor(body as GiteaCommit[], params.author).map(toCommit),
        {
          query: {
            sha: params.ref,
            path: params.path,
            since: params.since?.toISOString(),
            until: params.until?.toISOString(),
            limit: clampPerPage(params.limit),
            // Skip diff stats, affected files and GPG verification — all
            // default to true and make large pages needlessly expensive.
            stat: false,
            verification: false,
            files: false,
          },
          signal: params.signal,
        },
      );
      return { data, cursor: nextCursor(response) };
    },

    async getCommit(params: GetCommitParams): Promise<Commit> {
      const { data } = await http.json(
        `${repoPath(params.repo)}/git/commits/${encodeURIComponent(params.ref)}`,
        (body) => toCommit(body as GiteaCommit),
        { signal: params.signal },
      );
      return data;
    },

    async listTags(params: ListTagsParams): Promise<Page<Tag>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json(url, (body) => (body as GiteaTag[]).map(toTag), {
          signal: params.signal,
        });
        return { data, cursor: nextCursor(response) };
      }
      const { data, response } = await http.json(
        `${repoPath(params.repo)}/tags`,
        (body) => (body as GiteaTag[]).map(toTag),
        { query: { limit: clampPerPage(params.limit) }, signal: params.signal },
      );
      return { data, cursor: nextCursor(response) };
    },

    async listBranches(params: ListBranchesParams): Promise<Page<Branch>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => (body as GiteaBranch[]).map(toBranch),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }
      const { data, response } = await http.json(
        `${repoPath(params.repo)}/branches`,
        (body) => (body as GiteaBranch[]).map(toBranch),
        {
          query: { limit: clampPerPage(params.limit) },
          signal: params.signal,
        },
      );
      return { data, cursor: nextCursor(response) };
    },

    async getBranch(params: GetBranchParams): Promise<Branch> {
      const { data } = await http.json(
        `${repoPath(params.repo)}/branches/${encodeRefPath(params.name)}`,
        (body) => toBranch(body as GiteaBranch),
        { signal: params.signal },
      );
      return data;
    },

    async getTag(params: GetTagParams): Promise<Tag> {
      const { data } = await http.json(
        `${repoPath(params.repo)}/tags/${encodeRefPath(params.name)}`,
        (body) => toTag(body as GiteaTag),
        { signal: params.signal },
      );
      return data;
    },

    async searchRefs(params: ProviderSearchRefsParams): Promise<ProviderRefMatch[]> {
      const namespaces = { branch: 'heads', tag: 'tags' } as const;
      // Gitea's ref endpoint prefix-matches (case-sensitive) and is unpaginated;
      // truncate to `limit` client-side.
      const matches = await Promise.all(
        (['branch', 'tag'] as const)
          .filter((type) => params.types.includes(type))
          .map(async (type) => {
            const prefix = `refs/${namespaces[type]}/`;
            let refs: GiteaRef[];
            try {
              const { data } = await http.json(
                `${repoPath(params.repo)}/git/refs/${namespaces[type]}/${encodeRefPath(params.query)}`,
                // A single exact match is returned as one object rather than an array.
                (body) => {
                  const found = body as GiteaRef | GiteaRef[];
                  return Array.isArray(found) ? found : [found];
                },
                { signal: params.signal },
              );
              refs = data;
            } catch (error) {
              // Zero matches surface as a 404; normalize to an empty result.
              if (error instanceof RepoError && error.code === 'not_found') return [];
              throw error;
            }
            return refs.map((ref): ProviderRefMatch => ({
              type,
              name: ref.ref.slice(prefix.length),
              sha: ref.object.sha,
              raw: ref,
            }));
          }),
      );
      return matches.flat().slice(0, params.limit);
    },

    async downloadArchive(params: DownloadArchiveParams): Promise<Archive> {
      const format = params.format ?? 'zip';
      const extension = format === 'zip' ? 'zip' : 'tar.gz';
      // Refs may contain slashes (feature/foo); encode per segment so the
      // wildcard archive route receives them literally.
      const ref = params.ref.split('/').map(encodeURIComponent).join('/');
      const response = await http.raw(`${repoPath(params.repo)}/archive/${ref}.${extension}`, {
        signal: params.signal,
      });
      if (!response.body) {
        throw new RepoError('Gitea archive response has no body', {
          code: 'provider_error',
          provider: 'gitea',
        });
      }
      return {
        stream: response.body,
        contentType: response.headers.get('content-type') ?? undefined,
        filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
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
          type: 'gitea',
          active: params.active ?? true,
          events: toGiteaEvents(params.events),
          config: {
            url: params.url,
            content_type: 'json',
            secret: params.secret,
          },
        },
        signal: params.signal,
      });
      return data;
    },

    async listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json(
          url,
          (body) => (body as GiteaHook[]).map(toWebhook),
          { signal: params.signal },
        );
        return { data, cursor: nextCursor(response) };
      }
      const { data, response } = await http.json(
        `${repoPath(params.repo)}/hooks`,
        (body) => (body as GiteaHook[]).map(toWebhook),
        { query: { limit: clampPerPage(params.limit) }, signal: params.signal },
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
      // Gitea merges config keys individually on edit, so a partial config is
      // safe — the stored secret survives when the key is absent.
      const config =
        params.url !== undefined || params.secret !== undefined
          ? { url: params.url, secret: params.secret }
          : undefined;
      const { data } = await http.json(
        `${repoPath(params.repo)}/hooks/${params.id}`,
        parseWebhook,
        {
          method: 'PATCH',
          body: {
            active: params.active,
            events: params.events ? toGiteaEvents(params.events) : undefined,
            config,
          },
          signal: params.signal,
        },
      );
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

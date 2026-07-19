import { RepoError, type RepoErrorCode } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { assertSameOriginUrl, decodeCursor, encodeCursor } from '../../pagination.ts';
import {
  clampPerPage,
  commitWebUrlBuilder,
  filenameFromContentDisposition,
  isRecord,
} from '../shared.ts';
import type {
  Archive,
  AuthenticatedUser,
  Branch,
  CloneUrl,
  Commit,
  CreateWebhookParams,
  DeleteWebhookParams,
  DownloadArchiveParams,
  GetAuthenticatedUserParams,
  GetCloneUrlParams,
  GetCommitParams,
  GetRepositoryParams,
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
  RefMatch,
  Repository,
  Tag,
  UpdateWebhookParams,
  RepoCapabilities,
  RepoProvider,
  Webhook,
  WebhookEventType,
} from '../../types.ts';

const BASE_URL = 'https://api.bitbucket.org/2.0';
const GIT_HOST = 'bitbucket.org';
const HOOK_DESCRIPTION = 'repo-sdk';

export interface BitbucketProviderOptions {
  auth: { email: string; apiToken: string } | { accessToken: string };
  fetch?: typeof fetch;
}

const CAPABILITIES: RepoCapabilities = {
  userProfile: true,
  tagDates: true,
  repoSearch: true,
  ownedRepoFilter: true,
  commitUserRef: true,
  refSearch: true,
  webhookEvents: ['push', 'tag_push'],
  webhookVerification: 'hmac-sha256',
  archiveFormats: ['zip', 'tar.gz'],
};

interface BitbucketList<T> {
  values?: T[];
  next?: string;
}

interface BitbucketUser {
  uuid: string;
  username?: string;
  nickname?: string;
  display_name?: string;
  links?: { avatar?: { href?: string } };
}

interface BitbucketWorkspace {
  uuid: string;
  slug: string;
  name: string;
  links?: { avatar?: { href?: string } };
}

interface BitbucketCloneLink {
  name?: string;
  href?: string;
}

interface BitbucketRepo {
  uuid: string;
  name: string;
  full_name: string;
  is_private: boolean;
  mainbranch?: { name?: string };
  workspace?: { slug?: string };
  links?: {
    html?: { href?: string };
    clone?: BitbucketCloneLink[];
  };
}

interface BitbucketAuthor {
  raw?: string;
  user?: {
    display_name?: string;
    nickname?: string;
    account_id?: string;
    uuid?: string;
    links?: { avatar?: { href?: string } };
  };
}

interface BitbucketCommit {
  hash: string;
  message?: string;
  date?: string;
  author?: BitbucketAuthor;
  parents?: { hash: string }[];
  links?: { html?: { href?: string } };
}

interface BitbucketTag {
  name: string;
  message?: string;
  date?: string;
  tagger?: unknown;
  target: { hash: string; date?: string };
}

interface BitbucketBranch {
  name: string;
  target: { hash: string };
}

interface BitbucketHook {
  uuid: string;
  url?: string;
  description?: string;
  active: boolean;
  events?: string[];
}

function isApiTokenAuth(
  auth: BitbucketProviderOptions['auth'],
): auth is { email: string; apiToken: string } {
  return 'apiToken' in auth;
}

function nextCursor(body: BitbucketList<unknown>): string | undefined {
  return body.next === undefined ? undefined : encodeCursor('bitbucket', { url: body.next });
}

function bbqlNameQuery(text: string): string {
  return `name ~ "${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function toNamespace(workspace: BitbucketWorkspace): Namespace {
  return {
    id: workspace.uuid,
    slug: workspace.slug,
    name: workspace.name,
    kind: 'workspace',
    avatarUrl: workspace.links?.avatar?.href,
    raw: workspace,
  };
}

function toRepository(repo: BitbucketRepo): Repository {
  const clone = repo.links?.clone ?? [];
  return {
    id: repo.uuid,
    name: repo.name,
    path: repo.full_name,
    namespace: repo.workspace?.slug ?? '',
    defaultBranch: repo.mainbranch?.name,
    private: repo.is_private,
    urls: {
      web: repo.links?.html?.href ?? `https://bitbucket.org/${repo.full_name}`,
      cloneHttp: clone.find((link) => link.name === 'https')?.href,
      cloneSsh: clone.find((link) => link.name === 'ssh')?.href,
    },
    raw: repo,
  };
}

function toActor(author: BitbucketAuthor | undefined, date: string | undefined): GitActor {
  const raw = author?.raw ?? '';
  const match = raw.match(/^\s*(.*?)\s*<([^>]*)>\s*$/);
  const parsedName = match ? match[1]! : raw;
  const email = match ? match[2] : undefined;
  const account = author?.user;
  const accountId = account?.account_id ?? account?.uuid;
  return {
    name: account?.display_name ?? parsedName,
    email,
    date: new Date(date ?? 0),
    user:
      account && accountId
        ? {
            id: accountId,
            username: account.nickname ?? account.display_name ?? '',
            avatarUrl: account.links?.avatar?.href,
          }
        : undefined,
  };
}

function toCommit(commit: BitbucketCommit): Commit {
  return {
    sha: commit.hash,
    message: commit.message ?? '',
    author: toActor(commit.author, commit.date),
    parents: commit.parents?.map((parent) => parent.hash) ?? [],
    url: commit.links?.html?.href,
    raw: commit,
  };
}

function toTag(tag: BitbucketTag): Tag {
  return {
    name: tag.name,
    sha: tag.target.hash,
    message: tag.message ?? undefined,
    isAnnotated: tag.tagger != null,
    date: new Date(tag.date ?? tag.target.date ?? 0),
    raw: tag,
  };
}

function toBranch(branch: BitbucketBranch): Branch {
  return { name: branch.name, sha: branch.target.hash, raw: branch };
}

function toBitbucketEvents(events: WebhookEventType[]): string[] {
  const result = new Set<string>();
  for (const event of events) {
    if (event === 'push' || event === 'tag_push') result.add('repo:push');
  }
  return [...result];
}

function fromBitbucketEvents(events: string[]): WebhookEventType[] {
  const result = new Set<WebhookEventType>();
  for (const event of events) {
    if (event === 'repo:push') {
      result.add('push');
      result.add('tag_push');
    }
  }
  return [...result];
}

function toWebhook(hook: BitbucketHook): Webhook {
  return {
    id: hook.uuid,
    url: hook.url ?? '',
    events: fromBitbucketEvents(hook.events ?? []),
    active: hook.active,
    raw: hook,
  };
}

function mapError(status: number, body: unknown): ProviderErrorInfo {
  let message: string | undefined;
  if (
    isRecord(body) &&
    body.type === 'error' &&
    isRecord(body.error) &&
    typeof body.error.message === 'string'
  ) {
    message = body.error.message;
  }
  const code: RepoErrorCode | undefined = undefined;
  return { code, message };
}

/**
 * Builds the human-facing web URL for a commit from the repository's web URL
 * (`Repository.urls.web`) and a commit SHA — no API request needed.
 */
export const commitWebUrl = commitWebUrlBuilder('commits');

export function bitbucket(options: BitbucketProviderOptions): RepoProvider {
  const { auth } = options;
  const fetchImpl = options.fetch ?? fetch;
  const usesApiToken = isApiTokenAuth(auth);
  const authorization = usesApiToken
    ? `Basic ${btoa(`${auth.email}:${auth.apiToken}`)}`
    : `Bearer ${auth.accessToken}`;
  const secret = usesApiToken ? auth.apiToken : auth.accessToken;

  const http = new HttpClient({
    provider: 'bitbucket',
    baseUrl: BASE_URL,
    fetchImpl,
    authHeaders: () => ({
      Authorization: authorization,
      Accept: 'application/json',
    }),
    mapError,
    secrets: () => [secret],
  });

  function repoPath(repo: string): string {
    return `/repositories/${repo}`;
  }

  function hookPath(repo: string, id: string): string {
    return `${repoPath(repo)}/hooks/${encodeURIComponent(id)}`;
  }

  return {
    name: 'bitbucket',
    capabilities: CAPABILITIES,

    // `email` stays unset: Bitbucket exposes it only via /user/emails with an extra scope.
    async getAuthenticatedUser(params: GetAuthenticatedUserParams): Promise<AuthenticatedUser> {
      const { data } = await http.json<BitbucketUser>('/user', { signal: params.signal });
      return {
        id: data.uuid,
        username: data.username ?? data.nickname ?? '',
        name: data.display_name,
        avatarUrl: data.links?.avatar?.href,
        raw: data,
      };
    },

    async listNamespaces(params: ListNamespacesParams): Promise<Page<Namespace>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('bitbucket', params.cursor);
        assertSameOriginUrl('bitbucket', BASE_URL, url);
        const { data } = await http.json<BitbucketList<BitbucketWorkspace>>(url, {
          signal: params.signal,
        });
        return { data: (data.values ?? []).map(toNamespace), cursor: nextCursor(data) };
      }
      const { data } = await http.json<BitbucketList<BitbucketWorkspace>>('/workspaces', {
        query: { pagelen: clampPerPage(params.limit) },
        signal: params.signal,
      });
      return { data: (data.values ?? []).map(toNamespace), cursor: nextCursor(data) };
    },

    async listRepositories(params: ListRepositoriesParams): Promise<Page<Repository>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('bitbucket', params.cursor);
        assertSameOriginUrl('bitbucket', BASE_URL, url);
        const { data } = await http.json<BitbucketList<BitbucketRepo>>(url, {
          signal: params.signal,
        });
        return { data: (data.values ?? []).map(toRepository), cursor: nextCursor(data) };
      }
      const path = params.namespace
        ? `/repositories/${encodeURIComponent(params.namespace)}`
        : '/repositories';
      const { data } = await http.json<BitbucketList<BitbucketRepo>>(path, {
        query: {
          role: params.owned ? 'owner' : 'member',
          q: params.query !== undefined ? bbqlNameQuery(params.query) : undefined,
          pagelen: clampPerPage(params.limit),
        },
        signal: params.signal,
      });
      return { data: (data.values ?? []).map(toRepository), cursor: nextCursor(data) };
    },

    async getRepository(params: GetRepositoryParams): Promise<Repository> {
      const { data } = await http.json<BitbucketRepo>(repoPath(params.repo), {
        signal: params.signal,
      });
      return toRepository(data);
    },

    async listCommits(params: ListCommitsParams): Promise<Page<Commit>> {
      let body: BitbucketList<BitbucketCommit>;
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('bitbucket', params.cursor);
        assertSameOriginUrl('bitbucket', BASE_URL, url);
        body = (await http.json<BitbucketList<BitbucketCommit>>(url, { signal: params.signal }))
          .data;
      } else {
        const path =
          params.ref === undefined
            ? `${repoPath(params.repo)}/commits`
            : `${repoPath(params.repo)}/commits/${encodeURIComponent(params.ref)}`;
        body = (
          await http.json<BitbucketList<BitbucketCommit>>(path, {
            query: { path: params.path, pagelen: clampPerPage(params.limit) },
            signal: params.signal,
          })
        ).data;
      }
      // Bitbucket has no server-side since/until/author filters — filter the returned page locally.
      const filtered = (body.values ?? []).filter((commit) => {
        if (params.since && new Date(commit.date ?? 0) < params.since) return false;
        if (params.until && new Date(commit.date ?? 0) > params.until) return false;
        if (params.author && !(commit.author?.raw ?? '').includes(params.author)) return false;
        return true;
      });
      return { data: filtered.map(toCommit), cursor: nextCursor(body) };
    },

    async getCommit(params: GetCommitParams): Promise<Commit> {
      const { data } = await http.json<BitbucketCommit>(
        `${repoPath(params.repo)}/commit/${encodeURIComponent(params.ref)}`,
        { signal: params.signal },
      );
      return toCommit(data);
    },

    async listTags(params: ListTagsParams): Promise<Page<Tag>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('bitbucket', params.cursor);
        assertSameOriginUrl('bitbucket', BASE_URL, url);
        const { data } = await http.json<BitbucketList<BitbucketTag>>(url, {
          signal: params.signal,
        });
        return { data: (data.values ?? []).map(toTag), cursor: nextCursor(data) };
      }
      const { data } = await http.json<BitbucketList<BitbucketTag>>(
        `${repoPath(params.repo)}/refs/tags`,
        {
          query: { sort: '-target.date', pagelen: clampPerPage(params.limit) },
          signal: params.signal,
        },
      );
      return { data: (data.values ?? []).map(toTag), cursor: nextCursor(data) };
    },

    async listBranches(params: ListBranchesParams): Promise<Page<Branch>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('bitbucket', params.cursor);
        assertSameOriginUrl('bitbucket', BASE_URL, url);
        const { data } = await http.json<BitbucketList<BitbucketBranch>>(url, {
          signal: params.signal,
        });
        return { data: (data.values ?? []).map(toBranch), cursor: nextCursor(data) };
      }
      const { data } = await http.json<BitbucketList<BitbucketBranch>>(
        `${repoPath(params.repo)}/refs/branches`,
        {
          query: { pagelen: clampPerPage(params.limit) },
          signal: params.signal,
        },
      );
      return { data: (data.values ?? []).map(toBranch), cursor: nextCursor(data) };
    },

    async searchRefs(params: ProviderSearchRefsParams): Promise<RefMatch[]> {
      const endpoints = { branch: 'branches', tag: 'tags' } as const;
      // Bitbucket's `~` operator is a case-insensitive CONTAINS filter with no
      // starts-with equivalent, so narrow the server-filtered first page down to
      // the prefix contract locally.
      const q = bbqlNameQuery(params.query);
      const prefix = params.query.toLowerCase();
      const matches = await Promise.all(
        (['branch', 'tag'] as const)
          .filter((type) => params.types.includes(type))
          .map(async (type) => {
            const { data } = await http.json<BitbucketList<BitbucketBranch>>(
              `${repoPath(params.repo)}/refs/${endpoints[type]}`,
              { query: { q, pagelen: params.limit }, signal: params.signal },
            );
            return (data.values ?? [])
              .filter((ref) => ref.name.toLowerCase().startsWith(prefix))
              .map((ref): RefMatch => ({ type, name: ref.name, sha: ref.target.hash, raw: ref }));
          }),
      );
      return matches.flat().slice(0, params.limit);
    },

    async downloadArchive(params: DownloadArchiveParams): Promise<Archive> {
      if (!usesApiToken) {
        throw new RepoError(
          'Bitbucket archive downloads require an API token (Basic auth); access-token/OAuth auth is not supported by the archive endpoint',
          { code: 'unsupported', provider: 'bitbucket' },
        );
      }
      const extension = (params.format ?? 'zip') === 'zip' ? 'zip' : 'tar.gz';
      const url = `https://${GIT_HOST}/${params.repo}/get/${encodeURIComponent(params.ref)}.${extension}`;
      const response = await http.raw(url, { signal: params.signal });
      if (!response.body) {
        throw new RepoError('Bitbucket archive response has no body', {
          code: 'provider_error',
          provider: 'bitbucket',
        });
      }
      return {
        stream: response.body,
        contentType: response.headers.get('content-type') ?? undefined,
        filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
      };
    },

    getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl> {
      const url = usesApiToken
        ? `https://x-bitbucket-api-token-auth:${encodeURIComponent(auth.apiToken)}@${GIT_HOST}/${params.repo}.git`
        : `https://x-token-auth:${encodeURIComponent(auth.accessToken)}@${GIT_HOST}/${params.repo}.git`;
      return Promise.resolve({ url });
    },

    async createWebhook(params: CreateWebhookParams): Promise<Webhook> {
      const { data } = await http.json<BitbucketHook>(`${repoPath(params.repo)}/hooks`, {
        method: 'POST',
        body: {
          url: params.url,
          description: HOOK_DESCRIPTION,
          active: params.active ?? true,
          events: toBitbucketEvents(params.events),
          secret: params.secret,
        },
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('bitbucket', params.cursor);
        assertSameOriginUrl('bitbucket', BASE_URL, url);
        const { data } = await http.json<BitbucketList<BitbucketHook>>(url, {
          signal: params.signal,
        });
        return { data: (data.values ?? []).map(toWebhook), cursor: nextCursor(data) };
      }
      const { data } = await http.json<BitbucketList<BitbucketHook>>(
        `${repoPath(params.repo)}/hooks`,
        {
          query: { pagelen: clampPerPage(params.limit) },
          signal: params.signal,
        },
      );
      return { data: (data.values ?? []).map(toWebhook), cursor: nextCursor(data) };
    },

    async getWebhook(params: GetWebhookParams): Promise<Webhook> {
      const { data } = await http.json<BitbucketHook>(hookPath(params.repo, params.id), {
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async updateWebhook(params: UpdateWebhookParams): Promise<Webhook> {
      // Bitbucket PUT replaces the whole subscription — hydrate missing fields from the existing hook.
      const needsExisting =
        params.url === undefined || params.events === undefined || params.active === undefined;
      const existing = needsExisting
        ? (
            await http.json<BitbucketHook>(hookPath(params.repo, params.id), {
              signal: params.signal,
            })
          ).data
        : undefined;
      const body: Record<string, unknown> = {
        url: params.url ?? existing?.url,
        description: existing?.description ?? HOOK_DESCRIPTION,
        active: params.active ?? existing?.active,
        events: params.events ? toBitbucketEvents(params.events) : (existing?.events ?? []),
      };
      if (params.secret !== undefined) body.secret = params.secret;
      const { data } = await http.json<BitbucketHook>(hookPath(params.repo, params.id), {
        method: 'PUT',
        body,
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async deleteWebhook(params: DeleteWebhookParams): Promise<void> {
      await http.raw(hookPath(params.repo, params.id), {
        method: 'DELETE',
        signal: params.signal,
      });
    },
  };
}

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
} from '../shared.ts';
import type {
  Archive,
  Branch,
  CloneUrl,
  Commit,
  CreateWebhookParams,
  DeleteWebhookParams,
  DownloadArchiveParams,
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

const DEFAULT_BASE_URL = 'https://gitea.com/api/v1';

export interface GiteaProviderOptions {
  auth: { token: string };
  /**
   * Full API base URL. Defaults to `https://gitea.com/api/v1`. For self-hosted
   * instances (including Forgejo) pass the complete base including `/api/v1`
   * (used verbatim).
   */
  baseUrl?: string;
  fetch?: typeof fetch;
}

const CAPABILITIES: RepoCapabilities = {
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

function toRepository(repo: GiteaRepo): Repository {
  return {
    id: String(repo.id),
    name: repo.name,
    path: repo.full_name,
    namespace: repo.owner?.login ?? repo.owner?.username ?? repo.full_name.split('/')[0] ?? '',
    defaultBranch: repo.default_branch,
    private: repo.private,
    archived: repo.archived,
    urls: {
      web: repo.html_url,
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
  const { token } = options.auth;

  const http = new HttpClient({
    provider: 'gitea',
    baseUrl,
    fetchImpl,
    // Gitea requires the literal `token` scheme for personal access tokens;
    // `Bearer` only works for OAuth2-issued tokens.
    authHeaders: () => ({ Authorization: `token ${token}` }),
    mapError,
    secrets: () => [token],
  });

  let cachedUid: number | undefined;
  async function getUid(signal?: AbortSignal): Promise<number> {
    if (cachedUid === undefined) {
      const { data } = await http.json<GiteaUser>('/user', { signal });
      cachedUid = data.id;
    }
    return cachedUid;
  }

  // Orgs are users internally, so both resolve to ids in the same space —
  // usable as the `uid` owner filter of `/repos/search`.
  async function resolveNamespaceId(namespace: string, signal?: AbortSignal): Promise<number> {
    try {
      const { data } = await http.json<GiteaOrg>(`/orgs/${encodeURIComponent(namespace)}`, {
        signal,
      });
      return data.id;
    } catch (error) {
      if (!(error instanceof RepoError && error.code === 'not_found')) throw error;
    }
    const { data } = await http.json<GiteaUser>(`/users/${encodeURIComponent(namespace)}`, {
      signal,
    });
    return data.id;
  }

  function repoPath(repo: string): string {
    return `/repos/${repo}`;
  }

  return {
    name: 'gitea',
    capabilities: CAPABILITIES,

    async listNamespaces(params: ListNamespacesParams): Promise<Page<Namespace>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json<GiteaOrg[]>(url, { signal: params.signal });
        return { data: data.map(toOrgNamespace), cursor: nextCursor(response) };
      }
      const { data: user } = await http.json<GiteaUser>('/user', { signal: params.signal });
      const { data: orgs, response } = await http.json<GiteaOrg[]>('/user/orgs', {
        query: { limit: clampPerPage(params.limit) },
        signal: params.signal,
      });
      return {
        data: [toUserNamespace(user), ...orgs.map(toOrgNamespace)],
        cursor: nextCursor(response),
      };
    },

    async listRepositories(params: ListRepositoriesParams): Promise<Page<Repository>> {
      const perPage = clampPerPage(params.limit);

      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json<unknown>(url, { signal: params.signal });
        return { data: reposFromBody(data).map(toRepository), cursor: nextCursor(response) };
      }

      if (params.query !== undefined || params.owned) {
        const uid = params.namespace
          ? await resolveNamespaceId(params.namespace, params.signal)
          : params.owned
            ? await getUid(params.signal)
            : undefined;
        const { data, response } = await http.json<{ data?: GiteaRepo[] }>('/repos/search', {
          query: {
            q: params.query,
            uid,
            exclusive: uid !== undefined ? true : undefined,
            limit: perPage,
          },
          signal: params.signal,
        });
        return { data: (data.data ?? []).map(toRepository), cursor: nextCursor(response) };
      }

      if (params.namespace) {
        try {
          const { data, response } = await http.json<GiteaRepo[]>(
            `/orgs/${encodeURIComponent(params.namespace)}/repos`,
            { query: { limit: perPage }, signal: params.signal },
          );
          return { data: data.map(toRepository), cursor: nextCursor(response) };
        } catch (error) {
          if (!(error instanceof RepoError && error.code === 'not_found')) throw error;
        }
        const { data, response } = await http.json<GiteaRepo[]>(
          `/users/${encodeURIComponent(params.namespace)}/repos`,
          { query: { limit: perPage }, signal: params.signal },
        );
        return { data: data.map(toRepository), cursor: nextCursor(response) };
      }

      const { data, response } = await http.json<GiteaRepo[]>('/user/repos', {
        query: { limit: perPage },
        signal: params.signal,
      });
      return { data: data.map(toRepository), cursor: nextCursor(response) };
    },

    async getRepository(params: GetRepositoryParams): Promise<Repository> {
      const { data } = await http.json<GiteaRepo>(repoPath(params.repo), {
        signal: params.signal,
      });
      return toRepository(data);
    },

    async listCommits(params: ListCommitsParams): Promise<Page<Commit>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json<GiteaCommit[]>(url, { signal: params.signal });
        return {
          data: filterByAuthor(data, params.author).map(toCommit),
          cursor: nextCursor(response),
        };
      }
      const { data, response } = await http.json<GiteaCommit[]>(
        `${repoPath(params.repo)}/commits`,
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
      return {
        data: filterByAuthor(data, params.author).map(toCommit),
        cursor: nextCursor(response),
      };
    },

    async getCommit(params: GetCommitParams): Promise<Commit> {
      const { data } = await http.json<GiteaCommit>(
        `${repoPath(params.repo)}/git/commits/${encodeURIComponent(params.ref)}`,
        { signal: params.signal },
      );
      return toCommit(data);
    },

    async listTags(params: ListTagsParams): Promise<Page<Tag>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json<GiteaTag[]>(url, { signal: params.signal });
        return { data: data.map(toTag), cursor: nextCursor(response) };
      }
      const { data, response } = await http.json<GiteaTag[]>(`${repoPath(params.repo)}/tags`, {
        query: { limit: clampPerPage(params.limit) },
        signal: params.signal,
      });
      return { data: data.map(toTag), cursor: nextCursor(response) };
    },

    async listBranches(params: ListBranchesParams): Promise<Page<Branch>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json<GiteaBranch[]>(url, { signal: params.signal });
        return { data: data.map(toBranch), cursor: nextCursor(response) };
      }
      const { data, response } = await http.json<GiteaBranch[]>(
        `${repoPath(params.repo)}/branches`,
        {
          query: { limit: clampPerPage(params.limit) },
          signal: params.signal,
        },
      );
      return { data: data.map(toBranch), cursor: nextCursor(response) };
    },

    async searchRefs(params: ProviderSearchRefsParams): Promise<RefMatch[]> {
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
              const { data } = await http.json<GiteaRef | GiteaRef[]>(
                `${repoPath(params.repo)}/git/refs/${namespaces[type]}/${encodeRefPath(params.query)}`,
                { signal: params.signal },
              );
              // A single exact match is returned as one object rather than an array.
              refs = Array.isArray(data) ? data : [data];
            } catch (error) {
              // Zero matches surface as a 404; normalize to an empty result.
              if (error instanceof RepoError && error.code === 'not_found') return [];
              throw error;
            }
            return refs.map((ref): RefMatch => ({
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

    getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl> {
      const host = new URL(baseUrl).host;
      // Gitea accepts the access token as the basic-auth username with no password.
      return Promise.resolve({
        url: `https://${encodeURIComponent(token)}@${host}/${params.repo}.git`,
      });
    },

    async createWebhook(params: CreateWebhookParams): Promise<Webhook> {
      const { data } = await http.json<GiteaHook>(`${repoPath(params.repo)}/hooks`, {
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
      return toWebhook(data);
    },

    async listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>> {
      if (params.cursor) {
        const { url } = decodeCursor<{ url: string }>('gitea', params.cursor);
        assertSameOriginUrl('gitea', baseUrl, url);
        const { data, response } = await http.json<GiteaHook[]>(url, { signal: params.signal });
        return { data: data.map(toWebhook), cursor: nextCursor(response) };
      }
      const { data, response } = await http.json<GiteaHook[]>(`${repoPath(params.repo)}/hooks`, {
        query: { limit: clampPerPage(params.limit) },
        signal: params.signal,
      });
      return { data: data.map(toWebhook), cursor: nextCursor(response) };
    },

    async getWebhook(params: GetWebhookParams): Promise<Webhook> {
      const { data } = await http.json<GiteaHook>(`${repoPath(params.repo)}/hooks/${params.id}`, {
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async updateWebhook(params: UpdateWebhookParams): Promise<Webhook> {
      // Gitea merges config keys individually on edit, so a partial config is
      // safe — the stored secret survives when the key is absent.
      const config =
        params.url !== undefined || params.secret !== undefined
          ? { url: params.url, secret: params.secret }
          : undefined;
      const { data } = await http.json<GiteaHook>(`${repoPath(params.repo)}/hooks/${params.id}`, {
        method: 'PATCH',
        body: {
          active: params.active,
          events: params.events ? toGiteaEvents(params.events) : undefined,
          config,
        },
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async deleteWebhook(params: DeleteWebhookParams): Promise<void> {
      await http.raw(`${repoPath(params.repo)}/hooks/${params.id}`, {
        method: 'DELETE',
        signal: params.signal,
      });
    },
  };
}

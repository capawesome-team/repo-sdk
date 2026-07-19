import { RepoError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo, type QueryValue } from '../../http.ts';
import { assertSameOriginUrl, decodeCursor, encodeCursor } from '../../pagination.ts';
import {
  clampPerPage,
  commitWebUrlBuilder,
  filenameFromContentDisposition,
  isRecord,
  parseLinkNext,
} from '../shared.ts';
import type {
  Archive,
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
  ListCommitsParams,
  ListNamespacesParams,
  ListRepositoriesParams,
  ListTagsParams,
  ListWebhooksParams,
  Namespace,
  Page,
  Repository,
  Tag,
  UpdateWebhookParams,
  RepoCapabilities,
  RepoProvider,
  Webhook,
  WebhookEventType,
} from '../../types.ts';

const DEFAULT_BASE_URL = 'https://gitlab.com/api/v4';

export interface GitLabProviderOptions {
  auth: { token: string };
  /**
   * Full API base URL. Defaults to `https://gitlab.com/api/v4`. For self-managed
   * instances pass the complete base including `/api/v4` (used verbatim).
   */
  baseUrl?: string;
  fetch?: typeof fetch;
}

const CAPABILITIES: RepoCapabilities = {
  tagDates: true,
  repoSearch: true,
  ownedRepoFilter: true,
  webhookEvents: ['push', 'tag_push', 'release'],
  webhookVerification: 'shared-token',
  archiveFormats: ['zip', 'tar.gz'],
};

interface TokenSource {
  getToken(): Promise<string>;
  getSecrets(): string[];
}

function createTokenSource(auth: { token: string }): TokenSource {
  const { token } = auth;
  return {
    getToken: () => Promise.resolve(token),
    getSecrets: () => [token],
  };
}

interface GitLabUser {
  id: number;
  username: string;
  name?: string;
}

interface GitLabGroup {
  id: number;
  name: string;
  full_path: string;
  parent_id?: number | null;
}

interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  namespace: { full_path: string };
  default_branch?: string;
  visibility?: string;
  archived?: boolean;
  web_url?: string;
  http_url_to_repo: string;
  ssh_url_to_repo?: string;
}

interface GitLabCommit {
  id: string;
  message?: string;
  author_name?: string;
  author_email?: string;
  authored_date?: string;
  committer_name?: string;
  committer_email?: string;
  committed_date?: string;
  parent_ids?: string[];
  web_url?: string;
}

interface GitLabTag {
  name: string;
  message?: string | null;
  target?: string;
  created_at?: string | null;
  commit?: { id: string; committed_date?: string };
}

interface GitLabHook {
  id: number;
  url: string;
  push_events?: boolean;
  tag_push_events?: boolean;
  releases_events?: boolean;
}

/**
 * Cursor for the next page: prefer the absolute `Link: rel="next"` URL; when the
 * endpoint omits the Link header, fall back to the `x-next-page` header by
 * replacing the `page` query param on the current request URL.
 */
function nextCursor(requestUrl: string, response: Response): string | undefined {
  const link = parseLinkNext(response.headers.get('link'));
  if (link) return encodeCursor('gitlab', { url: link });
  const nextPage = response.headers.get('x-next-page');
  if (nextPage) {
    const url = new URL(requestUrl);
    url.searchParams.set('page', nextPage);
    return encodeCursor('gitlab', { url: url.toString() });
  }
  return undefined;
}

/** Numeric ids pass through; paths are URL-encoded whole (subgroup slashes → %2F). */
function projectId(repo: string): string {
  return /^\d+$/.test(repo) ? repo : encodeURIComponent(repo);
}

function isNumericId(repo: string): boolean {
  return /^\d+$/.test(repo);
}

function toUserNamespace(user: GitLabUser): Namespace {
  return {
    id: String(user.id),
    slug: user.username,
    name: user.name ?? user.username,
    kind: 'user',
    raw: user,
  };
}

function toGroupNamespace(group: GitLabGroup): Namespace {
  return {
    id: String(group.id),
    slug: group.full_path,
    name: group.name,
    kind: 'group',
    parent: group.parent_id != null ? group.full_path.split('/').slice(0, -1).join('/') : undefined,
    raw: group,
  };
}

function toRepository(project: GitLabProject): Repository {
  return {
    id: String(project.id),
    name: project.name,
    path: project.path_with_namespace,
    namespace: project.namespace.full_path,
    defaultBranch: project.default_branch,
    private: project.visibility !== 'public',
    archived: project.archived,
    urls: {
      web: project.web_url,
      cloneHttp: project.http_url_to_repo,
      cloneSsh: project.ssh_url_to_repo,
    },
    raw: project,
  };
}

function toActor(
  name: string | undefined,
  email: string | undefined,
  date: string | undefined,
): GitActor {
  return {
    name: name ?? '',
    email: email ?? undefined,
    date: date ? new Date(date) : new Date(0),
  };
}

function toCommit(commit: GitLabCommit): Commit {
  const hasCommitter = commit.committer_name != null || commit.committed_date != null;
  return {
    sha: commit.id,
    message: commit.message ?? '',
    author: toActor(commit.author_name, commit.author_email, commit.authored_date),
    committer: hasCommitter
      ? toActor(commit.committer_name, commit.committer_email, commit.committed_date)
      : undefined,
    parents: commit.parent_ids ?? [],
    url: commit.web_url,
    raw: commit,
  };
}

function toTag(tag: GitLabTag): Tag {
  const dateSource = tag.commit?.committed_date ?? tag.created_at ?? undefined;
  return {
    name: tag.name,
    sha: tag.commit?.id ?? tag.target ?? '',
    message: tag.message ?? undefined,
    isAnnotated: tag.message != null,
    date: dateSource ? new Date(dateSource) : undefined,
    raw: tag,
  };
}

function eventsFromHook(hook: GitLabHook): WebhookEventType[] {
  const events: WebhookEventType[] = [];
  if (hook.push_events) events.push('push');
  if (hook.tag_push_events) events.push('tag_push');
  if (hook.releases_events) events.push('release');
  return events;
}

function toWebhook(hook: GitLabHook): Webhook {
  return {
    id: String(hook.id),
    url: hook.url,
    events: eventsFromHook(hook),
    // GitLab project hooks have no enabled/active flag; a stored hook is always active.
    active: true,
    raw: hook,
  };
}

/**
 * GitLab's project hooks API has no field to create or set a hook as inactive
 * (hooks are always active; GitLab only auto-disables them after repeated
 * delivery failures). Reject an explicit `active: false` rather than silently
 * ignoring it.
 */
function assertActiveSupported(active: boolean | undefined): void {
  if (active === false) {
    throw new RepoError(
      'GitLab does not support creating or setting webhooks as inactive via the API',
      { code: 'unsupported', provider: 'gitlab' },
    );
  }
}

function injectCredentials(cloneUrl: string, token: string): string {
  return cloneUrl.replace('://', `://oauth2:${encodeURIComponent(token)}@`);
}

function gitHostFromBaseUrl(baseUrl: string): string {
  return new URL(baseUrl).host;
}

function stringifyMessageObject(obj: Record<string, unknown>): string {
  return Object.values(obj)
    .map((value) => (Array.isArray(value) ? value.join(', ') : String(value)))
    .join('; ');
}

function mapError(_status: number, body: unknown): ProviderErrorInfo {
  let message: string | undefined;
  if (isRecord(body)) {
    if (typeof body.message === 'string') message = body.message;
    else if (isRecord(body.message)) message = stringifyMessageObject(body.message);
    else if (typeof body.error === 'string') message = body.error;
  }
  // Status→code mapping (429/retry-after etc.) is handled by the core HTTP layer.
  return { message };
}

/**
 * Builds the human-facing web URL for a commit from the repository's web URL
 * (`Repository.urls.web`) and a commit SHA — no API request needed.
 */
export const commitWebUrl = commitWebUrlBuilder('-/commit');

export function gitlab(options: GitLabProviderOptions): RepoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;
  const tokenSource = createTokenSource(options.auth);

  const http = new HttpClient({
    provider: 'gitlab',
    baseUrl,
    fetchImpl,
    authHeaders: async () => {
      const token = await tokenSource.getToken();
      return { Authorization: `Bearer ${token}` };
    },
    mapError,
    secrets: tokenSource.getSecrets,
  });

  const reqUrl = (path: string, query?: Record<string, QueryValue>): string =>
    http.buildUrl(path, query).toString();

  function hooksPath(repo: string): string {
    return `/projects/${projectId(repo)}/hooks`;
  }

  return {
    name: 'gitlab',
    capabilities: CAPABILITIES,

    async listNamespaces(params: ListNamespacesParams): Promise<Page<Namespace>> {
      if (params.cursor) {
        const decoded = decodeCursor<{ url: string }>('gitlab', params.cursor);
        const url = assertSameOriginUrl('gitlab', baseUrl, decoded.url);
        const { data, response } = await http.json<GitLabGroup[]>(url, { signal: params.signal });
        return { data: data.map(toGroupNamespace), cursor: nextCursor(url, response) };
      }
      const { data: user } = await http.json<GitLabUser>('/user', { signal: params.signal });
      const query = { per_page: clampPerPage(params.limit) };
      const { data: groups, response } = await http.json<GitLabGroup[]>('/groups', {
        query,
        signal: params.signal,
      });
      return {
        data: [toUserNamespace(user), ...groups.map(toGroupNamespace)],
        cursor: nextCursor(reqUrl('/groups', query), response),
      };
    },

    async listRepositories(params: ListRepositoriesParams): Promise<Page<Repository>> {
      const perPage = clampPerPage(params.limit);

      if (params.cursor) {
        const decoded = decodeCursor<{ url: string }>('gitlab', params.cursor);
        const url = assertSameOriginUrl('gitlab', baseUrl, decoded.url);
        const { data, response } = await http.json<GitLabProject[]>(url, { signal: params.signal });
        return { data: data.map(toRepository), cursor: nextCursor(url, response) };
      }

      if (params.namespace) {
        const groupPath = `/groups/${encodeURIComponent(params.namespace)}/projects`;
        const groupQuery = {
          include_subgroups: true,
          per_page: perPage,
          search: params.query,
          owned: params.owned ? true : undefined,
        };
        try {
          const { data, response } = await http.json<GitLabProject[]>(groupPath, {
            query: groupQuery,
            signal: params.signal,
          });
          return {
            data: data.map(toRepository),
            cursor: nextCursor(reqUrl(groupPath, groupQuery), response),
          };
        } catch (error) {
          if (!(error instanceof RepoError && error.code === 'not_found')) throw error;
        }
        const userPath = `/users/${encodeURIComponent(params.namespace)}/projects`;
        const userQuery = { per_page: perPage, search: params.query };
        const { data, response } = await http.json<GitLabProject[]>(userPath, {
          query: userQuery,
          signal: params.signal,
        });
        return {
          data: data.map(toRepository),
          cursor: nextCursor(reqUrl(userPath, userQuery), response),
        };
      }

      const query = {
        membership: true,
        owned: params.owned ? true : undefined,
        search: params.query,
        per_page: perPage,
      };
      const { data, response } = await http.json<GitLabProject[]>('/projects', {
        query,
        signal: params.signal,
      });
      return {
        data: data.map(toRepository),
        cursor: nextCursor(reqUrl('/projects', query), response),
      };
    },

    async getRepository(params: GetRepositoryParams): Promise<Repository> {
      const { data } = await http.json<GitLabProject>(`/projects/${projectId(params.repo)}`, {
        signal: params.signal,
      });
      return toRepository(data);
    },

    async listCommits(params: ListCommitsParams): Promise<Page<Commit>> {
      if (params.cursor) {
        const decoded = decodeCursor<{ url: string }>('gitlab', params.cursor);
        const url = assertSameOriginUrl('gitlab', baseUrl, decoded.url);
        const { data, response } = await http.json<GitLabCommit[]>(url, { signal: params.signal });
        return { data: data.map(toCommit), cursor: nextCursor(url, response) };
      }
      const path = `/projects/${projectId(params.repo)}/repository/commits`;
      const query = {
        ref_name: params.ref,
        since: params.since?.toISOString(),
        until: params.until?.toISOString(),
        path: params.path,
        author: params.author,
        per_page: clampPerPage(params.limit),
      };
      const { data, response } = await http.json<GitLabCommit[]>(path, {
        query,
        signal: params.signal,
      });
      return { data: data.map(toCommit), cursor: nextCursor(reqUrl(path, query), response) };
    },

    async getCommit(params: GetCommitParams): Promise<Commit> {
      const { data } = await http.json<GitLabCommit>(
        `/projects/${projectId(params.repo)}/repository/commits/${encodeURIComponent(params.ref)}`,
        { signal: params.signal },
      );
      return toCommit(data);
    },

    async listTags(params: ListTagsParams): Promise<Page<Tag>> {
      if (params.cursor) {
        const decoded = decodeCursor<{ url: string }>('gitlab', params.cursor);
        const url = assertSameOriginUrl('gitlab', baseUrl, decoded.url);
        const { data, response } = await http.json<GitLabTag[]>(url, { signal: params.signal });
        return { data: data.map(toTag), cursor: nextCursor(url, response) };
      }
      const path = `/projects/${projectId(params.repo)}/repository/tags`;
      const query = { per_page: clampPerPage(params.limit) };
      const { data, response } = await http.json<GitLabTag[]>(path, {
        query,
        signal: params.signal,
      });
      return { data: data.map(toTag), cursor: nextCursor(reqUrl(path, query), response) };
    },

    async downloadArchive(params: DownloadArchiveParams): Promise<Archive> {
      const format = params.format ?? 'zip';
      const extension = format === 'zip' ? 'zip' : 'tar.gz';
      const response = await http.raw(
        `/projects/${projectId(params.repo)}/repository/archive.${extension}`,
        { query: { sha: params.ref }, signal: params.signal },
      );
      if (!response.body) {
        throw new RepoError('GitLab archive response has no body', {
          code: 'provider_error',
          provider: 'gitlab',
        });
      }
      return {
        stream: response.body,
        contentType: response.headers.get('content-type') ?? undefined,
        filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
      };
    },

    async getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl> {
      const token = await tokenSource.getToken();
      if (isNumericId(params.repo)) {
        const { data } = await http.json<GitLabProject>(`/projects/${params.repo}`, {
          signal: params.signal,
        });
        return { url: injectCredentials(data.http_url_to_repo, token) };
      }
      const host = gitHostFromBaseUrl(baseUrl);
      return { url: `https://oauth2:${encodeURIComponent(token)}@${host}/${params.repo}.git` };
    },

    async createWebhook(params: CreateWebhookParams): Promise<Webhook> {
      assertActiveSupported(params.active);
      const { data } = await http.json<GitLabHook>(hooksPath(params.repo), {
        method: 'POST',
        body: {
          url: params.url,
          token: params.secret,
          enable_ssl_verification: true,
          // Set every flag explicitly: GitLab defaults push_events to true, so
          // unrequested events must be sent as false rather than left unset.
          push_events: params.events.includes('push'),
          tag_push_events: params.events.includes('tag_push'),
          releases_events: params.events.includes('release'),
        },
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>> {
      if (params.cursor) {
        const decoded = decodeCursor<{ url: string }>('gitlab', params.cursor);
        const url = assertSameOriginUrl('gitlab', baseUrl, decoded.url);
        const { data, response } = await http.json<GitLabHook[]>(url, { signal: params.signal });
        return { data: data.map(toWebhook), cursor: nextCursor(url, response) };
      }
      const path = hooksPath(params.repo);
      const query = { per_page: clampPerPage(params.limit) };
      const { data, response } = await http.json<GitLabHook[]>(path, {
        query,
        signal: params.signal,
      });
      return { data: data.map(toWebhook), cursor: nextCursor(reqUrl(path, query), response) };
    },

    async getWebhook(params: GetWebhookParams): Promise<Webhook> {
      const { data } = await http.json<GitLabHook>(`${hooksPath(params.repo)}/${params.id}`, {
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async updateWebhook(params: UpdateWebhookParams): Promise<Webhook> {
      assertActiveSupported(params.active);
      const path = `${hooksPath(params.repo)}/${params.id}`;
      // PUT requires `url`; when the caller omits url or events, read the existing
      // hook and merge so unspecified fields are preserved.
      const existing =
        params.url === undefined || params.events === undefined
          ? (await http.json<GitLabHook>(path, { signal: params.signal })).data
          : undefined;
      const events = params.events;
      const body: Record<string, unknown> = {
        url: params.url ?? existing?.url,
        enable_ssl_verification: true,
        push_events: events ? events.includes('push') : (existing?.push_events ?? false),
        tag_push_events: events
          ? events.includes('tag_push')
          : (existing?.tag_push_events ?? false),
        releases_events: events ? events.includes('release') : (existing?.releases_events ?? false),
      };
      if (params.secret !== undefined) body.token = params.secret;
      const { data } = await http.json<GitLabHook>(path, {
        method: 'PUT',
        body,
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async deleteWebhook(params: DeleteWebhookParams): Promise<void> {
      await http.raw(`${hooksPath(params.repo)}/${params.id}`, {
        method: 'DELETE',
        signal: params.signal,
      });
    },
  };
}

import { RepoError } from '../../errors.ts';
import { HttpClient, type HttpRequestOptions, type ProviderErrorInfo } from '../../http.ts';
import { decodeCursor, encodeCursor } from '../../pagination.ts';
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
import { commitWebUrlBuilder, filenameFromContentDisposition, isRecord } from '../shared.ts';
import {
  API_VERSION,
  authHeader,
  authSecrets,
  BASIC_AUTH_USERNAME,
  type AzureDevOpsAuth,
} from './auth.ts';

const DEFAULT_BASE_URL = 'https://dev.azure.com';
const DEFAULT_COMMIT_PAGE_SIZE = 100;

export interface AzureDevOpsProviderOptions {
  organization: string;
  auth: AzureDevOpsAuth;
  baseUrl?: string;
  fetch?: typeof fetch;
  /**
   * When set, webhooks are registered to deliver the secret verbatim in this
   * custom HTTP header (via the service hook's `httpHeaders` consumer input)
   * instead of HTTP Basic auth. Pass the same header name to `verifyWebhook`.
   */
  webhookSecretHeader?: string;
}

const CAPABILITIES: RepoCapabilities = {
  tagDates: false,
  repoSearch: false,
  ownedRepoFilter: false,
  // Azure DevOps commit payloads carry only name/email/date for authors.
  commitUserRef: false,
  refSearch: true,
  webhookEvents: ['push', 'tag_push'],
  webhookVerification: 'basic-auth',
  archiveFormats: ['zip'],
};

interface AzureList<T> {
  count: number;
  value: T[];
}

interface AzureProjectRef {
  id: string;
  name: string;
  visibility?: string;
}

interface AzureRepo {
  id: string;
  name: string;
  project: AzureProjectRef;
  defaultBranch?: string;
  remoteUrl?: string;
  sshUrl?: string;
  webUrl?: string;
}

interface AzureUserDate {
  name?: string;
  email?: string;
  date?: string;
}

interface AzureCommit {
  commitId: string;
  comment?: string;
  author?: AzureUserDate;
  committer?: AzureUserDate;
  parents?: string[];
  url?: string;
  remoteUrl?: string;
}

interface AzureRef {
  name: string;
  objectId: string;
  peeledObjectId?: string;
}

interface AzureSubscription {
  id: string;
  eventType?: string;
  status?: string;
  publisherInputs?: { projectId?: string; repository?: string };
  consumerInputs?: {
    url?: string;
    basicAuthUsername?: string;
    basicAuthPassword?: string;
    httpHeaders?: string;
  };
}

interface ResolvedRepo {
  repoId: string;
  projectId: string;
  projectName: string;
  repoName: string;
}

const enc = encodeURIComponent;

function is40Hex(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

function stripPrefix(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function toNamespace(project: AzureProjectRef): Namespace {
  return { id: project.id, slug: project.name, name: project.name, kind: 'project', raw: project };
}

function toRepository(repo: AzureRepo): Repository {
  return {
    id: repo.id,
    name: repo.name,
    path: `${repo.project.name}/${repo.name}`,
    namespace: repo.project.name,
    defaultBranch: repo.defaultBranch ? stripPrefix(repo.defaultBranch, 'refs/heads/') : undefined,
    private: repo.project.visibility !== 'public',
    urls: {
      web: repo.webUrl,
      cloneHttp: repo.remoteUrl,
      cloneSsh: repo.sshUrl,
    },
    raw: repo,
  };
}

function toActor(actor: AzureUserDate | undefined): GitActor {
  return {
    name: actor?.name ?? '',
    email: actor?.email ?? undefined,
    date: actor?.date ? new Date(actor.date) : new Date(0),
  };
}

function toCommit(commit: AzureCommit): Commit {
  return {
    sha: commit.commitId,
    message: commit.comment ?? '',
    author: toActor(commit.author),
    committer: commit.committer ? toActor(commit.committer) : undefined,
    parents: commit.parents ?? [],
    url: commit.remoteUrl ?? undefined,
    raw: commit,
  };
}

function toTag(ref: AzureRef): Tag {
  return {
    name: stripPrefix(ref.name, 'refs/tags/'),
    sha: ref.peeledObjectId ?? ref.objectId,
    isAnnotated: ref.peeledObjectId != null,
    raw: ref,
  };
}

function toBranch(ref: AzureRef): Branch {
  return { name: stripPrefix(ref.name, 'refs/heads/'), sha: ref.objectId, raw: ref };
}

function fromAzureEvents(eventType: string | undefined): WebhookEventType[] {
  return eventType === 'git.push' ? ['push', 'tag_push'] : [];
}

function toWebhook(subscription: AzureSubscription): Webhook {
  return {
    id: subscription.id,
    url: subscription.consumerInputs?.url ?? '',
    events: fromAzureEvents(subscription.eventType),
    active: subscription.status === 'enabled' || subscription.status === 'onProbation',
    raw: subscription,
  };
}

function mapError(status: number, body: unknown): ProviderErrorInfo {
  const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
  return { message };
}

function splitRepo(repo: string): { project: string; repository: string } {
  const index = repo.indexOf('/');
  if (index === -1) {
    throw new RepoError(`Invalid repository "${repo}"; expected "project/repository"`, {
      code: 'validation',
      provider: 'azure-devops',
    });
  }
  return { project: repo.slice(0, index), repository: repo.slice(index + 1) };
}

function repoBasePath(repo: string): string {
  const { project, repository } = splitRepo(repo);
  return `/${enc(project)}/_apis/git/repositories/${enc(repository)}`;
}

/**
 * Builds the human-facing web URL for a commit from the repository's web URL
 * (`Repository.urls.web`) and a commit SHA — no API request needed.
 */
export const commitWebUrl = commitWebUrlBuilder('commit');

export function azureDevOps(options: AzureDevOpsProviderOptions): RepoProvider {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetch ?? fetch;
  const auth = options.auth;

  const secretConsumerInputs = (secret: string) =>
    options.webhookSecretHeader
      ? { httpHeaders: `${options.webhookSecretHeader}:${secret}` }
      : { basicAuthUsername: BASIC_AUTH_USERNAME, basicAuthPassword: secret };

  const http = new HttpClient({
    provider: 'azure-devops',
    baseUrl: `${baseUrl.replace(/\/+$/, '')}/${enc(options.organization)}`,
    fetchImpl,
    authHeaders: async () => ({ Authorization: await authHeader(auth) }),
    mapError,
    secrets: () => authSecrets(auth),
  });

  // Every Azure DevOps request must carry `api-version`; bake it into one place.
  function versioned(request: HttpRequestOptions = {}): HttpRequestOptions {
    return { ...request, query: { ...request.query, 'api-version': API_VERSION } };
  }

  async function rawApi(path: string, request: HttpRequestOptions = {}): Promise<Response> {
    const response = await http.raw(path, versioned(request));
    // A 203 with an HTML sign-in page means the credentials were rejected. Since
    // 203 is technically a 2xx the shared error mapper never sees it — catch here.
    if (response.status === 203) {
      throw new RepoError('Azure DevOps rejected the credentials (non-JSON 203 response)', {
        code: 'unauthorized',
        provider: 'azure-devops',
        status: 203,
        secrets: authSecrets(auth),
      });
    }
    return response;
  }

  async function jsonApi<T>(
    path: string,
    request: HttpRequestOptions = {},
  ): Promise<{ data: T; response: Response }> {
    const response = await rawApi(path, request);
    const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    return { data, response };
  }

  const repoCache = new Map<string, Promise<ResolvedRepo>>();
  function resolveRepo(repo: string, signal?: AbortSignal): Promise<ResolvedRepo> {
    let cached = repoCache.get(repo);
    if (!cached) {
      cached = (async () => {
        const { data } = await jsonApi<AzureRepo>(repoBasePath(repo), { signal });
        return {
          repoId: data.id,
          projectId: data.project.id,
          projectName: data.project.name,
          repoName: data.name,
        };
      })().catch((error) => {
        repoCache.delete(repo);
        throw error;
      });
      repoCache.set(repo, cached);
    }
    return cached;
  }

  return {
    name: 'azure-devops',
    capabilities: CAPABILITIES,

    async listNamespaces(params: ListNamespacesParams): Promise<Page<Namespace>> {
      const query: HttpRequestOptions['query'] = { $top: params.limit };
      if (params.cursor) {
        query.continuationToken = decodeCursor<{ token: string }>(
          'azure-devops',
          params.cursor,
        ).token;
      }
      const { data, response } = await jsonApi<AzureList<AzureProjectRef>>('/_apis/projects', {
        query,
        signal: params.signal,
      });
      const token = response.headers.get('x-ms-continuationtoken');
      return {
        data: data.value.map(toNamespace),
        cursor: token ? encodeCursor('azure-devops', { token }) : undefined,
      };
    },

    async listRepositories(params: ListRepositoriesParams): Promise<Page<Repository>> {
      const path = params.namespace
        ? `/${enc(params.namespace)}/_apis/git/repositories`
        : '/_apis/git/repositories';
      const { data } = await jsonApi<AzureList<AzureRepo>>(path, { signal: params.signal });
      // The Azure DevOps repositories endpoint returns all repos in one response (no server
      // cursor), so `limit` can only be honored client-side.
      const repos = params.limit !== undefined ? data.value.slice(0, params.limit) : data.value;
      return { data: repos.map(toRepository) };
    },

    async getRepository(params: GetRepositoryParams): Promise<Repository> {
      const { data } = await jsonApi<AzureRepo>(repoBasePath(params.repo), {
        signal: params.signal,
      });
      return toRepository(data);
    },

    async listCommits(params: ListCommitsParams): Promise<Page<Commit>> {
      const top = params.limit ?? DEFAULT_COMMIT_PAGE_SIZE;
      const skip = params.cursor
        ? decodeCursor<{ skip: number }>('azure-devops', params.cursor).skip
        : undefined;
      const query: HttpRequestOptions['query'] = {
        'searchCriteria.$top': top,
        'searchCriteria.$skip': skip,
        'searchCriteria.author': params.author,
        'searchCriteria.itemPath': params.path,
        'searchCriteria.fromDate': params.since?.toISOString(),
        'searchCriteria.toDate': params.until?.toISOString(),
      };
      if (params.ref) {
        query['searchCriteria.itemVersion.version'] = params.ref;
        query['searchCriteria.itemVersion.versionType'] = is40Hex(params.ref) ? 'commit' : 'branch';
      }
      const { data } = await jsonApi<AzureList<AzureCommit>>(
        `${repoBasePath(params.repo)}/commits`,
        { query, signal: params.signal },
      );
      const cursor =
        data.value.length === top
          ? encodeCursor('azure-devops', { skip: (skip ?? 0) + top })
          : undefined;
      return { data: data.value.map(toCommit), cursor };
    },

    async getCommit(params: GetCommitParams): Promise<Commit> {
      const base = repoBasePath(params.repo);
      if (is40Hex(params.ref)) {
        const { data } = await jsonApi<AzureCommit>(`${base}/commits/${enc(params.ref)}`, {
          signal: params.signal,
        });
        return toCommit(data);
      }
      const tip = async (versionType: 'branch' | 'tag'): Promise<AzureCommit | undefined> => {
        try {
          const { data } = await jsonApi<AzureList<AzureCommit>>(`${base}/commits`, {
            query: {
              'searchCriteria.itemVersion.version': params.ref,
              'searchCriteria.itemVersion.versionType': versionType,
              'searchCriteria.$top': 1,
            },
            signal: params.signal,
          });
          return data.value[0];
        } catch (error) {
          // Only a genuine "ref absent" outcome should fall through branch→tag. Any other
          // RepoError (unauthorized/forbidden/rate_limited/network_error/provider_error) is a
          // real failure and must propagate instead of being masked as a missing ref.
          if (error instanceof RepoError && error.code === 'not_found') return undefined;
          throw error;
        }
      };
      const commit = (await tip('branch')) ?? (await tip('tag'));
      if (!commit) {
        throw new RepoError(`Ref "${params.ref}" not found`, {
          code: 'not_found',
          provider: 'azure-devops',
        });
      }
      return toCommit(commit);
    },

    async listTags(params: ListTagsParams): Promise<Page<Tag>> {
      const query: HttpRequestOptions['query'] = {
        filter: 'tags/',
        peelTags: true,
        $top: params.limit,
      };
      if (params.cursor) {
        query.continuationToken = decodeCursor<{ token: string }>(
          'azure-devops',
          params.cursor,
        ).token;
      }
      const { data, response } = await jsonApi<AzureList<AzureRef>>(
        `${repoBasePath(params.repo)}/refs`,
        { query, signal: params.signal },
      );
      const token = response.headers.get('x-ms-continuationtoken');
      return {
        data: data.value.map(toTag),
        cursor: token ? encodeCursor('azure-devops', { token }) : undefined,
      };
    },

    async listBranches(params: ListBranchesParams): Promise<Page<Branch>> {
      const query: HttpRequestOptions['query'] = { filter: 'heads/', $top: params.limit };
      if (params.cursor) {
        query.continuationToken = decodeCursor<{ token: string }>(
          'azure-devops',
          params.cursor,
        ).token;
      }
      const { data, response } = await jsonApi<AzureList<AzureRef>>(
        `${repoBasePath(params.repo)}/refs`,
        { query, signal: params.signal },
      );
      const token = response.headers.get('x-ms-continuationtoken');
      return {
        data: data.value.map(toBranch),
        cursor: token ? encodeCursor('azure-devops', { token }) : undefined,
      };
    },

    async searchRefs(params: ProviderSearchRefsParams): Promise<RefMatch[]> {
      // Azure's refs endpoint prefix-matches via `filter`; a single request per type
      // is enough since `$top` caps the results — never follow continuation tokens here.
      const refsPath = `${repoBasePath(params.repo)}/refs`;
      const matches = await Promise.all(
        (['branch', 'tag'] as const)
          .filter((type) => params.types.includes(type))
          .map(async (type) => {
            const isTag = type === 'tag';
            const { data } = await jsonApi<AzureList<AzureRef>>(refsPath, {
              query: {
                filter: `${isTag ? 'tags/' : 'heads/'}${params.query}`,
                ...(isTag ? { peelTags: true } : {}),
                $top: params.limit,
              },
              signal: params.signal,
            });
            const prefix = isTag ? 'refs/tags/' : 'refs/heads/';
            return data.value.map((ref): RefMatch => ({
              type,
              name: stripPrefix(ref.name, prefix),
              sha: isTag ? (ref.peeledObjectId ?? ref.objectId) : ref.objectId,
              raw: ref,
            }));
          }),
      );
      return matches.flat().slice(0, params.limit);
    },

    async downloadArchive(params: DownloadArchiveParams): Promise<Archive> {
      const path = `${repoBasePath(params.repo)}/items`;
      const versionType = is40Hex(params.ref) ? 'commit' : 'branch';
      const request = (type: 'branch' | 'tag' | 'commit'): Promise<Response> =>
        rawApi(path, {
          query: {
            path: '/',
            'versionDescriptor.version': params.ref,
            'versionDescriptor.versionType': type,
            resolveLfs: true,
            $format: 'zip',
            download: true,
          },
          headers: { Accept: 'application/zip' },
          signal: params.signal,
        });

      let response: Response;
      try {
        response = await request(versionType);
      } catch (error) {
        if (error instanceof RepoError && error.code === 'not_found' && versionType === 'branch') {
          response = await request('tag');
        } else {
          throw error;
        }
      }
      return {
        stream: response.body!,
        contentType: response.headers.get('content-type') ?? undefined,
        filename: filenameFromContentDisposition(response.headers.get('content-disposition')),
      };
    },

    async getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl> {
      const { project, repository } = splitRepo(params.repo);
      const host = new URL(baseUrl).host;
      const repoPath = `${enc(options.organization)}/${enc(project)}/_git/${enc(repository)}`;
      if ('pat' in auth) {
        return { url: `https://pat:${encodeURIComponent(auth.pat)}@${host}/${repoPath}` };
      }
      if ('accessToken' in auth) {
        return {
          url: `https://oauth2:${encodeURIComponent(auth.accessToken)}@${host}/${repoPath}`,
        };
      }
      const token = await auth.tokenProvider();
      return { url: `https://${host}/${repoPath}`, headers: { Authorization: `Bearer ${token}` } };
    },

    async createWebhook(params: CreateWebhookParams): Promise<Webhook> {
      // Azure DevOps delivers branch and tag pushes together through a single `git.push`
      // service-hook subscription; it cannot filter down to only one of them. A strict subset
      // like ['push'] or ['tag_push'] therefore cannot be honored — require both together.
      if (!params.events.includes('push') || !params.events.includes('tag_push')) {
        throw new RepoError(
          "Azure DevOps delivers branch and tag pushes together via a single 'git.push' " +
            "subscription and cannot filter to a subset; request both 'push' and 'tag_push'",
          { code: 'unsupported', provider: 'azure-devops' },
        );
      }
      const { repoId, projectId } = await resolveRepo(params.repo, params.signal);
      const { data } = await jsonApi<AzureSubscription>('/_apis/hooks/subscriptions', {
        method: 'POST',
        body: {
          publisherId: 'tfs',
          eventType: 'git.push',
          resourceVersion: '1.0',
          consumerId: 'webHooks',
          consumerActionId: 'httpRequest',
          status: params.active === false ? 'disabledByUser' : 'enabled',
          publisherInputs: { projectId, repository: repoId },
          consumerInputs: {
            url: params.url,
            ...(params.secret ? secretConsumerInputs(params.secret) : {}),
          },
        },
        signal: params.signal,
      });
      return toWebhook(data);
    },

    async listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>> {
      const { repoId } = await resolveRepo(params.repo, params.signal);
      const { data } = await jsonApi<AzureList<AzureSubscription>>('/_apis/hooks/subscriptions', {
        query: { consumerId: 'webHooks' },
        signal: params.signal,
      });
      const filtered = data.value.filter((sub) => sub.publisherInputs?.repository === repoId);
      return { data: filtered.map(toWebhook) };
    },

    async getWebhook(params: GetWebhookParams): Promise<Webhook> {
      const { data } = await jsonApi<AzureSubscription>(
        `/_apis/hooks/subscriptions/${enc(params.id)}`,
        { signal: params.signal },
      );
      return toWebhook(data);
    },

    async updateWebhook(params: UpdateWebhookParams): Promise<Webhook> {
      const { data: existing } = await jsonApi<AzureSubscription>(
        `/_apis/hooks/subscriptions/${enc(params.id)}`,
        { signal: params.signal },
      );
      const consumerInputs = { ...existing.consumerInputs };
      if (params.url !== undefined) consumerInputs.url = params.url;
      if (params.secret !== undefined) {
        Object.assign(consumerInputs, secretConsumerInputs(params.secret));
      } else if (
        existing.consumerInputs?.basicAuthUsername &&
        !existing.consumerInputs.basicAuthPassword
      ) {
        // Azure DevOps never returns `basicAuthPassword` on read, so round-tripping the
        // subscription would PUT it back empty and silently wipe the secret. Refuse instead.
        throw new RepoError(
          'This webhook uses Basic auth, but Azure DevOps does not return the secret on read; ' +
            'pass `secret` again on update so it is not cleared',
          { code: 'validation', provider: 'azure-devops' },
        );
      }
      const body: AzureSubscription = { ...existing, consumerInputs };
      if (params.active === false) body.status = 'disabledByUser';
      else if (params.active === true) body.status = 'enabled';

      const { data } = await jsonApi<AzureSubscription>(
        `/_apis/hooks/subscriptions/${enc(params.id)}`,
        { method: 'PUT', body, signal: params.signal },
      );
      return toWebhook(data);
    },

    async deleteWebhook(params: DeleteWebhookParams): Promise<void> {
      await rawApi(`/_apis/hooks/subscriptions/${enc(params.id)}`, {
        method: 'DELETE',
        signal: params.signal,
      });
    },
  };
}

import { RepoError } from './errors.ts';
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
  GetBranchParams,
  GetCloneUrlParams,
  GetCommitParams,
  GetRepositoryParams,
  GetTagParams,
  GetWebhookParams,
  ListBranchesParams,
  ListCommitsParams,
  ListNamespacesParams,
  ListRepositoriesParams,
  ListTagsParams,
  ListWebhooksParams,
  Namespace,
  Page,
  ProviderName,
  ProviderRefMatch,
  RefMatch,
  RefType,
  Repository,
  ResolveRefParams,
  SearchRefsParams,
  Tag,
  UpdateWebhookParams,
  RepoCapabilities,
  RepoProvider,
  Webhook,
  WebhookEventType,
} from './types.ts';

export interface RetryOptions {
  rateLimit?: boolean;
  maxRetryAfterSeconds?: number;
}

export interface CreateClientOptions {
  provider: RepoProvider;
  retry?: RetryOptions;
}

export interface RepoClient {
  providerName: ProviderName;
  capabilities: RepoCapabilities;
  users: {
    me(params?: GetAuthenticatedUserParams): Promise<AuthenticatedUser>;
  };
  namespaces: {
    list(params?: ListNamespacesParams): Promise<Page<Namespace>>;
    listAll(params?: Omit<ListNamespacesParams, 'cursor'>): AsyncGenerator<Namespace, void>;
  };
  repos: {
    list(params?: ListRepositoriesParams): Promise<Page<Repository>>;
    listAll(params?: Omit<ListRepositoriesParams, 'cursor'>): AsyncGenerator<Repository, void>;
    get(params: GetRepositoryParams): Promise<Repository>;
    downloadArchive(params: DownloadArchiveParams): Promise<Archive>;
    getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl>;
  };
  commits: {
    list(params: ListCommitsParams): Promise<Page<Commit>>;
    listAll(params: Omit<ListCommitsParams, 'cursor'>): AsyncGenerator<Commit, void>;
    get(params: GetCommitParams): Promise<Commit>;
  };
  tags: {
    list(params: ListTagsParams): Promise<Page<Tag>>;
    listAll(params: Omit<ListTagsParams, 'cursor'>): AsyncGenerator<Tag, void>;
    get(params: GetTagParams): Promise<Tag>;
  };
  branches: {
    list(params: ListBranchesParams): Promise<Page<Branch>>;
    listAll(params: Omit<ListBranchesParams, 'cursor'>): AsyncGenerator<Branch, void>;
    get(params: GetBranchParams): Promise<Branch>;
  };
  refs: {
    search(params: SearchRefsParams): Promise<RefMatch[]>;
    resolve(params: ResolveRefParams): Promise<RefMatch>;
  };
  webhooks: {
    create(params: CreateWebhookParams): Promise<Webhook>;
    list(params: ListWebhooksParams): Promise<Page<Webhook>>;
    get(params: GetWebhookParams): Promise<Webhook>;
    update(params: UpdateWebhookParams): Promise<Webhook>;
    delete(params: DeleteWebhookParams): Promise<void>;
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const DEFAULT_REF_SEARCH_LIMIT = 20;
const ALL_REF_TYPES: RefType[] = ['branch', 'tag', 'commit'];
const COMMIT_SHA_PATTERN = /^[0-9a-f]{4,40}$/i;
const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const BRANCH_REF_PREFIX = 'refs/heads/';
const TAG_REF_PREFIX = 'refs/tags/';

function qualifyRef(match: ProviderRefMatch): RefMatch {
  const ref =
    match.type === 'branch'
      ? `${BRANCH_REF_PREFIX}${match.name}`
      : match.type === 'tag'
        ? `${TAG_REF_PREFIX}${match.name}`
        : match.sha;
  return { ...match, ref };
}

function branchMatch(branch: Branch): RefMatch {
  return qualifyRef({ type: 'branch', name: branch.name, sha: branch.sha, raw: branch.raw });
}

function tagMatch(tag: Tag): RefMatch {
  return qualifyRef({ type: 'tag', name: tag.name, sha: tag.sha, raw: tag.raw });
}

function commitMatch(commit: Commit): RefMatch {
  return qualifyRef({ type: 'commit', name: commit.sha, sha: commit.sha, raw: commit.raw });
}

export function createClient(options: CreateClientOptions): RepoClient {
  const { provider } = options;
  const retryRateLimit = options.retry?.rateLimit ?? true;
  const maxRetryAfterSeconds = options.retry?.maxRetryAfterSeconds ?? 10;

  async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        retryRateLimit &&
        error instanceof RepoError &&
        error.code === 'rate_limited' &&
        error.retryAfter !== undefined &&
        error.retryAfter <= maxRetryAfterSeconds
      ) {
        await delay(error.retryAfter * 1000);
        return operation();
      }
      throw error;
    }
  }

  function fail(code: 'validation' | 'unsupported', message: string): never {
    throw new RepoError(message, { code, provider: provider.name });
  }

  function requireNonEmpty(value: string | undefined, field: string): void {
    if (!value?.trim()) {
      fail('validation', `Missing required parameter: ${field}`);
    }
  }

  function checkRepoListParams(params: ListRepositoriesParams): void {
    if (params.query !== undefined && !provider.capabilities.repoSearch) {
      fail('unsupported', `${provider.name} does not support free-text repository search`);
    }
    if (params.owned && !provider.capabilities.ownedRepoFilter) {
      fail('unsupported', `${provider.name} does not support filtering by repository ownership`);
    }
  }

  function checkWebhookEvents(events: WebhookEventType[] | undefined): void {
    if (events === undefined) return;
    if (events.length === 0) {
      fail('validation', 'At least one webhook event is required');
    }
    const unsupported = events.filter(
      (event) => !provider.capabilities.webhookEvents.includes(event),
    );
    if (unsupported.length > 0) {
      fail(
        'unsupported',
        `${provider.name} does not support webhook events: ${unsupported.join(', ')}`,
      );
    }
  }

  function listAllOf<T, P extends { cursor?: string }>(
    params: Omit<P, 'cursor'>,
    fetchPage: (params: P) => Promise<Page<T>>,
  ): AsyncGenerator<T, void> {
    return (async function* () {
      let cursor: string | undefined;
      do {
        const page = await withRetry(() => fetchPage({ ...params, cursor } as P));
        yield* page.data;
        cursor = page.cursor;
      } while (cursor !== undefined);
    })();
  }

  return {
    providerName: provider.name,
    capabilities: provider.capabilities,
    users: {
      me: async (params = {}) => {
        if (!provider.capabilities.userProfile) {
          fail(
            'unsupported',
            `${provider.name} cannot resolve the authenticated user with the configured credentials`,
          );
        }
        return withRetry(() => provider.getAuthenticatedUser(params));
      },
    },
    namespaces: {
      list: async (params = {}) => withRetry(() => provider.listNamespaces(params)),
      listAll: (params = {}) => listAllOf(params, (p) => provider.listNamespaces(p)),
    },
    repos: {
      list: async (params = {}) => {
        checkRepoListParams(params);
        return withRetry(() => provider.listRepositories(params));
      },
      listAll: (params = {}) =>
        listAllOf(params, (p) => {
          checkRepoListParams(p);
          return provider.listRepositories(p);
        }),
      get: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        return withRetry(() => provider.getRepository(params));
      },
      downloadArchive: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.ref, 'ref');
        const format = params.format ?? 'zip';
        if (!provider.capabilities.archiveFormats.includes(format)) {
          fail('unsupported', `${provider.name} does not support the "${format}" archive format`);
        }
        return withRetry(() => provider.downloadArchive({ ...params, format }));
      },
      getCloneUrl: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        return withRetry(() => provider.getCloneUrl(params));
      },
    },
    commits: {
      list: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        return withRetry(() => provider.listCommits(params));
      },
      listAll: (params) =>
        listAllOf(params, (p) => {
          requireNonEmpty(p.repo, 'repo');
          return provider.listCommits(p);
        }),
      get: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.ref, 'ref');
        return withRetry(() => provider.getCommit(params));
      },
    },
    tags: {
      get: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.name, 'name');
        return withRetry(() => provider.getTag(params));
      },
      list: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        return withRetry(() => provider.listTags(params));
      },
      listAll: (params) =>
        listAllOf(params, (p) => {
          requireNonEmpty(p.repo, 'repo');
          return provider.listTags(p);
        }),
    },
    branches: {
      get: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.name, 'name');
        return withRetry(() => provider.getBranch(params));
      },
      list: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        return withRetry(() => provider.listBranches(params));
      },
      listAll: (params) =>
        listAllOf(params, (p) => {
          requireNonEmpty(p.repo, 'repo');
          return provider.listBranches(p);
        }),
    },
    refs: {
      search: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        if (!provider.capabilities.refSearch) {
          fail('unsupported', `${provider.name} does not support ref search`);
        }
        const types = params.types ?? ALL_REF_TYPES;
        if (types.length === 0) {
          fail('validation', 'At least one ref type is required');
        }
        const { repo, query, signal } = params;
        const limit = params.limit ?? DEFAULT_REF_SEARCH_LIMIT;
        if (query === '') {
          const [branches, tags] = await Promise.all([
            types.includes('branch')
              ? withRetry(() => provider.listBranches({ repo, limit, signal }))
              : { data: [] as Branch[] },
            types.includes('tag')
              ? withRetry(() => provider.listTags({ repo, limit, signal }))
              : { data: [] as Tag[] },
          ]);
          return [...branches.data.map(branchMatch), ...tags.data.map(tagMatch)].slice(0, limit);
        }
        const refTypes = types.filter((t): t is Exclude<RefType, 'commit'> => t !== 'commit');
        const [refMatches, commitMatches] = await Promise.all([
          refTypes.length > 0
            ? withRetry(() =>
                provider.searchRefs({ repo, query, types: refTypes, limit, signal }),
              ).then((matches) => matches.map(qualifyRef))
            : ([] as RefMatch[]),
          types.includes('commit') && COMMIT_SHA_PATTERN.test(query)
            ? withRetry(() => provider.getCommit({ repo, ref: query, signal })).then(
                (commit): RefMatch[] => [commitMatch(commit)],
                (error) => {
                  // `unsupported`: providers without commit lookup (git-http)
                  // simply contribute no commit matches.
                  if (
                    error instanceof RepoError &&
                    (error.code === 'not_found' ||
                      error.code === 'validation' ||
                      error.code === 'unsupported')
                  ) {
                    return [];
                  }
                  throw error;
                },
              )
            : ([] as RefMatch[]),
        ]);
        return [...refMatches, ...commitMatches].slice(0, limit);
      },
      resolve: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.ref, 'ref');
        const { repo, signal } = params;
        let { ref, type } = params;
        const impliedType = ref.startsWith(BRANCH_REF_PREFIX)
          ? 'branch'
          : ref.startsWith(TAG_REF_PREFIX)
            ? 'tag'
            : undefined;
        if (impliedType !== undefined) {
          if (type !== undefined && type !== impliedType) {
            fail('validation', `Fully-qualified ref '${ref}' contradicts type '${type}'`);
          }
          type = impliedType;
          ref = ref.slice(
            impliedType === 'branch' ? BRANCH_REF_PREFIX.length : TAG_REF_PREFIX.length,
          );
          requireNonEmpty(ref, 'ref');
        }
        if (
          impliedType === undefined &&
          ref === 'HEAD' &&
          (type === undefined || type === 'branch')
        ) {
          const repository = await withRetry(() => provider.getRepository({ repo, signal }));
          const defaultBranch = repository.defaultBranch;
          if (defaultBranch === undefined) {
            throw new RepoError('Cannot resolve HEAD: repository has no default branch', {
              code: 'not_found',
              provider: provider.name,
            });
          }
          return branchMatch(
            await withRetry(() => provider.getBranch({ repo, name: defaultBranch, signal })),
          );
        }
        if (type === 'commit') {
          return commitMatch(await withRetry(() => provider.getCommit({ repo, ref, signal })));
        }
        // A full 40-hex ref is an object id before it is a ref name (git
        // rev-parse semantics), and it is the webhook-consumer hot path —
        // one request instead of three. Branch/tag probes only run on a miss.
        let commitProbeError: RepoError | undefined;
        if (type === undefined && FULL_COMMIT_SHA_PATTERN.test(ref)) {
          try {
            return commitMatch(await withRetry(() => provider.getCommit({ repo, ref, signal })));
          } catch (error) {
            if (
              error instanceof RepoError &&
              (error.code === 'not_found' ||
                error.code === 'validation' ||
                error.code === 'unsupported')
            ) {
              commitProbeError = error;
            } else {
              throw error;
            }
          }
        }
        const [tagResult, branchResult] = await Promise.allSettled([
          type === 'branch'
            ? undefined
            : withRetry(() => provider.getTag({ repo, name: ref, signal })),
          type === 'tag'
            ? undefined
            : withRetry(() => provider.getBranch({ repo, name: ref, signal })),
        ]);
        const isMiss = (result: PromiseSettledResult<unknown>): boolean =>
          result.status === 'rejected' &&
          result.reason instanceof RepoError &&
          result.reason.code === 'not_found';
        // Tag precedence follows git rev-parse: a tag shadows a branch of the
        // same name, so a tag failure other than a miss must propagate even
        // when the branch lookup succeeded.
        if (tagResult.status === 'fulfilled') {
          if (tagResult.value !== undefined) return tagMatch(tagResult.value);
        } else if (!isMiss(tagResult)) {
          throw tagResult.reason;
        }
        if (branchResult.status === 'fulfilled') {
          if (branchResult.value !== undefined) return branchMatch(branchResult.value);
        } else if (!isMiss(branchResult)) {
          throw branchResult.reason;
        }
        if (type === undefined && COMMIT_SHA_PATTERN.test(ref)) {
          // The full-SHA fast path already asked the provider; surface its
          // original error instead of a second identical request.
          if (commitProbeError !== undefined) throw commitProbeError;
          return commitMatch(await withRetry(() => provider.getCommit({ repo, ref, signal })));
        }
        throw new RepoError(`Ref not found: ${ref}`, {
          code: 'not_found',
          provider: provider.name,
        });
      },
    },
    webhooks: {
      create: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.url, 'url');
        checkWebhookEvents(params.events ?? []);
        return withRetry(() => provider.createWebhook(params));
      },
      list: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        return withRetry(() => provider.listWebhooks(params));
      },
      get: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.id, 'id');
        return withRetry(() => provider.getWebhook(params));
      },
      update: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.id, 'id');
        checkWebhookEvents(params.events);
        return withRetry(() => provider.updateWebhook(params));
      },
      delete: async (params) => {
        requireNonEmpty(params.repo, 'repo');
        requireNonEmpty(params.id, 'id');
        return withRetry(() => provider.deleteWebhook(params));
      },
    },
  };
}

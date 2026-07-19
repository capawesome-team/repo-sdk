import { RepoError } from './errors.ts';
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
  ListCommitsParams,
  ListNamespacesParams,
  ListRepositoriesParams,
  ListTagsParams,
  ListWebhooksParams,
  Namespace,
  Page,
  ProviderName,
  Repository,
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

import { RepoError } from '../../errors.ts';
import { decodeCursor, encodeCursor } from '../../pagination.ts';
import type {
  Archive,
  ArchiveFormat,
  AuthenticatedUser,
  ProviderName,
  Branch,
  CloneUrl,
  Commit,
  CreateWebhookParams,
  DeleteWebhookParams,
  DownloadArchiveParams,
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
  NamespaceKind,
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

/**
 * Small on purpose so that consumers exercise cursor-based pagination.
 */
const PAGE_SIZE = 2;

const CAPABILITIES: RepoCapabilities = {
  userProfile: true,
  tagDates: true,
  repoSearch: true,
  ownedRepoFilter: true,
  commitUserRef: true,
  refSearch: true,
  webhookEvents: ['push', 'tag_push', 'release'],
  webhookVerification: 'hmac-sha256',
  archiveFormats: ['zip', 'tar.gz'],
};

export interface InMemoryNamespaceSeed {
  id: string;
  slug: string;
  name: string;
  kind: NamespaceKind;
  parent?: string;
  avatarUrl?: string;
}

export interface InMemoryRepositorySeed {
  id?: string;
  name?: string;
  path?: string;
  namespace?: string;
  defaultBranch?: string;
  private?: boolean;
  archived?: boolean;
  urls?: Partial<Repository['urls']>;
  /** Marks the repository as owned by the authenticated user (honored by `owned` filter). */
  owned?: boolean;
}

export interface InMemoryActorSeed {
  name?: string;
  email?: string;
  date?: Date;
  user?: { id: string; username: string; avatarUrl?: string };
}

export interface InMemoryCommitSeed {
  sha: string;
  message?: string;
  author?: InMemoryActorSeed;
  committer?: InMemoryActorSeed;
  parents?: string[];
  url?: string;
  /** Refs (branches/tags) this commit belongs to; when omitted the commit matches any ref. */
  refs?: string[];
}

export interface InMemoryTagSeed {
  name: string;
  sha: string;
  message?: string;
  date?: Date;
  isAnnotated?: boolean;
}

export interface InMemoryBranchSeed {
  name: string;
  sha: string;
}

export interface InMemoryWebhookSeed {
  id?: string;
  url: string;
  events: WebhookEventType[];
  active?: boolean;
}

export interface InMemoryUserSeed {
  id?: string;
  username?: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

export interface InMemorySeed {
  /** The authenticated user returned by `users.me`; defaults apply when omitted. */
  user?: InMemoryUserSeed;
  namespaces?: InMemoryNamespaceSeed[];
  /** Repositories keyed by their path (e.g. `acme/service`). */
  repositories?: Record<string, InMemoryRepositorySeed>;
  /** Commits keyed by repository path, newest first. */
  commits?: Record<string, InMemoryCommitSeed[]>;
  /** Tags keyed by repository path. */
  tags?: Record<string, InMemoryTagSeed[]>;
  /** Branches keyed by repository path. */
  branches?: Record<string, InMemoryBranchSeed[]>;
  /** Webhooks keyed by repository path. */
  webhooks?: Record<string, InMemoryWebhookSeed[]>;
}

export interface InMemoryProviderOptions {
  /** Provider identity to report; defaults to `github`. */
  name?: ProviderName;
  /** Capability overrides merged over the full-featured defaults. */
  capabilities?: Partial<RepoCapabilities>;
}

export interface InMemoryState {
  namespaces: Namespace[];
  repositories: Map<string, Repository>;
  commits: Map<string, Commit[]>;
  tags: Map<string, Tag[]>;
  branches: Map<string, Branch[]>;
  webhooks: Map<string, Webhook[]>;
}

function toActor(actor: InMemoryActorSeed | undefined) {
  return {
    name: actor?.name ?? '',
    email: actor?.email,
    date: actor?.date ?? new Date(0),
    user: actor?.user,
  };
}

function normalizeNamespace(seed: InMemoryNamespaceSeed): Namespace {
  return {
    id: seed.id,
    slug: seed.slug,
    name: seed.name,
    kind: seed.kind,
    parent: seed.parent,
    avatarUrl: seed.avatarUrl,
    raw: seed,
  };
}

function normalizeRepository(path: string, seed: InMemoryRepositorySeed): Repository {
  const resolvedPath = seed.path ?? path;
  const [namespaceSegment, ...rest] = resolvedPath.split('/');
  return {
    id: seed.id ?? resolvedPath,
    name: seed.name ?? rest.join('/') ?? resolvedPath,
    path: resolvedPath,
    namespace: seed.namespace ?? namespaceSegment ?? resolvedPath,
    defaultBranch: seed.defaultBranch ?? 'main',
    private: seed.private ?? false,
    archived: seed.archived ?? false,
    urls: {
      web: seed.urls?.web ?? `https://in-memory.invalid/${resolvedPath}`,
      cloneHttp: seed.urls?.cloneHttp,
      cloneSsh: seed.urls?.cloneSsh,
    },
    raw: seed,
  };
}

function normalizeCommit(seed: InMemoryCommitSeed): Commit {
  return {
    sha: seed.sha,
    message: seed.message ?? '',
    author: toActor(seed.author),
    committer: seed.committer ? toActor(seed.committer) : undefined,
    parents: seed.parents ?? [],
    url: seed.url,
    raw: seed,
  };
}

function normalizeTag(seed: InMemoryTagSeed): Tag {
  return {
    name: seed.name,
    sha: seed.sha,
    message: seed.message,
    date: seed.date,
    isAnnotated: seed.isAnnotated,
    raw: seed,
  };
}

function normalizeBranch(seed: InMemoryBranchSeed): Branch {
  return {
    name: seed.name,
    sha: seed.sha,
    raw: seed,
  };
}

function commitRefs(commit: Commit): string[] | undefined {
  return (commit.raw as InMemoryCommitSeed).refs;
}

function isOwned(repository: Repository): boolean {
  return (repository.raw as InMemoryRepositorySeed).owned === true;
}

function textStream(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function archiveMeta(format: ArchiveFormat): { contentType: string; extension: string } {
  return format === 'zip'
    ? { contentType: 'application/zip', extension: 'zip' }
    : { contentType: 'application/gzip', extension: 'tar.gz' };
}

export function createInMemoryProvider(
  seed: InMemorySeed = {},
  options: InMemoryProviderOptions = {},
): RepoProvider & { state: InMemoryState } {
  const name = options.name ?? 'github';
  const capabilities: RepoCapabilities = { ...CAPABILITIES, ...options.capabilities };

  let hookCounter = 0;
  const nextHookId = (): string => `hook-${++hookCounter}`;

  function notFound(message: string): RepoError {
    return new RepoError(message, { code: 'not_found', provider: name });
  }

  function paginate<T>(items: T[], cursor: string | undefined): Page<T> {
    const offset = cursor ? decodeCursor<{ offset: number }>(name, cursor).offset : 0;
    const nextOffset = offset + PAGE_SIZE;
    return {
      data: items.slice(offset, nextOffset),
      cursor: nextOffset < items.length ? encodeCursor(name, { offset: nextOffset }) : undefined,
    };
  }

  const state: InMemoryState = {
    namespaces: (seed.namespaces ?? []).map(normalizeNamespace),
    repositories: new Map(
      Object.entries(seed.repositories ?? {}).map(([path, repoSeed]) => [
        path,
        normalizeRepository(path, repoSeed),
      ]),
    ),
    commits: new Map(
      Object.entries(seed.commits ?? {}).map(([path, commits]) => [
        path,
        commits.map(normalizeCommit),
      ]),
    ),
    tags: new Map(
      Object.entries(seed.tags ?? {}).map(([path, tags]) => [path, tags.map(normalizeTag)]),
    ),
    branches: new Map(
      Object.entries(seed.branches ?? {}).map(([path, branches]) => [
        path,
        branches.map(normalizeBranch),
      ]),
    ),
    webhooks: new Map(
      Object.entries(seed.webhooks ?? {}).map(([path, webhooks]) => [
        path,
        webhooks.map((hook) => ({
          id: hook.id ?? nextHookId(),
          url: hook.url,
          events: hook.events,
          active: hook.active ?? true,
          raw: hook,
        })),
      ]),
    ),
  };

  function requireRepository(repo: string): Repository {
    const repository = state.repositories.get(repo);
    if (!repository) {
      throw notFound(`Unknown repository: ${repo}`);
    }
    return repository;
  }

  return {
    name,
    capabilities,

    getAuthenticatedUser(): Promise<AuthenticatedUser> {
      const user = seed.user ?? {};
      return Promise.resolve({
        id: user.id ?? 'user-1',
        username: user.username ?? 'in-memory-user',
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        raw: user,
      });
    },

    listNamespaces(params: ListNamespacesParams): Promise<Page<Namespace>> {
      return Promise.resolve(paginate(state.namespaces, params.cursor));
    },

    listRepositories(params: ListRepositoriesParams): Promise<Page<Repository>> {
      let repositories = [...state.repositories.values()];
      if (params.namespace !== undefined) {
        repositories = repositories.filter(
          (repository) => repository.path.split('/')[0] === params.namespace,
        );
      }
      if (params.owned) {
        repositories = repositories.filter(isOwned);
      }
      if (params.query !== undefined) {
        const query = params.query.toLowerCase();
        repositories = repositories.filter((repository) =>
          repository.name.toLowerCase().includes(query),
        );
      }
      return Promise.resolve(paginate(repositories, params.cursor));
    },

    getRepository(params: GetRepositoryParams): Promise<Repository> {
      return Promise.resolve(requireRepository(params.repo));
    },

    listCommits(params: ListCommitsParams): Promise<Page<Commit>> {
      requireRepository(params.repo);
      let commits = state.commits.get(params.repo) ?? [];
      if (params.ref !== undefined) {
        const ref = params.ref;
        commits = commits.filter((commit) => {
          const refs = commitRefs(commit);
          return refs === undefined || refs.includes(ref);
        });
      }
      if (params.since !== undefined) {
        const since = params.since.getTime();
        commits = commits.filter((commit) => commit.author.date.getTime() >= since);
      }
      if (params.until !== undefined) {
        const until = params.until.getTime();
        commits = commits.filter((commit) => commit.author.date.getTime() <= until);
      }
      return Promise.resolve(paginate(commits, params.cursor));
    },

    getCommit(params: GetCommitParams): Promise<Commit> {
      const repository = requireRepository(params.repo);
      const commits = state.commits.get(params.repo) ?? [];

      const bySha = commits.find((commit) => commit.sha === params.ref);
      if (bySha) return Promise.resolve(bySha);

      const tag = (state.tags.get(params.repo) ?? []).find((entry) => entry.name === params.ref);
      if (tag) {
        const byTag = commits.find((commit) => commit.sha === tag.sha);
        if (byTag) return Promise.resolve(byTag);
      }

      if (params.ref === repository.defaultBranch && commits.length > 0) {
        return Promise.resolve(commits[0]!);
      }

      throw notFound(`Unknown ref "${params.ref}" in repository: ${params.repo}`);
    },

    listTags(params: ListTagsParams): Promise<Page<Tag>> {
      requireRepository(params.repo);
      return Promise.resolve(paginate(state.tags.get(params.repo) ?? [], params.cursor));
    },

    listBranches(params: ListBranchesParams): Promise<Page<Branch>> {
      requireRepository(params.repo);
      return Promise.resolve(paginate(state.branches.get(params.repo) ?? [], params.cursor));
    },

    getBranch(params: GetBranchParams): Promise<Branch> {
      requireRepository(params.repo);
      const branch = (state.branches.get(params.repo) ?? []).find(
        (candidate) => candidate.name === params.name,
      );
      if (!branch) {
        throw notFound(`Unknown branch "${params.name}" in repository: ${params.repo}`);
      }
      return Promise.resolve(branch);
    },

    getTag(params: GetTagParams): Promise<Tag> {
      requireRepository(params.repo);
      const tag = (state.tags.get(params.repo) ?? []).find(
        (candidate) => candidate.name === params.name,
      );
      if (!tag) {
        throw notFound(`Unknown tag "${params.name}" in repository: ${params.repo}`);
      }
      return Promise.resolve(tag);
    },

    searchRefs(params: ProviderSearchRefsParams): Promise<RefMatch[]> {
      requireRepository(params.repo);
      const matches: RefMatch[] = [];
      if (params.types.includes('branch')) {
        for (const branch of state.branches.get(params.repo) ?? []) {
          if (branch.name.startsWith(params.query)) {
            matches.push({ type: 'branch', name: branch.name, sha: branch.sha, raw: branch.raw });
          }
        }
      }
      if (params.types.includes('tag')) {
        for (const tag of state.tags.get(params.repo) ?? []) {
          if (tag.name.startsWith(params.query)) {
            matches.push({ type: 'tag', name: tag.name, sha: tag.sha, raw: tag.raw });
          }
        }
      }
      return Promise.resolve(matches.slice(0, params.limit));
    },

    downloadArchive(params: DownloadArchiveParams): Promise<Archive> {
      const repository = requireRepository(params.repo);
      const format = params.format ?? 'zip';
      const { contentType, extension } = archiveMeta(format);
      return Promise.resolve({
        stream: textStream(`repo-sdk in-memory archive: ${params.repo}@${params.ref}`),
        contentType,
        filename: `${repository.name}-${params.ref}.${extension}`,
      });
    },

    getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl> {
      requireRepository(params.repo);
      return Promise.resolve({
        url: `https://x-token:test@in-memory.invalid/${params.repo}.git`,
      });
    },

    createWebhook(params: CreateWebhookParams): Promise<Webhook> {
      requireRepository(params.repo);
      const webhook: Webhook = {
        id: nextHookId(),
        url: params.url,
        events: params.events,
        active: params.active ?? true,
        raw: { ...params },
      };
      const webhooks = state.webhooks.get(params.repo) ?? [];
      webhooks.push(webhook);
      state.webhooks.set(params.repo, webhooks);
      return Promise.resolve(webhook);
    },

    listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>> {
      requireRepository(params.repo);
      return Promise.resolve(paginate(state.webhooks.get(params.repo) ?? [], params.cursor));
    },

    getWebhook(params: GetWebhookParams): Promise<Webhook> {
      requireRepository(params.repo);
      const webhook = (state.webhooks.get(params.repo) ?? []).find((hook) => hook.id === params.id);
      if (!webhook) {
        throw notFound(`Unknown webhook "${params.id}" in repository: ${params.repo}`);
      }
      return Promise.resolve(webhook);
    },

    updateWebhook(params: UpdateWebhookParams): Promise<Webhook> {
      requireRepository(params.repo);
      const webhook = (state.webhooks.get(params.repo) ?? []).find((hook) => hook.id === params.id);
      if (!webhook) {
        throw notFound(`Unknown webhook "${params.id}" in repository: ${params.repo}`);
      }
      if (params.url !== undefined) webhook.url = params.url;
      if (params.events !== undefined) webhook.events = params.events;
      if (params.active !== undefined) webhook.active = params.active;
      return Promise.resolve(webhook);
    },

    deleteWebhook(params: DeleteWebhookParams): Promise<void> {
      requireRepository(params.repo);
      const webhooks = state.webhooks.get(params.repo) ?? [];
      const index = webhooks.findIndex((hook) => hook.id === params.id);
      if (index === -1) {
        throw notFound(`Unknown webhook "${params.id}" in repository: ${params.repo}`);
      }
      webhooks.splice(index, 1);
      return Promise.resolve();
    },

    state,
  };
}

export type ProviderName = 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea';

export type WebhookEventType = 'push' | 'tag_push' | 'release';

export type ArchiveFormat = 'zip' | 'tar.gz';

export type NamespaceKind = 'user' | 'organization' | 'group' | 'workspace' | 'project';

export type WebhookVerificationMethod = 'hmac-sha256' | 'shared-token' | 'basic-auth';

export interface Page<T> {
  data: T[];
  cursor?: string;
}

export interface Namespace {
  id: string;
  slug: string;
  name: string;
  kind: NamespaceKind;
  parent?: string;
  avatarUrl?: string;
  raw: unknown;
}

export interface Repository {
  id: string;
  name: string;
  path: string;
  namespace: string;
  defaultBranch?: string;
  private: boolean;
  archived?: boolean;
  urls: {
    /** Always present; constructed from the provider's base URL when the API omits it. */
    web: string;
    cloneHttp?: string;
    cloneSsh?: string;
  };
  raw: unknown;
}

export interface CloneUrl {
  url: string;
  headers?: Record<string, string>;
  expiresAt?: Date;
}

/** The account behind the configured credentials (see the `userProfile` capability). */
export interface AuthenticatedUser {
  id: string;
  username: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  raw: unknown;
}

/** Provider account resolved for a commit actor, when the provider can match one. */
export interface UserRef {
  id: string;
  username: string;
  avatarUrl?: string;
}

export interface GitActor {
  name: string;
  email?: string;
  date: Date;
  /** Set when the provider resolves this actor to an account (see `commitUserRef` capability). */
  user?: UserRef;
}

export interface Commit {
  sha: string;
  message: string;
  author: GitActor;
  committer?: GitActor;
  parents: string[];
  url?: string;
  raw: unknown;
}

export interface Tag {
  name: string;
  sha: string;
  message?: string;
  date?: Date;
  isAnnotated?: boolean;
  raw: unknown;
}

export interface Branch {
  name: string;
  sha: string;
  raw: unknown;
}

export type RefType = 'branch' | 'tag' | 'commit';

export interface RefMatch {
  type: RefType;
  name: string;
  /** SHA the ref points to; the tag object rather than the commit for annotated tags on GitHub and Gitea. */
  sha: string;
  raw: unknown;
}

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEventType[];
  active: boolean;
  raw: unknown;
}

export interface Archive {
  stream: ReadableStream<Uint8Array>;
  contentType?: string;
  filename?: string;
}

export interface ParsedWebhookEvent {
  type: WebhookEventType | 'ping' | 'unknown';
  repo?: string;
  ref?: string;
  commits?: { sha: string; message?: string }[];
  /** SHA the ref points to after the push; undefined when the push deleted the ref. */
  headCommitSha?: string;
  deliveryId?: string;
  /** Provider-assigned identifier of the webhook registration that produced this delivery. */
  webhookId?: string;
  raw: unknown;
}

export interface IncomingWebhookRequest {
  headers: Record<string, string>;
  body: string;
}

interface BaseParams {
  signal?: AbortSignal;
}

export type GetAuthenticatedUserParams = BaseParams;

export interface ListNamespacesParams extends BaseParams {
  cursor?: string;
  limit?: number;
}

export interface ListRepositoriesParams extends BaseParams {
  namespace?: string;
  owned?: boolean;
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface GetRepositoryParams extends BaseParams {
  repo: string;
}

export interface ListCommitsParams extends BaseParams {
  repo: string;
  ref?: string;
  since?: Date;
  until?: Date;
  path?: string;
  author?: string;
  cursor?: string;
  limit?: number;
}

export interface GetCommitParams extends BaseParams {
  repo: string;
  ref: string;
}

export interface ListTagsParams extends BaseParams {
  repo: string;
  cursor?: string;
  limit?: number;
}

export interface ListBranchesParams extends BaseParams {
  repo: string;
  cursor?: string;
  limit?: number;
}

export interface SearchRefsParams extends BaseParams {
  repo: string;
  /** Prefix to match ref names against; an empty string lists the first refs unfiltered. */
  query: string;
  types?: RefType[];
  limit?: number;
}

export interface ProviderSearchRefsParams extends BaseParams {
  repo: string;
  query: string;
  types: Exclude<RefType, 'commit'>[];
  limit: number;
}

export interface DownloadArchiveParams extends BaseParams {
  repo: string;
  ref: string;
  format?: ArchiveFormat;
}

export interface GetCloneUrlParams extends BaseParams {
  repo: string;
}

export interface CreateWebhookParams extends BaseParams {
  repo: string;
  url: string;
  events: WebhookEventType[];
  secret?: string;
  active?: boolean;
}

export interface ListWebhooksParams extends BaseParams {
  repo: string;
  cursor?: string;
  limit?: number;
}

export interface GetWebhookParams extends BaseParams {
  repo: string;
  id: string;
}

export interface UpdateWebhookParams extends BaseParams {
  repo: string;
  id: string;
  url?: string;
  events?: WebhookEventType[];
  secret?: string;
  active?: boolean;
}

export interface DeleteWebhookParams extends BaseParams {
  repo: string;
  id: string;
}

export interface RepoCapabilities {
  /** Whether the authenticated user profile can be resolved (`users.me`); false e.g. for GitHub App installation tokens. */
  userProfile: boolean;
  tagDates: boolean;
  repoSearch: boolean;
  ownedRepoFilter: boolean;
  commitUserRef: boolean;
  refSearch: boolean;
  webhookEvents: WebhookEventType[];
  webhookVerification: WebhookVerificationMethod;
  archiveFormats: ArchiveFormat[];
}

export interface RepoProvider {
  name: ProviderName;
  capabilities: RepoCapabilities;
  getAuthenticatedUser(params: GetAuthenticatedUserParams): Promise<AuthenticatedUser>;
  listNamespaces(params: ListNamespacesParams): Promise<Page<Namespace>>;
  listRepositories(params: ListRepositoriesParams): Promise<Page<Repository>>;
  getRepository(params: GetRepositoryParams): Promise<Repository>;
  listCommits(params: ListCommitsParams): Promise<Page<Commit>>;
  getCommit(params: GetCommitParams): Promise<Commit>;
  listTags(params: ListTagsParams): Promise<Page<Tag>>;
  listBranches(params: ListBranchesParams): Promise<Page<Branch>>;
  /** Prefix-match refs of the requested types, branches before tags, at most `limit` results. */
  searchRefs(params: ProviderSearchRefsParams): Promise<RefMatch[]>;
  downloadArchive(params: DownloadArchiveParams): Promise<Archive>;
  getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl>;
  createWebhook(params: CreateWebhookParams): Promise<Webhook>;
  listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>>;
  getWebhook(params: GetWebhookParams): Promise<Webhook>;
  updateWebhook(params: UpdateWebhookParams): Promise<Webhook>;
  deleteWebhook(params: DeleteWebhookParams): Promise<void>;
}

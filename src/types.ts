export type ProviderName =
  'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'gitea' | 'git-http';

export type WebhookEventType = 'push' | 'tag_push' | 'release';

export type ArchiveFormat = 'zip' | 'tar.gz';

export type NamespaceKind = 'user' | 'organization' | 'group' | 'workspace' | 'project';

export type WebhookVerificationMethod = 'hmac-sha256' | 'shared-token' | 'basic-auth' | 'none';

/**
 * Mints a bearer token for each request. `forceRefresh` is true only on the
 * single retry after a 401 — bypass any cache and mint a fresh token then.
 */
export type TokenProvider = (context: { forceRefresh: boolean }) => Promise<string>;

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
  /** Fully-qualified form — `refs/heads/<name>` for branches, `refs/tags/<name>` for tags, the SHA itself for commits. Any `ref` value round-trips through `refs.resolve`. */
  ref: string;
  /** SHA the ref points to. In `refs.search` results on GitHub and Gitea, annotated tags carry the tag object SHA rather than the commit; `refs.resolve` and `tags.get` always return the peeled commit SHA. */
  sha: string;
  raw: unknown;
}

/** `RefMatch` as produced by provider adapters, before the client derives the fully-qualified `ref`. */
export type ProviderRefMatch = Omit<RefMatch, 'ref'>;

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

export interface GetAuthenticatedUserParams extends BaseParams {
  /**
   * Also resolve the primary verified email when the profile endpoint omits it
   * (GitHub private emails, Bitbucket) — at most one extra request. A missing
   * email scope leaves `email` unset instead of throwing. No-op on providers
   * whose profile call already carries the email.
   */
  includeEmail?: boolean;
}

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

export interface GetBranchParams extends BaseParams {
  repo: string;
  name: string;
}

export interface GetTagParams extends BaseParams {
  repo: string;
  name: string;
}

export interface ResolveRefParams extends BaseParams {
  repo: string;
  /** A branch or tag name, a fully-qualified ref (`refs/heads/…`, `refs/tags/…`), a 4–40 hex commit SHA, or `HEAD`. */
  ref: string;
  /** Restrict resolution to one ref type; when omitted, a full 40-hex `ref` is tried as a commit first, then branches and tags (tag wins on collision), then abbreviated commit SHAs. A fully-qualified `ref` implies its type; passing a contradicting `type` throws a validation error. */
  type?: RefType;
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
  /** Exact-match a branch by name; throws `not_found` on a miss. */
  getBranch(params: GetBranchParams): Promise<Branch>;
  /** Exact-match a tag by name, peeled to the commit SHA for annotated tags; throws `not_found` on a miss. */
  getTag(params: GetTagParams): Promise<Tag>;
  /** Prefix-match refs of the requested types, branches before tags, at most `limit` results. */
  searchRefs(params: ProviderSearchRefsParams): Promise<ProviderRefMatch[]>;
  downloadArchive(params: DownloadArchiveParams): Promise<Archive>;
  getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl>;
  createWebhook(params: CreateWebhookParams): Promise<Webhook>;
  listWebhooks(params: ListWebhooksParams): Promise<Page<Webhook>>;
  getWebhook(params: GetWebhookParams): Promise<Webhook>;
  updateWebhook(params: UpdateWebhookParams): Promise<Webhook>;
  deleteWebhook(params: DeleteWebhookParams): Promise<void>;
}

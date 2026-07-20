import { stringToBase64 } from '../../base64.ts';
import { RepoError } from '../../errors.ts';
import { HttpClient, type ProviderErrorInfo } from '../../http.ts';
import { decodeCursor, encodeCursor } from '../../pagination.ts';
import { clampPerPage } from '../shared.ts';
import type {
  Branch,
  CloneUrl,
  GetCloneUrlParams,
  GetRepositoryParams,
  ListBranchesParams,
  ListTagsParams,
  Page,
  ProviderSearchRefsParams,
  RefMatch,
  Repository,
  Tag,
  TokenProvider,
  RepoCapabilities,
  RepoProvider,
} from '../../types.ts';

export interface GitHttpProviderOptions {
  /**
   * Basic-auth credentials sent only after the remote answers an anonymous
   * request with a 401 — the same flow the git CLI uses. `username` defaults
   * to `git`; most hosts accept any non-empty username with a token as the
   * password (Bitbucket app passwords require the real username). A
   * `tokenProvider` mints the password per request instead (retried once on
   * a 401).
   */
  auth?:
    { username?: string; password: string } | { username?: string; tokenProvider: TokenProvider };
  fetch?: typeof fetch;
}

const CAPABILITIES: RepoCapabilities = {
  userProfile: false,
  tagDates: false,
  repoSearch: false,
  ownedRepoFilter: false,
  commitUserRef: false,
  refSearch: true,
  webhookEvents: [],
  webhookVerification: 'none',
  archiveFormats: [],
};

const DEFAULT_USERNAME = 'git';
const ZERO_SHA = '0'.repeat(40);
const ADVERTISEMENT_CONTENT_TYPE = 'application/x-git-upload-pack-advertisement';
const BRANCH_PREFIX = 'refs/heads/';
const TAG_PREFIX = 'refs/tags/';

interface AdvertisedRef {
  name: string;
  sha: string;
}

interface RefAdvertisement {
  refs: AdvertisedRef[];
  /** Commit SHAs of peeled annotated tags, keyed by the tag ref name. */
  peeled: Map<string, string>;
  symrefs: Map<string, string>;
  capabilities: string[];
}

interface CursorState {
  u: string;
  o: number;
}

function fail(code: 'validation' | 'provider_error', message: string): never {
  throw new RepoError(message, { code, provider: 'git-http' });
}

function unsupported(feature: string): RepoError {
  return new RepoError(`git-http remotes do not support ${feature}`, {
    code: 'unsupported',
    provider: 'git-http',
  });
}

/**
 * Validates and normalizes a remote URL: absolute http(s), no embedded
 * credentials, no trailing slashes. The `repo` parameter of every method is
 * such a URL — a generic git remote has no owner/name coordinates.
 */
function normalizeRepoUrl(repo: string): string {
  if (/^[^/?#]+@/.test(repo) || /^(ssh|git):\/\//i.test(repo)) {
    fail(
      'validation',
      'SSH and git-protocol remotes are not supported; pass an http(s) remote URL',
    );
  }
  let url: URL;
  try {
    url = new URL(repo);
  } catch {
    fail('validation', `Invalid repository URL: expected an absolute http(s) URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail('validation', `Unsupported URL protocol "${url.protocol}"; use http(s)`);
  }
  if (url.username || url.password) {
    fail('validation', 'Pass credentials via the auth option, not embedded in the repository URL');
  }
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

/**
 * Splits a smart-HTTP response into pkt-line payloads. Lengths are byte
 * counts, so the buffer is sliced before decoding — a string-based parse
 * would break on multi-byte ref names.
 */
function parsePktLines(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const header = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/i.test(header)) {
      fail('provider_error', 'Malformed pkt-line in git-upload-pack advertisement');
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) {
      fail('provider_error', 'Truncated pkt-line in git-upload-pack advertisement');
    }
    let payload = bytes.subarray(offset + 4, offset + length);
    if (payload.at(-1) === 0x0a) {
      payload = payload.subarray(0, payload.length - 1);
    }
    lines.push(decoder.decode(payload));
    offset += length;
  }
  return lines;
}

function parseAdvertisement(lines: string[]): RefAdvertisement {
  if (lines[0] !== '# service=git-upload-pack') {
    fail('provider_error', 'Remote did not return a git-upload-pack advertisement');
  }
  const refs: AdvertisedRef[] = [];
  const peeled = new Map<string, string>();
  const symrefs = new Map<string, string>();
  let capabilities: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') continue;
    const nulIndex = line.indexOf('\0');
    const record = nulIndex === -1 ? line : line.slice(0, nulIndex);
    if (nulIndex !== -1) {
      capabilities = line
        .slice(nulIndex + 1)
        .split(' ')
        .filter(Boolean);
      for (const capability of capabilities) {
        if (capability.startsWith('symref=')) {
          const separator = capability.indexOf(':');
          if (separator > 'symref='.length) {
            symrefs.set(
              capability.slice('symref='.length, separator),
              capability.slice(separator + 1),
            );
          }
        }
      }
    }
    const space = record.indexOf(' ');
    if (space === -1) continue;
    const sha = record.slice(0, space);
    const name = record.slice(space + 1);
    // An empty repository advertises a single zero-SHA placeholder record.
    if (sha === ZERO_SHA && name === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) {
      peeled.set(name.slice(0, -3), sha);
      continue;
    }
    refs.push({ name, sha });
  }
  return { refs, peeled, symrefs, capabilities };
}

function branchesOf(advertisement: RefAdvertisement): Branch[] {
  return advertisement.refs
    .filter((ref) => ref.name.startsWith(BRANCH_PREFIX))
    .map((ref) => ({ name: ref.name.slice(BRANCH_PREFIX.length), sha: ref.sha, raw: ref }));
}

function tagsOf(advertisement: RefAdvertisement): Tag[] {
  return advertisement.refs
    .filter((ref) => ref.name.startsWith(TAG_PREFIX))
    .map((ref) => {
      const peeledSha = advertisement.peeled.get(ref.name);
      return {
        name: ref.name.slice(TAG_PREFIX.length),
        // Peeled entries exist only for annotated tags and carry the commit SHA.
        sha: peeledSha ?? ref.sha,
        isAnnotated: peeledSha !== undefined,
        raw: peeledSha === undefined ? ref : { ...ref, peeledSha },
      };
    });
}

function mapError(_status: number, body: unknown): ProviderErrorInfo {
  const text = typeof body === 'string' ? body.trim() : '';
  return {
    message: text && text.length <= 200 ? `git-http request failed: ${text}` : undefined,
  };
}

export function gitHttp(options: GitHttpProviderOptions = {}): RepoProvider {
  const fetchImpl = options.fetch ?? fetch;
  const auth = options.auth;
  const username = auth?.username || DEFAULT_USERNAME;
  // Remote URLs whose anonymous request was rejected with a 401; credentialed
  // from then on, and reported as `private` by getRepository.
  const authRequired = new Set<string>();

  let lastSecret: string | undefined = auth && 'password' in auth ? auth.password : undefined;
  async function currentSecret(forceRefresh: boolean): Promise<string> {
    if (auth === undefined || 'password' in auth) return lastSecret ?? '';
    lastSecret = await auth.tokenProvider({ forceRefresh });
    return lastSecret;
  }

  function httpFor(repoUrl: string): HttpClient {
    return new HttpClient({
      provider: 'git-http',
      baseUrl: repoUrl,
      fetchImpl,
      // Anonymous-first, like the git CLI: credentials are attached only once
      // the remote has answered 401. `forceRefresh` marks the retry after a
      // 401 — an upgrade from anonymous, or a token refresh when the failed
      // attempt already carried credentials.
      authHeaders: async ({ forceRefresh }): Promise<Record<string, string>> => {
        if (!auth) return {};
        const hadAuth = authRequired.has(repoUrl);
        if (!forceRefresh && !hadAuth) return {};
        authRequired.add(repoUrl);
        const secret = await currentSecret(forceRefresh && hadAuth);
        return { Authorization: `Basic ${stringToBase64(`${username}:${secret}`)}` };
      },
      mapError,
      secrets: () => (lastSecret === undefined ? [] : [lastSecret]),
      retryUnauthorized: auth !== undefined,
    });
  }

  async function fetchAdvertisement(
    repoUrl: string,
    signal?: AbortSignal,
  ): Promise<RefAdvertisement> {
    const response = await httpFor(repoUrl).raw(`${repoUrl}/info/refs`, {
      query: { service: 'git-upload-pack' },
      signal,
    });
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.startsWith(ADVERTISEMENT_CONTENT_TYPE)) {
      fail(
        'provider_error',
        'Remote is not a git smart-HTTP endpoint (unexpected info/refs content type)',
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return parseAdvertisement(parsePktLines(bytes));
  }

  function paginate<T>(
    repoUrl: string,
    items: T[],
    params: { cursor?: string; limit?: number },
  ): Page<T> {
    let offset = 0;
    if (params.cursor !== undefined) {
      const state = decodeCursor<CursorState>('git-http', params.cursor);
      if (state.u !== repoUrl) {
        fail('validation', 'Pagination cursor belongs to a different repository');
      }
      offset = state.o;
    }
    const limit = clampPerPage(params.limit);
    const data = limit === undefined ? items.slice(offset) : items.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return {
      data,
      cursor:
        nextOffset < items.length
          ? encodeCursor('git-http', { u: repoUrl, o: nextOffset } satisfies CursorState)
          : undefined,
    };
  }

  return {
    name: 'git-http',
    capabilities: CAPABILITIES,

    async getAuthenticatedUser() {
      throw unsupported('resolving the authenticated user');
    },

    async listNamespaces() {
      throw unsupported('namespace discovery');
    },

    async listRepositories() {
      throw unsupported('repository discovery');
    },

    async getRepository(params: GetRepositoryParams): Promise<Repository> {
      const repoUrl = normalizeRepoUrl(params.repo);
      const advertisement = await fetchAdvertisement(repoUrl, params.signal);
      const url = new URL(repoUrl);
      const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '');
      const segments = path.split('/').filter(Boolean);
      const head = advertisement.symrefs.get('HEAD');
      let defaultBranch = head?.startsWith(BRANCH_PREFIX)
        ? head.slice(BRANCH_PREFIX.length)
        : undefined;
      if (defaultBranch === undefined) {
        // Old servers omit the symref capability; fall back to the branch
        // matching HEAD's SHA when it is unambiguous — the git CLI's guess.
        const headSha = advertisement.refs.find((ref) => ref.name === 'HEAD')?.sha;
        const matches = branchesOf(advertisement).filter((branch) => branch.sha === headSha);
        if (headSha !== undefined && matches.length === 1) {
          defaultBranch = matches[0]!.name;
        }
      }
      return {
        id: repoUrl,
        name: segments.at(-1) ?? url.host,
        path,
        namespace: segments.slice(0, -1).join('/'),
        defaultBranch,
        // Whether the remote rejected anonymous access — readable-by-anyone
        // is the only privacy signal a raw remote exposes.
        private: authRequired.has(repoUrl),
        urls: {
          web: repoUrl.replace(/\.git$/, ''),
          cloneHttp: repoUrl,
        },
        raw: {
          refs: advertisement.refs,
          peeled: Object.fromEntries(advertisement.peeled),
          capabilities: advertisement.capabilities,
        },
      };
    },

    async listCommits() {
      throw unsupported('commit history');
    },

    async getCommit() {
      throw unsupported('commit lookup');
    },

    async listTags(params: ListTagsParams): Promise<Page<Tag>> {
      const repoUrl = normalizeRepoUrl(params.repo);
      const advertisement = await fetchAdvertisement(repoUrl, params.signal);
      return paginate(repoUrl, tagsOf(advertisement), params);
    },

    async listBranches(params: ListBranchesParams): Promise<Page<Branch>> {
      const repoUrl = normalizeRepoUrl(params.repo);
      const advertisement = await fetchAdvertisement(repoUrl, params.signal);
      return paginate(repoUrl, branchesOf(advertisement), params);
    },

    async searchRefs(params: ProviderSearchRefsParams): Promise<RefMatch[]> {
      const repoUrl = normalizeRepoUrl(params.repo);
      const advertisement = await fetchAdvertisement(repoUrl, params.signal);
      const matches: RefMatch[] = [];
      for (const type of ['branch', 'tag'] as const) {
        if (!params.types.includes(type)) continue;
        const prefix = type === 'branch' ? BRANCH_PREFIX : TAG_PREFIX;
        for (const ref of advertisement.refs) {
          if (!ref.name.startsWith(prefix)) continue;
          const name = ref.name.slice(prefix.length);
          if (!name.startsWith(params.query)) continue;
          matches.push({ type, name, sha: ref.sha, raw: ref });
        }
      }
      return matches.slice(0, params.limit);
    },

    async downloadArchive(): Promise<never> {
      throw unsupported('archive downloads');
    },

    async getCloneUrl(params: GetCloneUrlParams): Promise<CloneUrl> {
      const repoUrl = normalizeRepoUrl(params.repo);
      if (!auth) return { url: repoUrl };
      const url = new URL(repoUrl);
      url.username = username;
      url.password = await currentSecret(false);
      return { url: url.toString() };
    },

    async createWebhook(): Promise<never> {
      throw unsupported('webhooks');
    },

    async listWebhooks(): Promise<never> {
      throw unsupported('webhooks');
    },

    async getWebhook(): Promise<never> {
      throw unsupported('webhooks');
    },

    async updateWebhook(): Promise<never> {
      throw unsupported('webhooks');
    },

    async deleteWebhook(): Promise<never> {
      throw unsupported('webhooks');
    },
  };
}

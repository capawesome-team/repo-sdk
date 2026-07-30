import { createAppJwt } from './app-auth.ts';
import { API_VERSION, DEFAULT_BASE_URL, mapError, nextCursor, USER_AGENT } from './common.ts';
import { HttpClient } from '../../http.ts';
import { assertSameOriginUrl, decodeCursor } from '../../pagination.ts';
import { clampPerPage } from '../shared.ts';
import type { Page } from '../../types.ts';

export interface ListUserInstallationsParams {
  /**
   * A user access token — e.g. the OAuth token minted by the GitHub App web
   * login flow. Installation tokens cannot call this endpoint.
   */
  token: string;
  /** GHES API root (`/api/v3`); defaults to `https://api.github.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ListInstallationRequestsParams {
  /** The GitHub App id the installation requests belong to. */
  appId: string | number;
  /** PEM-encoded private key of the app, used to sign the app JWT. */
  privateKey: string;
  /** GHES API root (`/api/v3`); defaults to `https://api.github.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface GitHubInstallationAccount {
  id: string;
  login: string;
  kind: 'user' | 'organization';
  avatarUrl?: string;
}

export interface GitHubUserInstallation {
  id: string;
  /** Account the app is installed on; absent for enterprise-level installations. */
  account?: GitHubInstallationAccount;
  raw: unknown;
}

export interface GitHubInstallationRequest {
  id: string;
  /** Account (organization or user) the installation was requested for. */
  account?: GitHubInstallationAccount;
  /** ISO 8601 timestamp of when the request was created. */
  createdAt: string;
  /** User who requested the installation. */
  requester?: GitHubInstallationAccount;
  raw: unknown;
}

interface GitHubAccountPayload {
  id: number;
  login?: string;
  type?: string;
  avatar_url?: string;
}

interface GitHubInstallationPayload {
  id: number;
  account?: GitHubAccountPayload | null;
}

interface GitHubInstallationRequestPayload {
  id: number;
  account?: GitHubAccountPayload | null;
  created_at: string;
  requester?: GitHubAccountPayload | null;
}

function toAccount(payload?: GitHubAccountPayload | null): GitHubInstallationAccount | undefined {
  if (payload?.login === undefined) return undefined;
  return {
    id: String(payload.id),
    login: payload.login,
    kind: payload.type === 'Organization' ? 'organization' : 'user',
    avatarUrl: payload.avatar_url,
  };
}

function toInstallation(payload: GitHubInstallationPayload): GitHubUserInstallation {
  return {
    id: String(payload.id),
    account: toAccount(payload.account),
    raw: payload,
  };
}

function toInstallationRequest(
  payload: GitHubInstallationRequestPayload,
): GitHubInstallationRequest {
  return {
    id: String(payload.id),
    account: toAccount(payload.account),
    createdAt: payload.created_at,
    requester: toAccount(payload.requester),
    raw: payload,
  };
}

interface ListPageParams {
  baseUrl?: string;
  fetch?: typeof fetch;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}

async function listPage<TPayload, TItem>(
  bearer: string,
  defaultPath: string,
  params: ListPageParams,
  toItems: (payload: TPayload) => TItem[],
): Promise<Page<TItem>> {
  const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
  const http = new HttpClient({
    provider: 'github',
    baseUrl,
    fetchImpl: params.fetch,
    authHeaders: () => ({
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    }),
    mapError,
    secrets: () => [bearer],
  });

  let path = defaultPath;
  let query: { per_page: number | undefined } | undefined;
  if (params.cursor) {
    const { url } = decodeCursor<{ url: string }>('github', params.cursor);
    path = assertSameOriginUrl('github', baseUrl, url);
  } else {
    query = { per_page: clampPerPage(params.limit) };
  }
  const { data, response } = await http.json<TPayload>(path, { query, signal: params.signal });
  return { data: toItems(data), cursor: nextCursor(response) };
}

/**
 * Lists the GitHub App installations the given user can access
 * (`GET /user/installations`). Standalone by design: the endpoint requires a
 * user access token, a different credential from the installation token the
 * `github` provider authenticates its requests with.
 */
export async function listUserInstallations(
  params: ListUserInstallationsParams,
): Promise<Page<GitHubUserInstallation>> {
  return listPage<{ installations?: GitHubInstallationPayload[] }, GitHubUserInstallation>(
    params.token,
    '/user/installations',
    params,
    (payload) => (payload.installations ?? []).map(toInstallation),
  );
}

/**
 * Lists the pending installation requests of a GitHub App
 * (`GET /app/installation-requests`) — installations an organization owner has
 * yet to approve. Standalone by design: the endpoint is authenticated with an
 * app JWT, a different credential from the installation token the `github`
 * provider authenticates its requests with.
 */
export async function listInstallationRequests(
  params: ListInstallationRequestsParams,
): Promise<Page<GitHubInstallationRequest>> {
  const jwt = await createAppJwt({ appId: params.appId, privateKey: params.privateKey });
  return listPage<GitHubInstallationRequestPayload[], GitHubInstallationRequest>(
    jwt,
    '/app/installation-requests',
    params,
    (payload) => payload.map(toInstallationRequest),
  );
}

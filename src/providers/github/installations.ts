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

interface GitHubInstallationPayload {
  id: number;
  account?: { id: number; login?: string; type?: string; avatar_url?: string } | null;
}

function toInstallation(payload: GitHubInstallationPayload): GitHubUserInstallation {
  const account = payload.account;
  return {
    id: String(payload.id),
    account:
      account?.login === undefined
        ? undefined
        : {
            id: String(account.id),
            login: account.login,
            kind: account.type === 'Organization' ? 'organization' : 'user',
            avatarUrl: account.avatar_url,
          },
    raw: payload,
  };
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
  const { token } = params;
  const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
  const http = new HttpClient({
    provider: 'github',
    baseUrl,
    fetchImpl: params.fetch,
    authHeaders: () => ({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      'User-Agent': USER_AGENT,
    }),
    mapError,
    secrets: () => [token],
  });

  let path = '/user/installations';
  let query: { per_page: number | undefined } | undefined;
  if (params.cursor) {
    const { url } = decodeCursor<{ url: string }>('github', params.cursor);
    path = assertSameOriginUrl('github', baseUrl, url);
  } else {
    query = { per_page: clampPerPage(params.limit) };
  }
  const { data, response } = await http.json<{ installations?: GitHubInstallationPayload[] }>(
    path,
    { query, signal: params.signal },
  );
  return { data: (data.installations ?? []).map(toInstallation), cursor: nextCursor(response) };
}

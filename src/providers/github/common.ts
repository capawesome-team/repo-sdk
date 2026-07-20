import type { RepoErrorCode } from '../../errors.ts';
import type { ProviderErrorInfo } from '../../http.ts';
import { encodeCursor } from '../../pagination.ts';
import { isRecord, parseLinkNext } from '../shared.ts';

export const DEFAULT_BASE_URL = 'https://api.github.com';
export const API_VERSION = '2022-11-28';
export const USER_AGENT = 'repo-sdk';

export function mapError(status: number, body: unknown, response: Response): ProviderErrorInfo {
  const message = isRecord(body) && typeof body.message === 'string' ? body.message : undefined;
  let code: RepoErrorCode | undefined;
  if (status === 429 || (status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    code = 'rate_limited';
  }
  return { code, message };
}

export function nextCursor(response: Response): string | undefined {
  const next = parseLinkNext(response.headers.get('link'));
  return next === undefined ? undefined : encodeCursor('github', { url: next });
}

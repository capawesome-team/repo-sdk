import { base64UrlToString, stringToBase64Url } from './base64.ts';
import { RepoError } from './errors.ts';
import type { ProviderName } from './types.ts';

interface CursorEnvelope<T> {
  p: ProviderName;
  s: T;
}

export function encodeCursor<T>(provider: ProviderName, state: T): string {
  return stringToBase64Url(JSON.stringify({ p: provider, s: state } satisfies CursorEnvelope<T>));
}

export function decodeCursor<T>(provider: ProviderName, cursor: string): T {
  let envelope: CursorEnvelope<T>;
  try {
    envelope = JSON.parse(base64UrlToString(cursor)) as CursorEnvelope<T>;
  } catch (error) {
    throw new RepoError('Invalid pagination cursor', {
      code: 'validation',
      provider,
      cause: error,
    });
  }
  if (envelope.p !== provider) {
    throw new RepoError(
      `Pagination cursor belongs to provider "${envelope.p}", not "${provider}"`,
      {
        code: 'validation',
        provider,
      },
    );
  }
  return envelope.s;
}

/**
 * Guard for cursors that carry a next-page URL. Providers whose pagination
 * follows an absolute URL from a response header (GitHub/GitLab `Link`,
 * Bitbucket `next`) must route it through here before fetching, so a forged
 * cursor cannot redirect the authenticated request — and its bearer token —
 * to an arbitrary host. The decoded URL must share an origin with `baseUrl`.
 */
export function assertSameOriginUrl(provider: ProviderName, baseUrl: string, url: string): string {
  let target: URL;
  try {
    target = new URL(url);
  } catch (error) {
    throw new RepoError('Invalid pagination cursor URL', {
      code: 'validation',
      provider,
      cause: error,
    });
  }
  if (target.origin !== new URL(baseUrl).origin) {
    throw new RepoError('Pagination cursor points to an unexpected host', {
      code: 'validation',
      provider,
    });
  }
  return url;
}

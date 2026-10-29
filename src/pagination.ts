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
  let envelope: unknown;
  try {
    envelope = JSON.parse(base64UrlToString(cursor));
  } catch (error) {
    throw new RepoError('Invalid pagination cursor', {
      code: 'validation',
      provider,
      cause: error,
    });
  }
  if (!isEnvelope(envelope)) {
    throw new RepoError('Invalid pagination cursor', { code: 'validation', provider });
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
  return envelope.s as T;
}

// Every provider stores its page state as an object, so anything else is not a cursor this
// package issued.
function isEnvelope(value: unknown): value is CursorEnvelope<object> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { p?: unknown }).p === 'string' &&
    typeof (value as { s?: unknown }).s === 'object' &&
    (value as { s?: unknown }).s !== null
  );
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

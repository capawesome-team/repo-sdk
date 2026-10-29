import type { TokenProvider } from './types.ts';

/**
 * Carries an error thrown by the caller's own `tokenProvider` through the provider, so the client
 * rethrows the caller's error untouched instead of reporting a provider response it could not read.
 */
export class TokenProviderError extends Error {
  constructor(cause: unknown) {
    super('tokenProvider failed', { cause });
    this.name = 'TokenProviderError';
  }
}

export async function mintToken(
  auth: { tokenProvider: TokenProvider },
  context: { forceRefresh: boolean },
): Promise<string> {
  try {
    return await auth.tokenProvider(context);
  } catch (error) {
    throw new TokenProviderError(error);
  }
}

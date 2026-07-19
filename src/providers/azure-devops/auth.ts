export const API_VERSION = '7.1';

/**
 * Username the SDK registers for a service hook's HTTP Basic auth (the secret is
 * the password). Shared by the provider and its webhook verifier so both sides
 * agree on the value.
 */
export const BASIC_AUTH_USERNAME = 'repo-sdk';

/**
 * Azure DevOps supports two credential shapes: a Personal Access Token (encoded
 * into HTTP Basic auth internally) or a pluggable Entra ID `tokenProvider` that
 * mints short-lived bearer tokens. Callers pass whichever they have.
 */
export type AzureDevOpsAuth = { pat: string } | { tokenProvider: () => Promise<string> };

export function authHeader(auth: AzureDevOpsAuth): Promise<string> {
  if ('pat' in auth) {
    return Promise.resolve(`Basic ${btoa(':' + auth.pat)}`);
  }
  return auth.tokenProvider().then((token) => `Bearer ${token}`);
}

export function authSecrets(auth: AzureDevOpsAuth): string[] {
  return 'pat' in auth ? [auth.pat] : [];
}

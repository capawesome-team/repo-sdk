import { bytesToBase64Url } from '../../base64.ts';
import { codeFromStatus, RepoError } from '../../errors.ts';

/**
 * Indirection over the credential used for every request. Token auth resolves a
 * static value; the GitHub App token manager implements the same shape to mint
 * and refresh installation tokens without touching call sites.
 */
export interface TokenSource {
  /**
   * Discriminates the credential flavour so call sites can route around
   * user-scoped endpoints (`/user`, `/user/repos`, …) that installation
   * tokens cannot access.
   */
  readonly kind: 'token' | 'app';
  /** `forceRefresh` bypasses any cache; set on the single retry after a 401. */
  getToken(forceRefresh?: boolean): Promise<string>;
  getTokenWithExpiry(): Promise<TokenWithExpiry>;
  getSecrets(): string[];
}

export interface TokenWithExpiry {
  token: string;
  expiresAt?: Date;
}

export interface AppTokenSourceOptions {
  appId: string | number;
  privateKey: string;
  installationId?: string | number;
  owner?: string;
  baseUrl: string;
  fetchImpl: typeof fetch;
  apiVersion: string;
  userAgent: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

interface AccessTokenResponse {
  token: string;
  expires_at: string;
}

interface Installation {
  id: number;
}

// rsaEncryption AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }.
const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
];
// PrivateKeyInfo version INTEGER 0.
const PKCS8_VERSION = [0x02, 0x01, 0x00];

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

/** Definite-form DER length: short-form for <= 127, long-form otherwise. */
function encodeLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>>= 8) {
    bytes.unshift(value & 0xff);
  }
  return [0x80 | bytes.length, ...bytes];
}

function pemToDer(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const pkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const der = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    der[index] = binary.charCodeAt(index);
  }
  return { der, pkcs1 };
}

/** Wrap a PKCS#1 RSAPrivateKey in a minimal PKCS#8 PrivateKeyInfo envelope. */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  const octetString = [0x04, ...encodeLength(pkcs1.length), ...pkcs1];
  const body = [...PKCS8_VERSION, ...RSA_ALGORITHM_IDENTIFIER, ...octetString];
  return Uint8Array.from([0x30, ...encodeLength(body.length), ...body]);
}

function importPrivateKey(pem: string): Promise<CryptoKey> {
  const { der, pkcs1 } = pemToDer(pem);
  const pkcs8 = pkcs1 ? wrapPkcs1InPkcs8(der) : der;
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8 as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

const encoder = new TextEncoder();

function base64UrlJson(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
}

async function createJwt(key: CryptoKey, appId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 540, iss: appId });
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/**
 * Mints and caches GitHub App installation access tokens. A short-lived RS256
 * JWT (signed with the app private key) authenticates the app-level calls that
 * resolve the installation and mint installation tokens; the installation token
 * is cached and refreshed once it nears expiry. A fresh JWT is minted per token
 * refresh (cheap, and refreshes are rare given the ~1h token TTL).
 */
export class AppTokenSource implements TokenSource {
  readonly kind = 'app';
  private readonly appId: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiVersion: string;
  private readonly userAgent: string;
  private installationId?: string;
  private readonly owner?: string;
  private keyPromise?: Promise<CryptoKey>;
  private cached?: InstallationToken;
  private refresh?: Promise<InstallationToken>;

  constructor(options: AppTokenSourceOptions) {
    if (options.installationId !== undefined && options.owner !== undefined) {
      throw new RepoError('GitHub App auth accepts either installationId or owner, not both', {
        code: 'validation',
        provider: 'github',
      });
    }
    this.appId = String(options.appId);
    this.privateKey = options.privateKey;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.apiVersion = options.apiVersion;
    this.userAgent = options.userAgent;
    this.installationId =
      options.installationId === undefined ? undefined : String(options.installationId);
    this.owner = options.owner;
  }

  async getToken(): Promise<string> {
    return (await this.resolveToken()).token;
  }

  async getTokenWithExpiry(): Promise<TokenWithExpiry> {
    const { token, expiresAt } = await this.resolveToken();
    return { token, expiresAt };
  }

  /** Current installation token (minted on demand), for use outside the SDK. */
  async getInstallationToken(): Promise<InstallationToken> {
    const { token, expiresAt } = await this.resolveToken();
    return { token, expiresAt };
  }

  getSecrets(): string[] {
    return this.cached ? [this.cached.token] : [];
  }

  private resolveToken(): Promise<InstallationToken> {
    if (this.cached && this.cached.expiresAt.getTime() - Date.now() > REFRESH_THRESHOLD_MS) {
      return Promise.resolve(this.cached);
    }
    if (!this.refresh) {
      this.refresh = this.mintInstallationToken().finally(() => {
        this.refresh = undefined;
      });
    }
    return this.refresh;
  }

  private async mintInstallationToken(): Promise<InstallationToken> {
    const jwt = await this.createAppJwt();
    const installationId = await this.resolveInstallationId(jwt);
    const data = await this.appRequest<AccessTokenResponse>(
      `/app/installations/${installationId}/access_tokens`,
      'POST',
      jwt,
    );
    const token: InstallationToken = { token: data.token, expiresAt: new Date(data.expires_at) };
    this.cached = token;
    return token;
  }

  private async resolveInstallationId(jwt: string): Promise<string> {
    if (this.installationId !== undefined) return this.installationId;
    this.installationId =
      this.owner === undefined
        ? await this.lookupSingleInstallation(jwt)
        : await this.lookupOwnerInstallation(jwt, this.owner);
    return this.installationId;
  }

  /**
   * Resolves the installation on a specific account. An owner name alone does
   * not reveal whether it is an organization or a user, so we probe the org
   * endpoint first (the common case for GitHub Apps) and fall back to the user
   * endpoint on 404.
   */
  private async lookupOwnerInstallation(jwt: string, owner: string): Promise<string> {
    const encoded = encodeURIComponent(owner);
    for (const path of [`/orgs/${encoded}/installation`, `/users/${encoded}/installation`]) {
      try {
        const installation = await this.appRequest<Installation>(path, 'GET', jwt);
        return String(installation.id);
      } catch (error) {
        if (!(error instanceof RepoError) || error.code !== 'not_found') throw error;
      }
    }
    throw new RepoError(`GitHub App is not installed for owner "${owner}"`, {
      code: 'not_found',
      provider: 'github',
    });
  }

  private async lookupSingleInstallation(jwt: string): Promise<string> {
    const installations = await this.appRequest<Installation[]>('/app/installations', 'GET', jwt);
    if (installations.length === 0) {
      throw new RepoError('GitHub App is not installed anywhere', {
        code: 'unauthorized',
        provider: 'github',
      });
    }
    if (installations.length > 1) {
      throw new RepoError(
        'GitHub App has multiple installations; pass installationId to select one',
        { code: 'validation', provider: 'github' },
      );
    }
    return String(installations[0]!.id);
  }

  private createAppJwt(): Promise<string> {
    if (!this.keyPromise) {
      this.keyPromise = importPrivateKey(this.privateKey);
    }
    return this.keyPromise.then((key) => createJwt(key, this.appId));
  }

  private async appRequest<T>(path: string, method: string, jwt: string): Promise<T> {
    const url = joinUrl(this.baseUrl, path);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': this.apiVersion,
          'User-Agent': this.userAgent,
        },
      });
    } catch (error) {
      throw new RepoError(`Request to ${path} failed`, {
        code: 'network_error',
        provider: 'github',
        cause: error,
        secrets: this.getSecrets(),
      });
    }
    if (!response.ok) {
      throw await this.toError(response);
    }
    return (await response.json()) as T;
  }

  private async toError(response: Response): Promise<RepoError> {
    const text = await response.text().catch(() => '');
    let message: string | undefined;
    try {
      const body = JSON.parse(text) as unknown;
      if (
        body &&
        typeof body === 'object' &&
        typeof (body as { message?: unknown }).message === 'string'
      ) {
        message = (body as { message: string }).message;
      }
    } catch {
      // keep the default message
    }
    return new RepoError(message ?? `github request failed with status ${response.status}`, {
      code: codeFromStatus(response.status),
      provider: 'github',
      status: response.status,
      secrets: this.getSecrets(),
    });
  }
}

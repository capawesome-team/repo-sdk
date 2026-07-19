import { beforeAll, describe, expect, it } from 'vitest';
import { github } from '../../src/github.ts';
import { RepoError } from '../../src/errors.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const APP_ID = 12345;
const INSTALLATION_TOKEN = 'ghs_installationtoken';

const repoPayload = {
  id: 42,
  name: 'repo-sdk',
  full_name: 'capawesome-team/repo-sdk',
  owner: { login: 'capawesome-team' },
  private: true,
};

let pkcs8Pem: string;
let pkcs1Pem: string;
let publicKey: CryptoKey;

function toPem(der: Uint8Array, label: string): string {
  const base64 = btoa(String.fromCharCode(...der));
  const lines = base64.match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

function readTlv(bytes: Uint8Array, offset: number): { contentStart: number; end: number } {
  let length = bytes[offset + 1]!;
  let headerLength = 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let index = 0; index < count; index++) {
      length = (length << 8) | bytes[offset + 2 + index]!;
    }
    headerLength = 2 + count;
  }
  return { contentStart: offset + headerLength, end: offset + headerLength + length };
}

/** Extract the inner PKCS#1 RSAPrivateKey from a PKCS#8 PrivateKeyInfo. */
function pkcs8ToPkcs1(pkcs8: Uint8Array): Uint8Array {
  const outer = readTlv(pkcs8, 0);
  const version = readTlv(pkcs8, outer.contentStart);
  const algId = readTlv(pkcs8, version.end);
  const octet = readTlv(pkcs8, algId.end);
  return pkcs8.slice(octet.contentStart, octet.end);
}

function b64urlToBytes(segment: string): Uint8Array {
  let base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function decodeJwt(token: string): {
  header: unknown;
  payload: { iat: number; exp: number; iss: string };
} {
  const [header, payload] = token.split('.');
  const decode = (segment: string): unknown =>
    JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
  return {
    header: decode(header!),
    payload: decode(payload!) as { iat: number; exp: number; iss: string },
  };
}

beforeAll(async () => {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  publicKey = keyPair.publicKey;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
  pkcs8Pem = toPem(pkcs8, 'PRIVATE KEY');
  pkcs1Pem = toPem(pkcs8ToPkcs1(pkcs8), 'RSA PRIVATE KEY');
});

interface AppHandlerOptions {
  installations?: { id: number }[];
  expiresAt?: string;
  token?: string;
}

function futureIso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

function appHandler(options: AppHandlerOptions = {}): StubHandler {
  const installations = options.installations ?? [{ id: 99 }];
  const expiresAt = options.expiresAt ?? futureIso(60 * 60 * 1000);
  const token = options.token ?? INSTALLATION_TOKEN;
  return (request) => {
    const url = new URL(request.url);
    if (url.pathname === '/app/installations') return { json: installations };
    if (url.pathname.endsWith('/access_tokens')) return { json: { token, expires_at: expiresAt } };
    return { json: repoPayload };
  };
}

function setup(
  handler: StubHandler,
  auth: { privateKey: string; installationId?: string | number },
  baseUrl?: string,
) {
  const stub = createFetchStub(handler);
  const provider = github({
    auth: { appId: APP_ID, privateKey: auth.privateKey, installationId: auth.installationId },
    fetch: stub.fetch,
    baseUrl,
  });
  return { provider, stub };
}

async function expectRepoError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable('expected RepoError');
  } catch (error) {
    expect(error).toBeInstanceOf(RepoError);
    expect((error as RepoError).code).toBe(code);
  }
}

describe('GitHub App auth', () => {
  it('mints a JWT-authenticated installation token and uses it for API calls', async () => {
    const { provider, stub } = setup(appHandler(), { privateKey: pkcs8Pem, installationId: 99 });
    const repo = await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(repo.path).toBe('capawesome-team/repo-sdk');

    const mintRequest = stub.requests.find((r) => r.url.endsWith('/access_tokens'))!;
    expect(new URL(mintRequest.url).pathname).toBe('/app/installations/99/access_tokens');
    expect(mintRequest.method).toBe('POST');

    const jwt = mintRequest.headers.authorization!.replace('Bearer ', '');
    const { header, payload } = decodeJwt(jwt);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(payload.iss).toBe(String(APP_ID));
    expect(payload.exp - payload.iat).toBe(600);
    const now = Math.floor(Date.now() / 1000);
    expect(Math.abs(payload.iat - (now - 60))).toBeLessThanOrEqual(10);

    const apiRequest = stub.requests.find(
      (r) => new URL(r.url).pathname === '/repos/capawesome-team/repo-sdk',
    )!;
    expect(apiRequest.headers.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
  });

  it('produces a JWT verifiable with the app public key', async () => {
    const { provider, stub } = setup(appHandler(), { privateKey: pkcs8Pem, installationId: 99 });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    const jwt = stub.requests[0]!.headers.authorization!.replace('Bearer ', '');
    const [header, payload, signature] = jwt.split('.');
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      b64urlToBytes(signature!) as BufferSource,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it('imports a PKCS#1 (BEGIN RSA PRIVATE KEY) private key', async () => {
    const { provider, stub } = setup(appHandler(), { privateKey: pkcs1Pem, installationId: 99 });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    const jwt = stub.requests[0]!.headers.authorization!.replace('Bearer ', '');
    const [header, payload, signature] = jwt.split('.');
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      b64urlToBytes(signature!) as BufferSource,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it('caches the installation token across calls', async () => {
    const { provider, stub } = setup(appHandler(), { privateKey: pkcs8Pem, installationId: 99 });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    const mints = stub.requests.filter((r) => r.url.endsWith('/access_tokens'));
    expect(mints).toHaveLength(1);
  });

  it('re-mints when the cached token is near expiry', async () => {
    const { provider, stub } = setup(appHandler({ expiresAt: futureIso(60 * 1000) }), {
      privateKey: pkcs8Pem,
      installationId: 99,
    });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    const mints = stub.requests.filter((r) => r.url.endsWith('/access_tokens'));
    expect(mints).toHaveLength(2);
  });

  it('shares one in-flight refresh across concurrent callers', async () => {
    const { provider, stub } = setup(appHandler(), { privateKey: pkcs8Pem, installationId: 99 });
    await Promise.all([
      provider.getRepository({ repo: 'capawesome-team/repo-sdk' }),
      provider.getRepository({ repo: 'capawesome-team/repo-sdk' }),
    ]);
    const mints = stub.requests.filter((r) => r.url.endsWith('/access_tokens'));
    expect(mints).toHaveLength(1);
  });

  it('auto-resolves a single installation when installationId is absent', async () => {
    const { provider, stub } = setup(appHandler({ installations: [{ id: 777 }] }), {
      privateKey: pkcs8Pem,
    });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });

    const listRequest = stub.requests.find(
      (r) => new URL(r.url).pathname === '/app/installations',
    )!;
    expect(listRequest.headers.authorization).toMatch(/^Bearer /);
    const mintRequest = stub.requests.find((r) => r.url.endsWith('/access_tokens'))!;
    expect(new URL(mintRequest.url).pathname).toBe('/app/installations/777/access_tokens');
  });

  it('caches the auto-resolved installation id', async () => {
    const { provider, stub } = setup(
      appHandler({ installations: [{ id: 777 }], expiresAt: futureIso(60 * 1000) }),
      {
        privateKey: pkcs8Pem,
      },
    );
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    const listRequests = stub.requests.filter(
      (r) => new URL(r.url).pathname === '/app/installations',
    );
    expect(listRequests).toHaveLength(1);
  });

  it('rejects multiple installations with a validation error', async () => {
    const { provider } = setup(appHandler({ installations: [{ id: 1 }, { id: 2 }] }), {
      privateKey: pkcs8Pem,
    });
    await expectRepoError(
      provider.getRepository({ repo: 'capawesome-team/repo-sdk' }),
      'validation',
    );
  });

  it('rejects zero installations with an unauthorized error', async () => {
    const { provider } = setup(appHandler({ installations: [] }), { privateKey: pkcs8Pem });
    await expectRepoError(
      provider.getRepository({ repo: 'capawesome-team/repo-sdk' }),
      'unauthorized',
    );
  });

  it('embeds the installation token and expiry in the clone URL', async () => {
    const expiresAt = futureIso(60 * 60 * 1000);
    const { provider } = setup(appHandler({ expiresAt }), {
      privateKey: pkcs8Pem,
      installationId: 99,
    });
    const clone = await provider.getCloneUrl({ repo: 'capawesome-team/repo-sdk' });
    expect(clone.url).toBe(
      `https://x-access-token:${INSTALLATION_TOKEN}@github.com/capawesome-team/repo-sdk.git`,
    );
    expect(clone.expiresAt).toBeInstanceOf(Date);
    expect(clone.expiresAt!.toISOString()).toBe(expiresAt);
  });
});

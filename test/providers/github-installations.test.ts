import { beforeAll, describe, expect, it } from 'vitest';
import { listInstallationRequests, listUserInstallations } from '../../src/github.ts';
import { RepoError } from '../../src/errors.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const TOKEN = 'gho_usertoken';
const APP_ID = 12345;

const installationsPayload = {
  total_count: 2,
  installations: [
    {
      id: 101,
      account: { id: 1, login: 'robingenz', type: 'User', avatar_url: 'https://a.test/u.png' },
    },
    { id: 202, account: { id: 2, login: 'capawesome-team', type: 'Organization' } },
  ],
};

function setup(handler: StubHandler) {
  const stub = createFetchStub(handler);
  return {
    stub,
    list: (params: { limit?: number; cursor?: string; baseUrl?: string } = {}) =>
      listUserInstallations({ token: TOKEN, fetch: stub.fetch, ...params }),
  };
}

describe('listUserInstallations', () => {
  it('lists and normalizes the user installations', async () => {
    const { stub, list } = setup(() => ({ json: installationsPayload }));
    const page = await list();

    const request = stub.requests[0]!;
    const url = new URL(request.url);
    expect(url.origin).toBe('https://api.github.com');
    expect(url.pathname).toBe('/user/installations');
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.accept).toBe('application/vnd.github+json');
    expect(request.headers['x-github-api-version']).toBe('2022-11-28');
    expect(request.headers['user-agent']).toBe('repo-sdk');

    expect(page.cursor).toBeUndefined();
    expect(page.data).toEqual([
      {
        id: '101',
        account: { id: '1', login: 'robingenz', kind: 'user', avatarUrl: 'https://a.test/u.png' },
        raw: installationsPayload.installations[0],
      },
      {
        id: '202',
        account: { id: '2', login: 'capawesome-team', kind: 'organization', avatarUrl: undefined },
        raw: installationsPayload.installations[1],
      },
    ]);
  });

  it('passes limit as per_page', async () => {
    const { stub, list } = setup(() => ({ json: installationsPayload }));
    await list({ limit: 5 });
    expect(new URL(stub.requests[0]!.url).searchParams.get('per_page')).toBe('5');
  });

  it('paginates via Link-header cursors', async () => {
    const nextUrl = 'https://api.github.com/user/installations?page=2';
    const { stub, list } = setup((request) =>
      new URL(request.url).searchParams.get('page') === '2'
        ? { json: installationsPayload }
        : {
            json: { total_count: 3, installations: [] },
            headers: { link: `<${nextUrl}>; rel="next"` },
          },
    );

    const first = await list();
    expect(first.cursor).toBeDefined();

    const second = await list({ cursor: first.cursor });
    expect(stub.requests[1]!.url).toBe(nextUrl);
    expect(second.data).toHaveLength(2);
    expect(second.cursor).toBeUndefined();
  });

  it('rejects a cursor pointing at a different origin', async () => {
    const nextUrl = 'https://evil.test/user/installations?page=2';
    const { list } = setup(() => ({
      json: installationsPayload,
      headers: { link: `<${nextUrl}>; rel="next"` },
    }));
    const { cursor } = await list();
    await expect(list({ cursor })).rejects.toMatchObject({ code: 'validation' });
  });

  it('handles a missing installations array', async () => {
    const { list } = setup(() => ({ json: { total_count: 0 } }));
    const page = await list();
    expect(page.data).toEqual([]);
  });

  it('omits the account for enterprise-level installations', async () => {
    const { list } = setup(() => ({
      json: { total_count: 1, installations: [{ id: 303, account: null }] },
    }));
    const page = await list();
    expect(page.data).toEqual([{ id: '303', account: undefined, raw: { id: 303, account: null } }]);
  });

  it('maps HTTP failures to RepoError with the token redacted', async () => {
    const { list } = setup(() => ({
      status: 401,
      json: { message: `Bad credentials for ${TOKEN}` },
    }));
    try {
      await list();
      expect.unreachable('expected RepoError');
    } catch (error) {
      expect(error).toBeInstanceOf(RepoError);
      expect((error as RepoError).code).toBe('unauthorized');
      expect((error as RepoError).message).not.toContain(TOKEN);
    }
  });
});

const requestsPayload = [
  {
    id: 11,
    account: { id: 2, login: 'capawesome-team', type: 'Organization' },
    requester: { id: 1, login: 'robingenz', type: 'User', avatar_url: 'https://a.test/u.png' },
    created_at: '2026-07-30T10:00:00Z',
  },
];

let privateKeyPem: string;
let publicKey: CryptoKey;

function toPem(der: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...der));
  const lines = base64.match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

function b64urlToBytes(segment: string): Uint8Array {
  let base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

function decodeJwtSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
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
  privateKeyPem = toPem(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey)));
});

function setupRequests(handler: StubHandler) {
  const stub = createFetchStub(handler);
  return {
    stub,
    list: (params: { limit?: number; cursor?: string; baseUrl?: string } = {}) =>
      listInstallationRequests({
        appId: APP_ID,
        privateKey: privateKeyPem,
        fetch: stub.fetch,
        ...params,
      }),
  };
}

describe('listInstallationRequests', () => {
  it('lists and normalizes the pending installation requests', async () => {
    const { stub, list } = setupRequests(() => ({ json: requestsPayload }));
    const page = await list();

    const request = stub.requests[0]!;
    const url = new URL(request.url);
    expect(url.origin).toBe('https://api.github.com');
    expect(url.pathname).toBe('/app/installation-requests');
    expect(request.headers.accept).toBe('application/vnd.github+json');
    expect(request.headers['x-github-api-version']).toBe('2022-11-28');
    expect(request.headers['user-agent']).toBe('repo-sdk');

    expect(page.cursor).toBeUndefined();
    expect(page.data).toEqual([
      {
        id: '11',
        account: {
          id: '2',
          login: 'capawesome-team',
          kind: 'organization',
          avatarUrl: undefined,
        },
        createdAt: '2026-07-30T10:00:00Z',
        requester: {
          id: '1',
          login: 'robingenz',
          kind: 'user',
          avatarUrl: 'https://a.test/u.png',
        },
        raw: requestsPayload[0],
      },
    ]);
  });

  it('authenticates with an app JWT signed by the app private key', async () => {
    const { stub, list } = setupRequests(() => ({ json: requestsPayload }));
    await list();

    const jwt = stub.requests[0]!.headers.authorization!.replace('Bearer ', '');
    const [header, payload, signature] = jwt.split('.');
    expect(decodeJwtSegment(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect((decodeJwtSegment(payload!) as { iss: string }).iss).toBe(String(APP_ID));
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      b64urlToBytes(signature!) as BufferSource,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(valid).toBe(true);
  });

  it('passes limit as per_page', async () => {
    const { stub, list } = setupRequests(() => ({ json: requestsPayload }));
    await list({ limit: 5 });
    expect(new URL(stub.requests[0]!.url).searchParams.get('per_page')).toBe('5');
  });

  it('paginates via Link-header cursors', async () => {
    const nextUrl = 'https://api.github.com/app/installation-requests?page=2';
    const { stub, list } = setupRequests((request) =>
      new URL(request.url).searchParams.get('page') === '2'
        ? { json: requestsPayload }
        : { json: [], headers: { link: `<${nextUrl}>; rel="next"` } },
    );

    const first = await list();
    expect(first.data).toEqual([]);
    expect(first.cursor).toBeDefined();

    const second = await list({ cursor: first.cursor });
    expect(stub.requests[1]!.url).toBe(nextUrl);
    expect(second.data).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
  });

  it('rejects a cursor pointing at a different origin', async () => {
    const nextUrl = 'https://evil.test/app/installation-requests?page=2';
    const { list } = setupRequests(() => ({
      json: requestsPayload,
      headers: { link: `<${nextUrl}>; rel="next"` },
    }));
    const { cursor } = await list();
    await expect(list({ cursor })).rejects.toMatchObject({ code: 'validation' });
  });

  it('omits the account and requester when absent', async () => {
    const payload = { id: 12, account: null, requester: null, created_at: '2026-07-30T10:00:00Z' };
    const { list } = setupRequests(() => ({ json: [payload] }));
    const page = await list();
    expect(page.data).toEqual([
      {
        id: '12',
        account: undefined,
        createdAt: '2026-07-30T10:00:00Z',
        requester: undefined,
        raw: payload,
      },
    ]);
  });

  it('rejects an invalid private key with a validation RepoError', async () => {
    const stub = createFetchStub(() => ({ json: requestsPayload }));
    await expect(
      listInstallationRequests({ appId: APP_ID, privateKey: 'not a pem', fetch: stub.fetch }),
    ).rejects.toMatchObject({ name: 'RepoError', code: 'validation' });
    expect(stub.requests).toHaveLength(0);
  });

  it('maps HTTP failures to RepoError with the JWT redacted', async () => {
    const { stub, list } = setupRequests((request) => ({
      status: 401,
      json: { message: `Bad credentials for ${request.headers.authorization}` },
    }));
    try {
      await list();
      expect.unreachable('expected RepoError');
    } catch (error) {
      const jwt = stub.requests[0]!.headers.authorization!.replace('Bearer ', '');
      expect(error).toBeInstanceOf(RepoError);
      expect((error as RepoError).code).toBe('unauthorized');
      expect((error as RepoError).message).not.toContain(jwt);
    }
  });
});

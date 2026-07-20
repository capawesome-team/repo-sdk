import { describe, expect, it } from 'vitest';
import { listUserInstallations } from '../../src/github.ts';
import { RepoError } from '../../src/errors.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const TOKEN = 'gho_usertoken';

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

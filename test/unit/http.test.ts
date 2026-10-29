import { describe, expect, it } from 'vitest';
import { RepoError } from '../../src/errors.ts';
import { HttpClient } from '../../src/http.ts';
import { createFetchStub } from '../helpers/fetch-stub.ts';

describe('HttpClient.json', () => {
  function setup(body: string) {
    const stub = createFetchStub(() => ({ body }));
    return new HttpClient({
      provider: 'gitea',
      baseUrl: 'https://git.example.com/acme/app.git/api/v1',
      fetchImpl: stub.fetch,
      authHeaders: () => ({}),
    });
  }

  it('hands the decoded body to parse', async () => {
    const http = setup('{"login":"robin"}');
    const { data } = await http.json('user', (body) => (body as { login: string }).login);
    expect(data).toBe('robin');
  });

  it('hands parse an undefined body on a 204', async () => {
    const stub = createFetchStub(() => ({ status: 204 }));
    const http = new HttpClient({
      provider: 'gitea',
      baseUrl: 'https://git.example.com/api/v1',
      fetchImpl: stub.fetch,
      authHeaders: () => ({}),
    });
    const { data } = await http.json('hooks/1', (body) => body);
    expect(data).toBeUndefined();
  });

  it('throws invalid_response when a successful response is not JSON', async () => {
    const http = setup('<!DOCTYPE html><html></html>');

    const error = await http.json('user', (body) => body).catch((error: unknown) => error);

    expect(error).toBeInstanceOf(RepoError);
    expect(error).toMatchObject({
      code: 'invalid_response',
      message:
        'gitea returned a non-JSON response from https://git.example.com/acme/app.git/api/v1/user',
      provider: 'gitea',
      retryable: false,
      status: 200,
    });
  });

  it('throws invalid_response when parse cannot read the body', async () => {
    const http = setup('{"orgs":{}}');
    const cause = new TypeError('orgs.map is not a function');

    const error = await http
      .json('user/orgs', () => {
        throw cause;
      })
      .catch((error: unknown) => error);

    expect(error).toBeInstanceOf(RepoError);
    expect(error).toMatchObject({
      cause,
      code: 'invalid_response',
      message:
        'gitea returned a response the SDK could not read from https://git.example.com/acme/app.git/api/v1/user/orgs',
      provider: 'gitea',
      status: 200,
    });
  });

  it('passes a RepoError thrown by parse through', async () => {
    const http = setup('{}');
    const verdict = new RepoError(
      'gitea returned an unexpected response for the organizations list',
      {
        code: 'invalid_response',
        provider: 'gitea',
      },
    );

    await expect(
      http.json('user/orgs', () => {
        throw verdict;
      }),
    ).rejects.toBe(verdict);
  });
});

describe('HttpClient.buildUrl', () => {
  const http = new HttpClient({
    provider: 'github',
    baseUrl: 'https://api.github.com',
    authHeaders: () => ({}),
  });

  it.each([
    '/repos/o/r/git/matching-refs/heads/../../../other/repo',
    '/repos/o/r/./branches',
    '/repos/o/r/..',
    '../repos/o/r',
    '/repos/o/r/%2e%2e/other',
    '/repos/o/r/.%2E/other',
    '/repos/o/r/%2E/branches',
    '/repos/o/r?per_page=1',
    '/repos/o/r#branches',
    '/repos/o/r\\..\\other',
    '/repos/o/r/hooks/.\t./.\n./r',
    '/repos/o/r/hooks/.\r.',
    '/repos/o/r/hooks/.. ',
  ])('rejects the relative path %j', (path) => {
    expect(() => http.buildUrl(path)).toThrow(
      expect.objectContaining({ code: 'validation', provider: 'github' }),
    );
  });

  it.each(['/repos/o/.github/branches/feature/v1.2', '/repos/o/r/branches/a..b', '/repos/o/r/...'])(
    'keeps the relative path %s',
    (path) => {
      expect(http.buildUrl(path).pathname).toBe(path);
    },
  );

  it('keeps absolute URLs unchanged', () => {
    const url = 'https://api.github.com/repositories/42/branches?page=2';
    expect(http.buildUrl(url).toString()).toBe(url);
  });
});

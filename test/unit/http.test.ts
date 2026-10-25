import { describe, expect, it } from 'vitest';
import { RepoError } from '../../src/errors.ts';
import { HttpClient } from '../../src/http.ts';
import { createFetchStub } from '../helpers/fetch-stub.ts';

describe('HttpClient.json', () => {
  it('throws invalid_response when a successful response is not JSON', async () => {
    const stub = createFetchStub(() => ({ body: '<!DOCTYPE html><html></html>' }));
    const http = new HttpClient({
      provider: 'gitea',
      baseUrl: 'https://git.example.com/acme/app.git/api/v1',
      fetchImpl: stub.fetch,
      authHeaders: () => ({}),
    });

    const error = await http.json('user').catch((error: unknown) => error);

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

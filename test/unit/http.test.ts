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

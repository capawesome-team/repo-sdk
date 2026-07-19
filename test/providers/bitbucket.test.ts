import { describe, expect, it } from 'vitest';
import { bitbucket, commitWebUrl, parseWebhookEvent, verifyWebhook } from '../../src/bitbucket.ts';
import type { BitbucketProviderOptions } from '../../src/bitbucket.ts';
import { RepoError } from '../../src/errors.ts';
import { encodeCursor } from '../../src/pagination.ts';
import { hmacSha256Hex } from '../../src/webhooks/verify.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const EMAIL = 'user@example.com';
const API_TOKEN = 'atlassian_api_token';
const ACCESS_TOKEN = 'oauth_access_token';

function setup(handler: StubHandler, auth?: BitbucketProviderOptions['auth']) {
  const stub = createFetchStub(handler);
  const provider = bitbucket({
    auth: auth ?? { email: EMAIL, apiToken: API_TOKEN },
    fetch: stub.fetch,
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

const repoPayload = {
  uuid: '{repo-uuid}',
  name: 'repo-sdk',
  full_name: 'capawesome-team/repo-sdk',
  is_private: true,
  mainbranch: { name: 'main' },
  workspace: { slug: 'capawesome-team' },
  links: {
    html: { href: 'https://bitbucket.org/capawesome-team/repo-sdk' },
    clone: [
      { name: 'https', href: 'https://bitbucket.org/capawesome-team/repo-sdk.git' },
      { name: 'ssh', href: 'git@bitbucket.org:capawesome-team/repo-sdk.git' },
    ],
  },
};

describe('request headers', () => {
  it('sends Basic auth for email + apiToken', async () => {
    const { provider, stub } = setup(() => ({ json: repoPayload }));
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(stub.requests[0]!.headers.authorization).toBe(`Basic ${btoa(`${EMAIL}:${API_TOKEN}`)}`);
  });

  it('sends Bearer auth for accessToken', async () => {
    const { provider, stub } = setup(() => ({ json: repoPayload }), { accessToken: ACCESS_TOKEN });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
  });
});

describe('listNamespaces', () => {
  it('maps workspaces and round-trips the next-URL cursor', async () => {
    const { provider } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('page') === '2') {
        return { json: { values: [{ uuid: '{ws2}', slug: 'team2', name: 'Team Two' }] } };
      }
      return {
        json: {
          values: [
            {
              uuid: '{ws1}',
              slug: 'team1',
              name: 'Team One',
              links: { avatar: { href: 'https://avatars.example/ws1' } },
            },
          ],
          next: 'https://api.bitbucket.org/2.0/workspaces?page=2',
        },
      };
    });

    const first = await provider.listNamespaces({});
    expect(first.data[0]).toMatchObject({
      avatarUrl: 'https://avatars.example/ws1',
      id: '{ws1}',
      slug: 'team1',
      name: 'Team One',
      kind: 'workspace',
    });
    expect(first.cursor).toBeDefined();

    const second = await provider.listNamespaces({ cursor: first.cursor });
    expect(second.data[0]?.slug).toBe('team2');
    expect(second.cursor).toBeUndefined();
  });

  it('rejects a forged cross-origin cursor without fetching the attacker host', async () => {
    const { provider, stub } = setup(() => ({ json: { values: [] } }));
    const cursor = encodeCursor('bitbucket', { url: 'https://attacker.example/x' });
    await expectRepoError(provider.listNamespaces({ cursor }), 'validation');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('listRepositories', () => {
  it('uses role=owner when owned is set and namespace path', async () => {
    const { provider, stub } = setup(() => ({ json: { values: [repoPayload] } }));
    await provider.listRepositories({ namespace: 'capawesome-team', owned: true });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/2.0/repositories/capawesome-team');
    expect(url.searchParams.get('role')).toBe('owner');
  });

  it('uses role=member and the root path when no namespace or owned flag', async () => {
    const { provider, stub } = setup(() => ({ json: { values: [repoPayload] } }));
    const page = await provider.listRepositories({});
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/2.0/repositories');
    expect(url.searchParams.get('role')).toBe('member');
    expect(page.data[0]).toMatchObject({
      id: '{repo-uuid}',
      name: 'repo-sdk',
      path: 'capawesome-team/repo-sdk',
      namespace: 'capawesome-team',
      defaultBranch: 'main',
      private: true,
      urls: {
        web: 'https://bitbucket.org/capawesome-team/repo-sdk',
        cloneHttp: 'https://bitbucket.org/capawesome-team/repo-sdk.git',
        cloneSsh: 'git@bitbucket.org:capawesome-team/repo-sdk.git',
      },
    });
  });

  it('builds a BBQL query and escapes embedded double quotes', async () => {
    const { provider, stub } = setup(() => ({ json: { values: [repoPayload] } }));
    await provider.listRepositories({ query: 'my "sdk"' });
    expect(new URL(stub.requests[0]!.url).searchParams.get('q')).toBe('name ~ "my \\"sdk\\""');
  });
});

describe('getRepository', () => {
  it('normalizes the repository payload', async () => {
    const { provider } = setup(() => ({ json: repoPayload }));
    const repo = await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(repo.id).toBe('{repo-uuid}');
    expect(repo.namespace).toBe('capawesome-team');
    expect(repo.defaultBranch).toBe('main');
  });
});

describe('listCommits', () => {
  const commitPayload = {
    hash: 'abc123',
    message: 'first',
    date: '2026-01-15T10:00:00+00:00',
    author: { raw: 'Robin Genz <robin@example.com>' },
    parents: [{ hash: 'parent1' }],
    links: { html: { href: 'https://bitbucket.org/o/r/commits/abc123' } },
  };

  it('parses author.raw into name and email', async () => {
    const { provider } = setup(() => ({ json: { values: [commitPayload] } }));
    const page = await provider.listCommits({ repo: 'o/r' });
    expect(page.data[0]).toMatchObject({
      sha: 'abc123',
      message: 'first',
      parents: ['parent1'],
      url: 'https://bitbucket.org/o/r/commits/abc123',
    });
    expect(page.data[0]?.author).toMatchObject({ name: 'Robin Genz', email: 'robin@example.com' });
    expect(page.data[0]?.author.date).toBeInstanceOf(Date);
    expect(page.data[0]?.committer).toBeUndefined();
  });

  it('maps the linked account when Bitbucket resolves the author to a user', async () => {
    const { provider } = setup(() => ({
      json: {
        values: [
          {
            ...commitPayload,
            author: {
              raw: 'Robin Genz <robin@example.com>',
              user: {
                display_name: 'Robin Genz',
                nickname: 'robingenz',
                account_id: 'acc-1',
                links: { avatar: { href: 'https://avatars.example/acc-1' } },
              },
            },
          },
        ],
      },
    }));
    const page = await provider.listCommits({ repo: 'o/r' });
    expect(page.data[0]?.author.user).toEqual({
      id: 'acc-1',
      username: 'robingenz',
      avatarUrl: 'https://avatars.example/acc-1',
    });
  });

  it('leaves the account unset for unmapped authors', async () => {
    const { provider } = setup(() => ({ json: { values: [commitPayload] } }));
    const page = await provider.listCommits({ repo: 'o/r' });
    expect(page.data[0]?.author.user).toBeUndefined();
  });

  it('falls back to the raw ident when there is no email', async () => {
    const { provider } = setup(() => ({
      json: { values: [{ ...commitPayload, author: { raw: 'automation-bot' } }] },
    }));
    const page = await provider.listCommits({ repo: 'o/r' });
    expect(page.data[0]?.author).toMatchObject({ name: 'automation-bot', email: undefined });
  });

  it('prefers user.display_name for the author name', async () => {
    const { provider } = setup(() => ({
      json: {
        values: [
          {
            ...commitPayload,
            author: { raw: 'rgenz <robin@example.com>', user: { display_name: 'Robin Genz' } },
          },
        ],
      },
    }));
    const page = await provider.listCommits({ repo: 'o/r' });
    expect(page.data[0]?.author).toMatchObject({ name: 'Robin Genz', email: 'robin@example.com' });
  });

  it('uses the ref path, passes path, and filters since locally', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        values: [
          { ...commitPayload, hash: 'new', date: '2026-02-01T00:00:00+00:00' },
          { ...commitPayload, hash: 'old', date: '2025-01-01T00:00:00+00:00' },
        ],
      },
    }));
    const page = await provider.listCommits({
      repo: 'o/r',
      ref: 'feature/foo',
      path: 'src/',
      since: new Date('2026-01-01T00:00:00Z'),
    });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/2.0/repositories/o/r/commits/feature%2Ffoo');
    expect(url.searchParams.get('path')).toBe('src/');
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.sha).toBe('new');
  });
});

describe('getCommit', () => {
  it('uses the singular commit path and encodes the ref', async () => {
    const { provider, stub } = setup(() => ({ json: { hash: 'abc', message: 'm' } }));
    await provider.getCommit({ repo: 'o/r', ref: 'feature/foo' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/2.0/repositories/o/r/commit/feature%2Ffoo',
    );
  });
});

describe('listTags', () => {
  it('normalizes an annotated tag with tagger and date', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        values: [
          {
            name: 'v1.0.0',
            message: 'release 1.0.0',
            date: '2026-05-01T12:00:00+00:00',
            tagger: { raw: 'Robin <robin@example.com>' },
            target: { hash: 'targetsha', date: '2026-04-30T00:00:00+00:00' },
          },
        ],
      },
    }));
    const page = await provider.listTags({ repo: 'o/r' });
    expect(new URL(stub.requests[0]!.url).searchParams.get('sort')).toBe('-target.date');
    expect(page.data[0]).toMatchObject({
      name: 'v1.0.0',
      sha: 'targetsha',
      message: 'release 1.0.0',
      isAnnotated: true,
    });
    expect(page.data[0]?.date?.toISOString()).toBe('2026-05-01T12:00:00.000Z');
  });

  it('normalizes a lightweight tag using the target date', async () => {
    const { provider } = setup(() => ({
      json: {
        values: [{ name: 'v0.1', target: { hash: 'lightsha', date: '2026-04-30T00:00:00+00:00' } }],
      },
    }));
    const page = await provider.listTags({ repo: 'o/r' });
    expect(page.data[0]).toMatchObject({ name: 'v0.1', sha: 'lightsha', isAnnotated: false });
    expect(page.data[0]?.message).toBeUndefined();
    expect(page.data[0]?.date?.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });
});

describe('listBranches', () => {
  it('normalizes branches, uses default order, and round-trips the next-URL cursor', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('page') === '2') {
        return { json: { values: [{ name: 'develop', target: { hash: 'sha2' } }] } };
      }
      return {
        json: {
          values: [{ name: 'main', target: { hash: 'sha1' } }],
          next: 'https://api.bitbucket.org/2.0/repositories/o/r/refs/branches?page=2',
        },
      };
    });

    const page = await provider.listBranches({ repo: 'o/r' });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/2.0/repositories/o/r/refs/branches');
    expect(url.searchParams.get('sort')).toBeNull();
    expect(page.data[0]).toMatchObject({ name: 'main', sha: 'sha1' });
    expect(page.data[0]?.raw).toEqual({ name: 'main', target: { hash: 'sha1' } });
    expect(page.cursor).toBeDefined();

    const second = await provider.listBranches({ repo: 'o/r', cursor: page.cursor });
    expect(second.data[0]).toMatchObject({ name: 'develop', sha: 'sha2' });
    expect(second.cursor).toBeUndefined();
  });

  it('rejects a forged cross-origin cursor without fetching the attacker host', async () => {
    const { provider, stub } = setup(() => ({ json: { values: [] } }));
    const cursor = encodeCursor('bitbucket', { url: 'https://attacker.example/x' });
    await expectRepoError(provider.listBranches({ repo: 'o/r', cursor }), 'validation');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('searchRefs', () => {
  const branchesPayload = {
    values: [
      { name: 'feature-x', target: { hash: 'sha1' } },
      { name: 'Feature-y', target: { hash: 'sha2' } },
      { name: 'my-feat', target: { hash: 'sha3' } },
    ],
  };
  const tagsPayload = { values: [{ name: 'feat-tag', target: { hash: 'tagsha' } }] };

  const byEndpoint: StubHandler = (request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/refs/branches')) return { json: branchesPayload };
    if (url.pathname.endsWith('/refs/tags')) return { json: tagsPayload };
    return { status: 404, json: {} };
  };

  it('sends a contains q filter, narrows it to a case-insensitive prefix, and orders branches before tags', async () => {
    const { provider, stub } = setup(byEndpoint);
    const matches = await provider.searchRefs({
      repo: 'o/r',
      query: 'feat',
      types: ['branch', 'tag'],
      limit: 20,
    });
    for (const request of stub.requests) {
      expect(new URL(request.url).searchParams.get('q')).toBe('name ~ "feat"');
    }
    // 'my-feat' contains but does not start with 'feat', so the prefix post-filter drops it.
    expect(matches).toEqual([
      { type: 'branch', name: 'feature-x', sha: 'sha1', raw: branchesPayload.values[0] },
      { type: 'branch', name: 'Feature-y', sha: 'sha2', raw: branchesPayload.values[1] },
      { type: 'tag', name: 'feat-tag', sha: 'tagsha', raw: tagsPayload.values[0] },
    ]);
  });

  it('escapes backslashes and double quotes in the q filter', async () => {
    const { provider, stub } = setup(() => ({ json: { values: [] } }));
    await provider.searchRefs({ repo: 'o/r', query: 'a"b', types: ['branch'], limit: 20 });
    expect(new URL(stub.requests[0]!.url).searchParams.get('q')).toBe('name ~ "a\\"b"');

    await provider.searchRefs({ repo: 'o/r', query: 'a\\b', types: ['branch'], limit: 20 });
    expect(new URL(stub.requests[1]!.url).searchParams.get('q')).toBe('name ~ "a\\\\b"');
  });

  it('fetches only the requested types and truncates to the limit', async () => {
    const { provider, stub } = setup(byEndpoint);
    const matches = await provider.searchRefs({
      repo: 'o/r',
      query: 'feat',
      types: ['branch'],
      limit: 1,
    });
    expect(stub.requests).toHaveLength(1);
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/2.0/repositories/o/r/refs/branches');
    expect(url.searchParams.get('pagelen')).toBe('1');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe('feature-x');
  });
});

describe('downloadArchive', () => {
  it('downloads from the bitbucket.org host with Basic auth', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.hostname === 'bitbucket.org') {
        return {
          body: 'ZIPDATA',
          headers: {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename=repo-sdk.zip',
          },
        };
      }
      return { status: 404, json: {} };
    });

    const archive = await provider.downloadArchive({ repo: 'o/r', ref: 'main', format: 'zip' });
    expect(archive.contentType).toBe('application/zip');
    expect(archive.filename).toBe('repo-sdk.zip');
    expect(await new Response(archive.stream).text()).toBe('ZIPDATA');

    const request = stub.requests[0]!;
    expect(request.url).toBe('https://bitbucket.org/o/r/get/main.zip');
    expect(request.headers.authorization).toBe(`Basic ${btoa(`${EMAIL}:${API_TOKEN}`)}`);
  });

  it('builds a tar.gz filename for the tar.gz format', async () => {
    const { provider, stub } = setup(() => ({ body: 'DATA' }));
    await provider.downloadArchive({ repo: 'o/r', ref: 'v1.0.0', format: 'tar.gz' });
    expect(stub.requests[0]!.url).toBe('https://bitbucket.org/o/r/get/v1.0.0.tar.gz');
  });

  it('throws unsupported when configured with an access token only', async () => {
    const { provider } = setup(() => ({ body: 'DATA' }), { accessToken: ACCESS_TOKEN });
    await expectRepoError(provider.downloadArchive({ repo: 'o/r', ref: 'main' }), 'unsupported');
  });
});

describe('getCloneUrl', () => {
  it('embeds the api token with the static username', async () => {
    const token = 'tok/with+special';
    const { provider } = setup(() => ({ json: {} }), { email: EMAIL, apiToken: token });
    const clone = await provider.getCloneUrl({ repo: 'o/r' });
    expect(clone.url).toBe(
      `https://x-bitbucket-api-token-auth:${encodeURIComponent(token)}@bitbucket.org/o/r.git`,
    );
    expect(clone.expiresAt).toBeUndefined();
  });

  it('embeds the access token with x-token-auth', async () => {
    const token = 'access/token';
    const { provider } = setup(() => ({ json: {} }), { accessToken: token });
    const clone = await provider.getCloneUrl({ repo: 'o/r' });
    expect(clone.url).toBe(
      `https://x-token-auth:${encodeURIComponent(token)}@bitbucket.org/o/r.git`,
    );
  });
});

describe('webhooks', () => {
  it('maps push/tag_push to a single repo:push event and reverses the response', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        uuid: '{hook-uuid}',
        url: 'https://example.com/hook',
        active: true,
        events: ['repo:push'],
      },
    }));
    const webhook = await provider.createWebhook({
      repo: 'o/r',
      url: 'https://example.com/hook',
      events: ['push', 'tag_push'],
      secret: 'shh',
    });
    const body = JSON.parse(stub.requests[0]!.body!);
    expect(body).toMatchObject({
      url: 'https://example.com/hook',
      description: 'repo-sdk',
      active: true,
      events: ['repo:push'],
      secret: 'shh',
    });
    expect(webhook.id).toBe('{hook-uuid}');
    expect(webhook.events).toEqual(['push', 'tag_push']);
  });

  it('encodes the uuid (including braces) in the path and updates by merging from the existing hook', async () => {
    const { provider, stub } = setup((request) => {
      if (request.method === 'GET') {
        return {
          json: {
            uuid: '{hook-uuid}',
            url: 'https://old.example.com/hook',
            description: 'repo-sdk',
            active: true,
            events: ['repo:push'],
          },
        };
      }
      return {
        json: {
          uuid: '{hook-uuid}',
          url: 'https://old.example.com/hook',
          active: false,
          events: ['repo:push'],
        },
      };
    });

    const webhook = await provider.updateWebhook({ repo: 'o/r', id: '{hook-uuid}', active: false });

    const get = stub.requests[0]!;
    expect(get.method).toBe('GET');
    expect(new URL(get.url).pathname).toBe('/2.0/repositories/o/r/hooks/%7Bhook-uuid%7D');

    const put = stub.requests[1]!;
    expect(put.method).toBe('PUT');
    const body = JSON.parse(put.body!);
    expect(body).toMatchObject({
      url: 'https://old.example.com/hook',
      active: false,
      events: ['repo:push'],
    });
    expect(body.secret).toBeUndefined();
    expect(webhook.active).toBe(false);
  });

  it('deletes a webhook expecting 204', async () => {
    const { provider, stub } = setup(() => ({ status: 204 }));
    await provider.deleteWebhook({ repo: 'o/r', id: '{hook-uuid}' });
    expect(stub.requests[0]!.method).toBe('DELETE');
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/2.0/repositories/o/r/hooks/%7Bhook-uuid%7D',
    );
  });
});

describe('error mapping', () => {
  it('reads the message from the Bitbucket error envelope', async () => {
    const { provider } = setup(() => ({
      status: 404,
      json: { type: 'error', error: { message: 'Repository not found' } },
    }));
    try {
      await provider.getRepository({ repo: 'o/r' });
      expect.unreachable('expected RepoError');
    } catch (error) {
      expect(error).toBeInstanceOf(RepoError);
      expect((error as RepoError).code).toBe('not_found');
      expect((error as RepoError).message).toBe('Repository not found');
    }
  });
});

describe('verifyWebhook', () => {
  it('accepts a valid signature and rejects an invalid one', async () => {
    const secret = 'topsecret';
    const body = '{"push":{"changes":[]}}';
    const signature = `sha256=${await hmacSha256Hex(secret, body)}`;
    expect(await verifyWebhook({ headers: { 'x-hub-signature': signature }, body, secret })).toBe(
      true,
    );
    expect(
      await verifyWebhook({ headers: { 'x-hub-signature': 'sha256=deadbeef' }, body, secret }),
    ).toBe(false);
  });

  it('returns false when the header or secret is missing', async () => {
    expect(await verifyWebhook({ headers: {}, body: '{}', secret: 'x' })).toBe(false);
    expect(
      await verifyWebhook({ headers: { 'x-hub-signature': 'sha256=x' }, body: '{}', secret: '' }),
    ).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('distinguishes a branch push from a tag push', async () => {
    const push = await parseWebhookEvent({
      headers: { 'x-event-key': 'repo:push', 'x-hook-uuid': 'hook-1', 'x-request-uuid': 'req-0' },
      body: JSON.stringify({
        repository: { full_name: 'o/r' },
        push: {
          changes: [
            {
              new: { type: 'branch', name: 'main', target: { hash: 'headsha' } },
              commits: [{ hash: 'sha1', message: 'msg' }],
            },
          ],
        },
      }),
    });
    expect(push).toMatchObject({
      type: 'push',
      repo: 'o/r',
      ref: 'refs/heads/main',
      headCommitSha: 'headsha',
      deliveryId: 'req-0',
      webhookId: 'hook-1',
    });
    expect(push.commits).toEqual([{ sha: 'sha1', message: 'msg' }]);

    const deletion = await parseWebhookEvent({
      headers: { 'x-event-key': 'repo:push' },
      body: JSON.stringify({
        push: { changes: [{ old: { type: 'branch', name: 'gone' }, new: null }] },
      }),
    });
    expect(deletion.type).toBe('push');
    expect(deletion.headCommitSha).toBeUndefined();

    const tagPush = await parseWebhookEvent({
      headers: { 'x-event-key': 'repo:push', 'x-request-uuid': 'req-1' },
      body: JSON.stringify({
        push: { changes: [{ new: { type: 'tag', name: 'v1.0.0' } }] },
      }),
    });
    expect(tagPush).toMatchObject({
      type: 'tag_push',
      ref: 'refs/tags/v1.0.0',
      deliveryId: 'req-1',
    });

    const other = await parseWebhookEvent({
      headers: { 'x-event-key': 'pullrequest:created' },
      body: JSON.stringify({}),
    });
    expect(other.type).toBe('unknown');
  });

  it('classifies an empty push.changes array as a push, not a tag_push', async () => {
    const event = await parseWebhookEvent({
      headers: { 'x-event-key': 'repo:push' },
      body: JSON.stringify({ push: { changes: [] } }),
    });
    expect(event.type).toBe('push');
    expect(event.ref).toBeUndefined();
    expect(event.commits).toBeUndefined();
  });

  it('classifies a tag change as a tag_push', async () => {
    const event = await parseWebhookEvent({
      headers: { 'x-event-key': 'repo:push' },
      body: JSON.stringify({ push: { changes: [{ new: { type: 'tag', name: 'v1' } }] } }),
    });
    expect(event.type).toBe('tag_push');
    expect(event.ref).toBe('refs/tags/v1');
  });

  it('classifies a branch change as a push', async () => {
    const event = await parseWebhookEvent({
      headers: { 'x-event-key': 'repo:push' },
      body: JSON.stringify({ push: { changes: [{ new: { type: 'branch', name: 'main' } }] } }),
    });
    expect(event.type).toBe('push');
    expect(event.ref).toBe('refs/heads/main');
  });
});

describe('commitWebUrl', () => {
  it('builds the commit web URL from the repository web URL', () => {
    expect(commitWebUrl('https://bitbucket.org/o/r', 'abc123')).toBe(
      'https://bitbucket.org/o/r/commits/abc123',
    );
  });
});

describe('getAuthenticatedUser', () => {
  it('maps the /user payload without an email', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        uuid: '{user-uuid-1}',
        username: 'robin',
        display_name: 'Robin',
        links: { avatar: { href: 'https://bitbucket.example/avatar.png' } },
      },
    }));
    const user = await provider.getAuthenticatedUser({});
    expect(user).toMatchObject({
      id: '{user-uuid-1}',
      username: 'robin',
      name: 'Robin',
      avatarUrl: 'https://bitbucket.example/avatar.png',
    });
    expect(user.email).toBeUndefined();
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/2.0/user');
  });

  describe('includeEmail', () => {
    it('resolves the primary confirmed email via /user/emails', async () => {
      const { provider, stub } = setup((request) => {
        const url = new URL(request.url);
        if (url.pathname === '/2.0/user/emails') {
          return {
            json: {
              values: [
                { email: 'secondary@example.com', is_primary: false, is_confirmed: true },
                { email: 'primary@example.com', is_primary: true, is_confirmed: true },
              ],
            },
          };
        }
        return { json: { uuid: '{user-uuid-1}', username: 'robin' } };
      });
      const user = await provider.getAuthenticatedUser({ includeEmail: true });
      expect(user.email).toBe('primary@example.com');
      expect(stub.requests.map((r) => new URL(r.url).pathname)).toEqual([
        '/2.0/user',
        '/2.0/user/emails',
      ]);
    });

    it('leaves email unset when the emails call is forbidden (missing email scope)', async () => {
      const { provider } = setup((request) =>
        new URL(request.url).pathname === '/2.0/user/emails'
          ? { status: 403, json: {} }
          : { json: { uuid: '{user-uuid-1}', username: 'robin' } },
      );
      const user = await provider.getAuthenticatedUser({ includeEmail: true });
      expect(user.username).toBe('robin');
      expect(user.email).toBeUndefined();
    });
  });
});

describe('tokenProvider auth', () => {
  it('sends the minted token and retries once with forceRefresh on a 401', async () => {
    const contexts: boolean[] = [];
    const stub = createFetchStub((request) =>
      request.headers.authorization === 'Bearer fresh'
        ? { json: { uuid: '{u1}', username: 'robin' } }
        : { status: 401, json: {} },
    );
    const provider = bitbucket({
      auth: {
        tokenProvider: ({ forceRefresh }) => {
          contexts.push(forceRefresh);
          return Promise.resolve(forceRefresh ? 'fresh' : 'stale');
        },
      },
      fetch: stub.fetch,
    });
    const user = await provider.getAuthenticatedUser({});
    expect(user.username).toBe('robin');
    expect(contexts).toEqual([false, true]);
    expect(stub.requests).toHaveLength(2);
  });
});

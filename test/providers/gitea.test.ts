import { describe, expect, it } from 'vitest';
import { commitWebUrl, gitea, parseWebhookEvent, verifyWebhook } from '../../src/gitea.ts';
import { RepoError } from '../../src/errors.ts';
import { encodeCursor } from '../../src/pagination.ts';
import { hmacSha256Hex } from '../../src/webhooks/verify.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const TOKEN = 'gitea-testtoken';

function setup(handler: StubHandler, baseUrl?: string) {
  const stub = createFetchStub(handler);
  const provider = gitea({ auth: { token: TOKEN }, fetch: stub.fetch, baseUrl });
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
  id: 42,
  name: 'repo-sdk',
  full_name: 'capawesome-team/repo-sdk',
  owner: { login: 'capawesome-team' },
  default_branch: 'main',
  private: true,
  archived: false,
  html_url: 'https://gitea.example.com/capawesome-team/repo-sdk',
  clone_url: 'https://gitea.example.com/capawesome-team/repo-sdk.git',
  ssh_url: 'git@gitea.example.com:capawesome-team/repo-sdk.git',
};

describe('request headers', () => {
  it('sends the token authorization scheme', async () => {
    const { provider, stub } = setup(() => ({ json: repoPayload }));
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(stub.requests[0]!.headers.authorization).toBe(`token ${TOKEN}`);
  });
});

describe('listNamespaces', () => {
  it('returns the personal namespace plus organizations and follows the link cursor', async () => {
    const { provider } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/user') {
        return {
          json: {
            id: 1,
            login: 'robin',
            full_name: 'Robin Genz',
            avatar_url: 'https://avatars.example/u1',
          },
        };
      }
      if (url.pathname === '/api/v1/user/orgs') {
        if (url.searchParams.get('page') === '2') {
          return { json: [{ id: 30, username: 'third-org', full_name: '' }] };
        }
        return {
          json: [
            {
              id: 10,
              username: 'capawesome-team',
              full_name: 'Capawesome',
              avatar_url: 'https://avatars.example/o10',
            },
          ],
          headers: { link: '<https://gitea.com/api/v1/user/orgs?page=2>; rel="next"' },
        };
      }
      return { status: 404, json: { message: 'not found' } };
    });

    const first = await provider.listNamespaces({ limit: 20 });
    expect(first.data[0]).toMatchObject({
      id: '1',
      slug: 'robin',
      name: 'Robin Genz',
      kind: 'user',
      avatarUrl: 'https://avatars.example/u1',
    });
    expect(first.data[1]).toMatchObject({
      id: '10',
      slug: 'capawesome-team',
      name: 'Capawesome',
      kind: 'organization',
      avatarUrl: 'https://avatars.example/o10',
    });
    expect(first.cursor).toBeDefined();

    const second = await provider.listNamespaces({ cursor: first.cursor });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]).toMatchObject({ slug: 'third-org', name: 'third-org' });
    expect(second.cursor).toBeUndefined();
  });
});

describe('listRepositories', () => {
  it('lists the authenticated user repositories by default', async () => {
    const { provider, stub } = setup(() => ({ json: [repoPayload] }));
    const page = await provider.listRepositories({ limit: 20 });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/api/v1/user/repos');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(page.data[0]).toMatchObject({
      id: '42',
      path: 'capawesome-team/repo-sdk',
      namespace: 'capawesome-team',
      defaultBranch: 'main',
      private: true,
      urls: {
        web: 'https://gitea.example.com/capawesome-team/repo-sdk',
        cloneHttp: 'https://gitea.example.com/capawesome-team/repo-sdk.git',
        cloneSsh: 'git@gitea.example.com:capawesome-team/repo-sdk.git',
      },
    });
  });

  it('searches via /repos/search and unwraps the data envelope', async () => {
    const { provider, stub } = setup(() => ({ json: { ok: true, data: [repoPayload] } }));
    const page = await provider.listRepositories({ query: 'sdk' });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/api/v1/repos/search');
    expect(url.searchParams.get('q')).toBe('sdk');
    expect(url.searchParams.get('uid')).toBeNull();
    expect(page.data[0]?.path).toBe('capawesome-team/repo-sdk');
  });

  it('resolves the own user id once for owned searches', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/user') return { json: { id: 7, login: 'robin' } };
      return { json: { ok: true, data: [repoPayload] } };
    });
    await provider.listRepositories({ owned: true });
    await provider.listRepositories({ owned: true, query: 'sdk' });
    const searches = stub.requests.filter((r) => r.url.includes('/repos/search'));
    expect(stub.requests.filter((r) => new URL(r.url).pathname === '/api/v1/user')).toHaveLength(1);
    for (const search of searches) {
      const url = new URL(search.url);
      expect(url.searchParams.get('uid')).toBe('7');
      expect(url.searchParams.get('exclusive')).toBe('true');
    }
  });

  it('scopes a namespace search to the resolved org id', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/orgs/capawesome-team') return { json: { id: 10 } };
      return { json: { ok: true, data: [repoPayload] } };
    });
    await provider.listRepositories({ namespace: 'capawesome-team', query: 'sdk' });
    const url = new URL(stub.requests.at(-1)!.url);
    expect(url.pathname).toBe('/api/v1/repos/search');
    expect(url.searchParams.get('uid')).toBe('10');
  });

  it('falls back to the users endpoint when the org returns 404', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/orgs/robin/repos') {
        return { status: 404, json: { message: 'not found' } };
      }
      if (url.pathname === '/api/v1/users/robin/repos') {
        return { json: [repoPayload] };
      }
      return { status: 500, json: {} };
    });
    await provider.listRepositories({ namespace: 'robin' });
    expect(new URL(stub.requests.at(-1)!.url).pathname).toBe('/api/v1/users/robin/repos');
  });
});

describe('listCommits', () => {
  const commitPayload = {
    sha: 'abc123',
    html_url: 'https://gitea.example.com/o/r/commit/abc123',
    parents: [{ sha: 'parent1' }],
    commit: {
      message: 'first',
      author: { name: 'Robin', email: 'robin@example.com', date: '2026-01-15T10:00:00Z' },
      committer: { name: 'Robin', email: 'robin@example.com', date: '2026-01-15T11:00:00Z' },
    },
  };

  it('maps query params, disables payload extras and normalizes commit fields', async () => {
    const { provider, stub } = setup(() => ({ json: [commitPayload] }));
    const page = await provider.listCommits({
      repo: 'o/r',
      ref: 'main',
      since: new Date('2026-01-01T00:00:00Z'),
      until: new Date('2026-02-01T00:00:00Z'),
      path: 'src/',
      limit: 50,
    });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/api/v1/repos/o/r/commits');
    expect(url.searchParams.get('sha')).toBe('main');
    expect(url.searchParams.get('since')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('until')).toBe('2026-02-01T00:00:00.000Z');
    expect(url.searchParams.get('path')).toBe('src/');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('stat')).toBe('false');
    expect(url.searchParams.get('verification')).toBe('false');
    expect(url.searchParams.get('files')).toBe('false');
    expect(page.data[0]).toMatchObject({
      sha: 'abc123',
      message: 'first',
      parents: ['parent1'],
      url: 'https://gitea.example.com/o/r/commit/abc123',
    });
    expect(page.data[0]?.author.date.toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(page.data[0]?.committer?.date.toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });

  it('maps the linked account of author and committer when present', async () => {
    const { provider } = setup(() => ({
      json: [
        {
          ...commitPayload,
          author: { id: 1, login: 'robingenz', avatar_url: 'https://avatars.example/u1' },
          committer: null,
        },
      ],
    }));
    const page = await provider.listCommits({ repo: 'o/r' });
    expect(page.data[0]?.author.user).toEqual({
      id: '1',
      username: 'robingenz',
      avatarUrl: 'https://avatars.example/u1',
    });
    expect(page.data[0]?.committer?.user).toBeUndefined();
  });

  it('filters by author locally', async () => {
    const other = {
      ...commitPayload,
      sha: 'def456',
      commit: { ...commitPayload.commit, author: { name: 'Someone', email: 'other@example.com' } },
    };
    const { provider } = setup(() => ({ json: [commitPayload, other] }));
    const page = await provider.listCommits({ repo: 'o/r', author: 'robin@example.com' });
    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.sha).toBe('abc123');
  });

  it('follows the link header cursor', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('page') === '2') {
        return { json: [{ ...commitPayload, sha: 'def456' }] };
      }
      return {
        json: [commitPayload],
        headers: { link: '<https://gitea.com/api/v1/repos/o/r/commits?page=2>; rel="next"' },
      };
    });
    const page = await provider.listCommits({ repo: 'o/r', ref: 'main' });
    expect(page.cursor).toBeDefined();

    const next = await provider.listCommits({ repo: 'o/r', cursor: page.cursor });
    expect(next.data[0]?.sha).toBe('def456');
    expect(new URL(stub.requests.at(-1)!.url).searchParams.get('page')).toBe('2');
    expect(next.cursor).toBeUndefined();
  });
});

describe('getCommit', () => {
  it('URL-encodes the ref on the git commits endpoint', async () => {
    const { provider, stub } = setup(() => ({ json: { sha: 'abc' } }));
    await provider.getCommit({ repo: 'o/r', ref: 'feature/foo' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/api/v1/repos/o/r/git/commits/feature%2Ffoo',
    );
  });
});

describe('listTags', () => {
  it('distinguishes annotated and lightweight tags via the tag object sha', async () => {
    const { provider } = setup(() => ({
      json: [
        {
          name: 'v1.0.0',
          message: 'release',
          id: 'tagobjectsha',
          commit: { sha: 'commitsha' },
        },
        { name: 'v0.9.0', message: '', id: 'lightsha', commit: { sha: 'lightsha' } },
      ],
    }));
    const page = await provider.listTags({ repo: 'o/r' });
    expect(page.data[0]).toMatchObject({
      name: 'v1.0.0',
      sha: 'commitsha',
      message: 'release',
      isAnnotated: true,
    });
    expect(page.data[0]?.date).toBeUndefined();
    expect(page.data[1]).toMatchObject({
      name: 'v0.9.0',
      sha: 'lightsha',
      message: undefined,
      isAnnotated: false,
    });
  });
});

describe('listBranches', () => {
  it('normalizes branches and round-trips the Link cursor', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('page') === '2') {
        return { json: [{ name: 'develop', commit: { id: 'sha2' } }] };
      }
      return {
        json: [{ name: 'main', commit: { id: 'sha1' } }],
        headers: { link: '<https://gitea.com/api/v1/repos/o/r/branches?page=2>; rel="next"' },
      };
    });
    const page = await provider.listBranches({ repo: 'o/r', limit: 50 });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/api/v1/repos/o/r/branches');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(page.data[0]).toMatchObject({ name: 'main', sha: 'sha1' });
    expect(page.cursor).toBeDefined();

    const next = await provider.listBranches({ repo: 'o/r', cursor: page.cursor });
    expect(next.data[0]).toMatchObject({ name: 'develop', sha: 'sha2' });
    expect(new URL(stub.requests.at(-1)!.url).searchParams.get('page')).toBe('2');
    expect(next.cursor).toBeUndefined();
  });
});

describe('getBranch', () => {
  it('fetches the single-branch endpoint preserving slashes', async () => {
    const payload = { name: 'feature/login', commit: { id: 'sha1' } };
    const { provider, stub } = setup(() => ({ json: payload }));
    const branch = await provider.getBranch({ repo: 'o/r', name: 'feature/login' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/api/v1/repos/o/r/branches/feature/login',
    );
    expect(branch).toEqual({ name: 'feature/login', sha: 'sha1', raw: payload });
  });

  it('maps a 404 to not_found', async () => {
    const { provider } = setup(() => ({ status: 404, json: {} }));
    await expectRepoError(provider.getBranch({ repo: 'o/r', name: 'missing' }), 'not_found');
  });
});

describe('getTag', () => {
  it('fetches the single-tag endpoint and distinguishes annotated tags', async () => {
    const payload = {
      name: 'v1.0.0',
      message: 'release',
      id: 'tagobjectsha',
      commit: { sha: 'commitsha' },
    };
    const { provider, stub } = setup(() => ({ json: payload }));
    const tag = await provider.getTag({ repo: 'o/r', name: 'v1.0.0' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v1/repos/o/r/tags/v1.0.0');
    expect(tag).toMatchObject({
      name: 'v1.0.0',
      sha: 'commitsha',
      message: 'release',
      isAnnotated: true,
    });
  });

  it('marks a tag whose object sha equals the commit as lightweight', async () => {
    const payload = { name: 'v0.9.0', message: '', id: 'lightsha', commit: { sha: 'lightsha' } };
    const { provider } = setup(() => ({ json: payload }));
    const tag = await provider.getTag({ repo: 'o/r', name: 'v0.9.0' });
    expect(tag).toMatchObject({ name: 'v0.9.0', sha: 'lightsha', isAnnotated: false });
  });

  it('maps a 404 to not_found', async () => {
    const { provider } = setup(() => ({ status: 404, json: {} }));
    await expectRepoError(provider.getTag({ repo: 'o/r', name: 'missing' }), 'not_found');
  });
});

describe('searchRefs', () => {
  const headsPayload = [
    { ref: 'refs/heads/feature/login', object: { sha: 'sha1', type: 'commit' } },
    { ref: 'refs/heads/feature/logout', object: { sha: 'sha2', type: 'commit' } },
  ];
  const tagsPayload = [{ ref: 'refs/tags/feat-tag', object: { sha: 'tagobj', type: 'tag' } }];

  it('queries both ref namespaces and maps branches before tags', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/repos/o/r/git/refs/heads/feat') return { json: headsPayload };
      if (url.pathname === '/api/v1/repos/o/r/git/refs/tags/feat') return { json: tagsPayload };
      return { status: 404, json: { message: 'not found' } };
    });
    const matches = await provider.searchRefs({
      repo: 'o/r',
      query: 'feat',
      types: ['branch', 'tag'],
      limit: 20,
    });
    expect(stub.requests.map((r) => new URL(r.url).pathname).sort()).toEqual([
      '/api/v1/repos/o/r/git/refs/heads/feat',
      '/api/v1/repos/o/r/git/refs/tags/feat',
    ]);
    expect(matches).toEqual([
      { type: 'branch', name: 'feature/login', sha: 'sha1', raw: headsPayload[0] },
      { type: 'branch', name: 'feature/logout', sha: 'sha2', raw: headsPayload[1] },
      { type: 'tag', name: 'feat-tag', sha: 'tagobj', raw: tagsPayload[0] },
    ]);
  });

  it('keeps slashes in the query as a path', async () => {
    const { provider, stub } = setup(() => ({ json: [] }));
    await provider.searchRefs({ repo: 'o/r', query: 'feature/x', types: ['branch'], limit: 20 });
    expect(stub.requests).toHaveLength(1);
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/api/v1/repos/o/r/git/refs/heads/feature/x',
    );
  });

  it('treats a 404 on one namespace as no matches, not an error', async () => {
    const { provider } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v1/repos/o/r/git/refs/heads/feat') {
        return { status: 404, json: { message: 'not found' } };
      }
      return { json: tagsPayload };
    });
    const matches = await provider.searchRefs({
      repo: 'o/r',
      query: 'feat',
      types: ['branch', 'tag'],
      limit: 20,
    });
    expect(matches).toEqual([
      { type: 'tag', name: 'feat-tag', sha: 'tagobj', raw: tagsPayload[0] },
    ]);
  });

  it('normalizes a single-object response to one match', async () => {
    const single = { ref: 'refs/heads/main', object: { sha: 'mainsha', type: 'commit' } };
    const { provider } = setup(() => ({ json: single }));
    const matches = await provider.searchRefs({
      repo: 'o/r',
      query: 'main',
      types: ['branch'],
      limit: 20,
    });
    expect(matches).toEqual([{ type: 'branch', name: 'main', sha: 'mainsha', raw: single }]);
  });

  it('only queries the requested types and truncates to the limit', async () => {
    const { provider, stub } = setup(() => ({ json: headsPayload }));
    const matches = await provider.searchRefs({
      repo: 'o/r',
      query: 'feat',
      types: ['branch'],
      limit: 1,
    });
    expect(stub.requests).toHaveLength(1);
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v1/repos/o/r/git/refs/heads/feat');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe('feature/login');
  });
});

describe('downloadArchive', () => {
  it('requests the zip archive and preserves slashes in the ref', async () => {
    const { provider, stub } = setup(() => ({
      body: 'ZIPDATA',
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="repo-sdk.zip"',
      },
    }));
    const archive = await provider.downloadArchive({
      repo: 'o/r',
      ref: 'feature/foo',
      format: 'zip',
    });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/api/v1/repos/o/r/archive/feature/foo.zip',
    );
    expect(archive.contentType).toBe('application/zip');
    expect(archive.filename).toBe('repo-sdk.zip');
    expect(await new Response(archive.stream).text()).toBe('ZIPDATA');
  });

  it('requests the tar.gz format', async () => {
    const { provider, stub } = setup(() => ({ body: 'TARDATA' }));
    await provider.downloadArchive({ repo: 'o/r', ref: 'main', format: 'tar.gz' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v1/repos/o/r/archive/main.tar.gz');
  });
});

describe('getCloneUrl', () => {
  it('embeds the token as basic-auth username without an API call', async () => {
    const { provider, stub } = setup(() => ({ status: 500, json: {} }));
    const clone = await provider.getCloneUrl({ repo: 'capawesome-team/repo-sdk' });
    expect(stub.requests).toHaveLength(0);
    expect(clone.url).toBe(
      `https://${encodeURIComponent(TOKEN)}@gitea.com/capawesome-team/repo-sdk.git`,
    );
  });

  it('derives the host from a self-hosted base URL', async () => {
    const { provider } = setup(() => ({ json: {} }), 'https://gitea.example.com/api/v1');
    const clone = await provider.getCloneUrl({ repo: 'o/r' });
    expect(clone.url).toBe(`https://${encodeURIComponent(TOKEN)}@gitea.example.com/o/r.git`);
  });
});

describe('webhooks', () => {
  const hookPayload = {
    id: 99,
    active: true,
    events: ['push', 'create', 'delete'],
    config: { url: 'https://example.com/hook', content_type: 'json' },
  };

  it('creates a gitea-type hook and maps tag_push to create/delete', async () => {
    const { provider, stub } = setup(() => ({ json: hookPayload }));
    const webhook = await provider.createWebhook({
      repo: 'o/r',
      url: 'https://example.com/hook',
      events: ['push', 'tag_push'],
      secret: 'shh',
    });
    const body = JSON.parse(stub.requests[0]!.body!);
    expect(body).toMatchObject({
      type: 'gitea',
      active: true,
      events: ['push', 'create', 'delete'],
      config: { url: 'https://example.com/hook', content_type: 'json', secret: 'shh' },
    });
    expect(webhook).toMatchObject({
      id: '99',
      url: 'https://example.com/hook',
      active: true,
      events: ['push', 'tag_push'],
    });
  });

  it('sends a partial config on update without hydrating the existing hook', async () => {
    const { provider, stub } = setup(() => ({ json: hookPayload }));
    await provider.updateWebhook({ repo: 'o/r', id: '99', secret: 'rotated' });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.method).toBe('PATCH');
    const body = JSON.parse(stub.requests[0]!.body!);
    expect(body.config).toEqual({ secret: 'rotated' });
    expect(body.events).toBeUndefined();
  });

  it('omits the config block when only events change', async () => {
    const { provider, stub } = setup(() => ({ json: hookPayload }));
    await provider.updateWebhook({ repo: 'o/r', id: '99', events: ['release'] });
    const body = JSON.parse(stub.requests[0]!.body!);
    expect(body.config).toBeUndefined();
    expect(body.events).toEqual(['release']);
  });

  it('deletes a webhook', async () => {
    const { provider, stub } = setup(() => ({ status: 204 }));
    await provider.deleteWebhook({ repo: 'o/r', id: '99' });
    expect(stub.requests[0]!.method).toBe('DELETE');
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v1/repos/o/r/hooks/99');
  });
});

describe('cursor origin guard', () => {
  it('rejects a forged cursor that points to another host and does not fetch it', async () => {
    const { provider, stub } = setup(() => ({ json: [] }));
    const forged = encodeCursor('gitea', { url: 'https://attacker.example/x' });
    await expectRepoError(provider.listCommits({ repo: 'o/r', cursor: forged }), 'validation');
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects a cursor issued by another provider', async () => {
    const { provider, stub } = setup(() => ({ json: [] }));
    const foreign = encodeCursor('github', { url: 'https://gitea.com/api/v1/repos/o/r/commits' });
    await expectRepoError(provider.listTags({ repo: 'o/r', cursor: foreign }), 'validation');
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects a forged listBranches cursor pointing to another host', async () => {
    const { provider, stub } = setup(() => ({ json: [] }));
    const forged = encodeCursor('gitea', { url: 'https://attacker.example/x' });
    await expectRepoError(provider.listBranches({ repo: 'o/r', cursor: forged }), 'validation');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('error mapping', () => {
  it('maps 401 to unauthorized with the Gitea message', async () => {
    const { provider } = setup(() => ({
      status: 401,
      json: { message: 'token is required', url: 'https://gitea.com/api/swagger' },
    }));
    try {
      await provider.getRepository({ repo: 'o/r' });
      expect.unreachable('expected RepoError');
    } catch (error) {
      expect(error).toBeInstanceOf(RepoError);
      expect((error as RepoError).code).toBe('unauthorized');
      expect((error as RepoError).message).toContain('token is required');
    }
  });

  it('maps 404 to not_found', async () => {
    const { provider } = setup(() => ({ status: 404, json: { message: 'not found' } }));
    await expectRepoError(provider.getRepository({ repo: 'o/r' }), 'not_found');
  });
});

describe('verifyWebhook', () => {
  it('accepts the bare hex signature and rejects a mismatch or missing header', async () => {
    const secret = 'topsecret';
    const body = '{"ref":"refs/heads/main"}';
    const signature = await hmacSha256Hex(secret, body);
    expect(await verifyWebhook({ headers: { 'x-gitea-signature': signature }, body, secret })).toBe(
      true,
    );
    expect(
      await verifyWebhook({
        headers: { 'x-gitea-signature': `sha256=${signature}` },
        body,
        secret,
      }),
    ).toBe(false);
    expect(await verifyWebhook({ headers: { 'x-gitea-signature': 'wrong' }, body, secret })).toBe(
      false,
    );
    expect(await verifyWebhook({ headers: {}, body, secret })).toBe(false);
    expect(
      await verifyWebhook({ headers: { 'x-gitea-signature': signature }, body, secret: '' }),
    ).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('distinguishes push, tag push, release and deletion pushes', async () => {
    const push = await parseWebhookEvent({
      headers: { 'x-gitea-event': 'push', 'x-gitea-delivery': 'uuid-1' },
      body: JSON.stringify({
        ref: 'refs/heads/main',
        after: 'headsha',
        repository: { full_name: 'o/r' },
        commits: [{ id: 'sha1', message: 'msg' }],
      }),
    });
    expect(push).toMatchObject({
      type: 'push',
      repo: 'o/r',
      ref: 'refs/heads/main',
      headCommitSha: 'headsha',
      deliveryId: 'uuid-1',
    });
    expect(push.commits).toEqual([{ sha: 'sha1', message: 'msg' }]);

    const deletion = await parseWebhookEvent({
      headers: { 'x-gitea-event': 'push' },
      body: JSON.stringify({ ref: 'refs/heads/gone', after: '0'.repeat(40) }),
    });
    expect(deletion.headCommitSha).toBeUndefined();

    const tagPush = await parseWebhookEvent({
      headers: { 'x-gitea-event': 'push' },
      body: JSON.stringify({ ref: 'refs/tags/v1.0.0' }),
    });
    expect(tagPush.type).toBe('tag_push');

    const tagCreate = await parseWebhookEvent({
      headers: { 'x-gitea-event': 'create' },
      body: JSON.stringify({ ref: 'v1.0.0', ref_type: 'tag', repository: { full_name: 'o/r' } }),
    });
    expect(tagCreate).toMatchObject({ type: 'tag_push', ref: 'refs/tags/v1.0.0' });

    const branchCreate = await parseWebhookEvent({
      headers: { 'x-gitea-event': 'create' },
      body: JSON.stringify({ ref: 'feature/foo', ref_type: 'branch' }),
    });
    expect(branchCreate.type).toBe('unknown');

    const release = await parseWebhookEvent({
      headers: { 'x-gitea-event': 'release' },
      body: JSON.stringify({ repository: { full_name: 'o/r' } }),
    });
    expect(release.type).toBe('release');

    const other = await parseWebhookEvent({
      headers: { 'x-gitea-event': 'issues' },
      body: JSON.stringify({}),
    });
    expect(other.type).toBe('unknown');
  });
});

describe('commitWebUrl', () => {
  it('builds the commit web URL from the repository web URL', () => {
    expect(commitWebUrl('https://gitea.example.com/o/r', 'abc123')).toBe(
      'https://gitea.example.com/o/r/commit/abc123',
    );
  });
});

describe('getAuthenticatedUser', () => {
  it('maps the /user payload, treating an empty full_name as unset', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        id: 3,
        login: 'robin',
        full_name: '',
        email: 'robin@example.com',
        avatar_url: 'https://gitea.example/avatar.png',
      },
    }));
    const user = await provider.getAuthenticatedUser({});
    expect(user).toMatchObject({
      id: '3',
      username: 'robin',
      email: 'robin@example.com',
      avatarUrl: 'https://gitea.example/avatar.png',
    });
    expect(user.name).toBeUndefined();
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v1/user');
  });
});

describe('tokenProvider auth', () => {
  it('uses the Bearer scheme (not token) and retries once on a 401', async () => {
    const contexts: boolean[] = [];
    const stub = createFetchStub((request) =>
      request.headers.authorization === 'Bearer fresh'
        ? { json: { id: 3, login: 'robin' } }
        : { status: 401, json: { message: 'unauthorized' } },
    );
    const provider = gitea({
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
    expect(stub.requests[0]!.headers.authorization).toBe('Bearer stale');
    expect(contexts).toEqual([false, true]);
  });

  it('embeds the minted token in the clone URL', async () => {
    const stub = createFetchStub(() => ({ status: 500, json: {} }));
    const provider = gitea({
      auth: { tokenProvider: () => Promise.resolve('minted-token') },
      fetch: stub.fetch,
    });
    const clone = await provider.getCloneUrl({ repo: 'acme/app' });
    expect(clone.url).toBe('https://minted-token@gitea.com/acme/app.git');
  });
});

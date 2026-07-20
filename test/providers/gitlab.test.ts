import { describe, expect, it } from 'vitest';
import { commitWebUrl, gitlab, parseWebhookEvent, verifyWebhook } from '../../src/gitlab.ts';
import { RepoError } from '../../src/errors.ts';
import { encodeCursor } from '../../src/pagination.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const TOKEN = 'glpat-testtoken';

function setup(handler: StubHandler, baseUrl?: string) {
  const stub = createFetchStub(handler);
  const provider = gitlab({ auth: { token: TOKEN }, fetch: stub.fetch, baseUrl });
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

const projectPayload = {
  id: 42,
  name: 'repo-sdk',
  path_with_namespace: 'capawesome-team/repo-sdk',
  namespace: { full_path: 'capawesome-team' },
  default_branch: 'main',
  visibility: 'private',
  archived: false,
  web_url: 'https://gitlab.com/capawesome-team/repo-sdk',
  http_url_to_repo: 'https://gitlab.com/capawesome-team/repo-sdk.git',
  ssh_url_to_repo: 'git@gitlab.com:capawesome-team/repo-sdk.git',
};

describe('request headers', () => {
  it('sends a Bearer authorization header', async () => {
    const { provider, stub } = setup(() => ({ json: projectPayload }));
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(stub.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe('project id encoding', () => {
  it('URL-encodes a subgroup path including all slashes', async () => {
    const { provider, stub } = setup(() => ({ json: projectPayload }));
    await provider.getRepository({ repo: 'a/b/c' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v4/projects/a%2Fb%2Fc');
  });

  it('passes a numeric id through unencoded', async () => {
    const { provider, stub } = setup(() => ({ json: projectPayload }));
    await provider.getRepository({ repo: '42' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v4/projects/42');
  });
});

describe('listNamespaces', () => {
  it('returns the personal namespace plus groups and derives subgroup parents', async () => {
    const { provider } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v4/user') {
        return {
          json: {
            id: 1,
            username: 'octocat',
            name: 'Octo Cat',
            avatar_url: 'https://avatars.example/u1',
          },
        };
      }
      if (url.pathname === '/api/v4/groups') {
        if (url.searchParams.get('page') === '2') {
          return { json: [{ id: 30, name: 'Third', full_path: 'a/b/c', parent_id: 20 }] };
        }
        return {
          json: [
            {
              id: 10,
              name: 'Top',
              full_path: 'top',
              parent_id: null,
              avatar_url: 'https://avatars.example/g10',
            },
            { id: 20, name: 'Sub', full_path: 'top/sub', parent_id: 10, avatar_url: null },
          ],
          headers: { link: '<https://gitlab.com/api/v4/groups?page=2>; rel="next"' },
        };
      }
      return { status: 404, json: { message: 'not found' } };
    });

    const first = await provider.listNamespaces({ limit: 20 });
    expect(first.data[0]).toMatchObject({
      slug: 'octocat',
      name: 'Octo Cat',
      kind: 'user',
      id: '1',
      avatarUrl: 'https://avatars.example/u1',
    });
    expect(first.data[1]).toMatchObject({
      slug: 'top',
      kind: 'group',
      parent: undefined,
      avatarUrl: 'https://avatars.example/g10',
    });
    expect(first.data[2]?.avatarUrl).toBeUndefined();
    expect(first.data[2]).toMatchObject({ slug: 'top/sub', kind: 'group', parent: 'top' });
    expect(first.cursor).toBeDefined();

    const second = await provider.listNamespaces({ cursor: first.cursor });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]).toMatchObject({ slug: 'a/b/c', kind: 'group', parent: 'a/b' });
    expect(second.cursor).toBeUndefined();
  });

  it('falls back to name = username when the user has no display name', async () => {
    const { provider } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v4/user') return { json: { id: 1, username: 'octocat' } };
      return { json: [] };
    });
    const page = await provider.listNamespaces({});
    expect(page.data[0]).toMatchObject({ slug: 'octocat', name: 'octocat' });
  });
});

describe('listRepositories', () => {
  it('lists group projects with include_subgroups, owned and search', async () => {
    const { provider, stub } = setup(() => ({ json: [projectPayload] }));
    const page = await provider.listRepositories({
      namespace: 'capawesome-team',
      owned: true,
      query: 'sdk',
    });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/api/v4/groups/capawesome-team/projects');
    expect(url.searchParams.get('include_subgroups')).toBe('true');
    expect(url.searchParams.get('owned')).toBe('true');
    expect(url.searchParams.get('search')).toBe('sdk');
    expect(page.data[0]).toMatchObject({
      id: '42',
      path: 'capawesome-team/repo-sdk',
      namespace: 'capawesome-team',
      private: true,
      urls: {
        web: 'https://gitlab.com/capawesome-team/repo-sdk',
        cloneHttp: 'https://gitlab.com/capawesome-team/repo-sdk.git',
        cloneSsh: 'git@gitlab.com:capawesome-team/repo-sdk.git',
      },
    });
  });

  it('falls back to the user projects endpoint when the group returns 404', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v4/groups/someone/projects') {
        return { status: 404, json: { message: 'not found' } };
      }
      if (url.pathname === '/api/v4/users/someone/projects') {
        return { json: [projectPayload] };
      }
      return { status: 500, json: {} };
    });
    await provider.listRepositories({ namespace: 'someone', query: 'sdk' });
    const last = new URL(stub.requests.at(-1)!.url);
    expect(last.pathname).toBe('/api/v4/users/someone/projects');
    expect(last.searchParams.get('search')).toBe('sdk');
  });

  it('uses membership by default and adds owned when requested', async () => {
    const { provider, stub } = setup(() => ({ json: [projectPayload] }));
    await provider.listRepositories({ owned: true, query: 'sdk' });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/api/v4/projects');
    expect(url.searchParams.get('membership')).toBe('true');
    expect(url.searchParams.get('owned')).toBe('true');
    expect(url.searchParams.get('search')).toBe('sdk');
  });

  it('marks public projects as not private', async () => {
    const { provider } = setup(() => ({ json: [{ ...projectPayload, visibility: 'public' }] }));
    const page = await provider.listRepositories({});
    expect(page.data[0]?.private).toBe(false);
  });
});

describe('listCommits', () => {
  const commitPayload = {
    id: 'abc123',
    message: 'first',
    author_name: 'Robin',
    author_email: 'robin@example.com',
    authored_date: '2026-01-15T10:00:00Z',
    committer_name: 'Robin',
    committer_email: 'robin@example.com',
    committed_date: '2026-01-15T11:00:00Z',
    parent_ids: ['parent1'],
    web_url: 'https://gitlab.com/o/r/-/commit/abc123',
  };

  it('maps query params and normalizes commit fields', async () => {
    const { provider, stub } = setup(() => ({ json: [commitPayload] }));
    const page = await provider.listCommits({
      repo: '42',
      ref: 'main',
      since: new Date('2026-01-01T00:00:00Z'),
      until: new Date('2026-02-01T00:00:00Z'),
      path: 'src/',
      author: 'robin',
      limit: 50,
    });
    const url = new URL(stub.requests[0]!.url);
    expect(url.searchParams.get('ref_name')).toBe('main');
    expect(url.searchParams.get('since')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('until')).toBe('2026-02-01T00:00:00.000Z');
    expect(url.searchParams.get('path')).toBe('src/');
    expect(url.searchParams.get('author')).toBe('robin');
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(page.data[0]).toMatchObject({
      sha: 'abc123',
      message: 'first',
      parents: ['parent1'],
      url: 'https://gitlab.com/o/r/-/commit/abc123',
    });
    expect(page.data[0]?.author).toMatchObject({ name: 'Robin', email: 'robin@example.com' });
    expect(page.data[0]?.author.date.toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(page.data[0]?.committer?.date.toISOString()).toBe('2026-01-15T11:00:00.000Z');
  });

  it('builds the x-next-page cursor when the link header is absent', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('page') === '2')
        return { json: [{ ...commitPayload, id: 'def456' }] };
      return { json: [commitPayload], headers: { 'x-next-page': '2' } };
    });
    const page = await provider.listCommits({ repo: '42', ref: 'main' });
    expect(page.cursor).toBeDefined();

    const next = await provider.listCommits({ repo: '42', cursor: page.cursor });
    expect(next.data[0]?.sha).toBe('def456');
    expect(new URL(stub.requests.at(-1)!.url).searchParams.get('page')).toBe('2');
    expect(next.cursor).toBeUndefined();
  });
});

describe('getCommit', () => {
  it('URL-encodes the ref', async () => {
    const { provider, stub } = setup(() => ({ json: { id: 'abc', message: 'm' } }));
    await provider.getCommit({ repo: '42', ref: 'feature/foo' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/api/v4/projects/42/repository/commits/feature%2Ffoo',
    );
  });
});

describe('listTags', () => {
  it('distinguishes annotated and lightweight tags', async () => {
    const { provider } = setup(() => ({
      json: [
        {
          name: 'v1.0.0',
          message: 'release',
          target: 'tagobjectsha',
          created_at: '2026-01-10T09:00:00Z',
          commit: { id: 'commitsha', committed_date: '2026-01-10T08:00:00Z' },
        },
        {
          name: 'v0.9.0',
          message: null,
          target: 'lightsha',
          created_at: null,
          commit: { id: 'lightsha', committed_date: '2026-01-05T08:00:00Z' },
        },
      ],
    }));
    const page = await provider.listTags({ repo: '42' });
    expect(page.data[0]).toMatchObject({
      name: 'v1.0.0',
      sha: 'commitsha',
      message: 'release',
      isAnnotated: true,
    });
    expect(page.data[0]?.date?.toISOString()).toBe('2026-01-10T08:00:00.000Z');
    expect(page.data[1]).toMatchObject({
      name: 'v0.9.0',
      sha: 'lightsha',
      message: undefined,
      isAnnotated: false,
    });
  });
});

describe('listBranches', () => {
  it('normalizes branches and builds the x-next-page cursor', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('page') === '2') {
        return { json: [{ name: 'develop', commit: { id: 'sha2' } }] };
      }
      return {
        json: [{ name: 'main', commit: { id: 'sha1' } }],
        headers: { 'x-next-page': '2' },
      };
    });
    const page = await provider.listBranches({ repo: '42', limit: 50 });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/api/v4/projects/42/repository/branches');
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(page.data[0]).toMatchObject({ name: 'main', sha: 'sha1' });
    expect(page.cursor).toBeDefined();

    const next = await provider.listBranches({ repo: '42', cursor: page.cursor });
    expect(next.data[0]).toMatchObject({ name: 'develop', sha: 'sha2' });
    expect(new URL(stub.requests.at(-1)!.url).searchParams.get('page')).toBe('2');
    expect(next.cursor).toBeUndefined();
  });

  it('rejects a forged cursor that points to another host', async () => {
    const { provider, stub } = setup(() => ({ json: [] }));
    const forged = encodeCursor('gitlab', { url: 'https://attacker.example/x' });
    await expectRepoError(provider.listBranches({ repo: '42', cursor: forged }), 'validation');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('getBranch', () => {
  it('fetches the single-branch endpoint with an encoded name', async () => {
    const payload = { name: 'feature/login', commit: { id: 'sha1' } };
    const { provider, stub } = setup(() => ({ json: payload }));
    const branch = await provider.getBranch({ repo: '42', name: 'feature/login' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/api/v4/projects/42/repository/branches/feature%2Flogin',
    );
    expect(branch).toEqual({ name: 'feature/login', sha: 'sha1', raw: payload });
  });

  it('maps a 404 to not_found', async () => {
    const { provider } = setup(() => ({ status: 404, json: {} }));
    await expectRepoError(provider.getBranch({ repo: '42', name: 'missing' }), 'not_found');
  });
});

describe('getTag', () => {
  it('fetches the single-tag endpoint and returns the peeled commit SHA', async () => {
    const payload = {
      name: 'v1.0.0',
      message: 'release',
      target: 'tagobjectsha',
      created_at: '2026-01-10T09:00:00Z',
      commit: { id: 'commitsha', committed_date: '2026-01-10T08:00:00Z' },
    };
    const { provider, stub } = setup(() => ({ json: payload }));
    const tag = await provider.getTag({ repo: '42', name: 'v1.0.0' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/api/v4/projects/42/repository/tags/v1.0.0',
    );
    expect(tag).toMatchObject({
      name: 'v1.0.0',
      sha: 'commitsha',
      message: 'release',
      isAnnotated: true,
    });
  });

  it('maps a 404 to not_found', async () => {
    const { provider } = setup(() => ({ status: 404, json: {} }));
    await expectRepoError(provider.getTag({ repo: '42', name: 'missing' }), 'not_found');
  });
});

describe('searchRefs', () => {
  const branchesPayload = [
    { name: 'feature/login', commit: { id: 'sha1' } },
    { name: 'feature/logout', commit: { id: 'sha2' } },
  ];
  const tagsPayload = [{ name: 'feat-tag', commit: { id: 'tagsha' } }];

  it('anchors the query with ^, passes per_page and orders branches before tags', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/v4/projects/42/repository/branches') {
        return { json: branchesPayload };
      }
      if (url.pathname === '/api/v4/projects/42/repository/tags') {
        return { json: tagsPayload };
      }
      return { status: 404, json: {} };
    });
    const matches = await provider.searchRefs({
      repo: '42',
      query: 'feat',
      types: ['branch', 'tag'],
      limit: 20,
    });
    for (const request of stub.requests) {
      const url = new URL(request.url);
      expect(url.searchParams.get('search')).toBe('^feat');
      expect(url.searchParams.get('per_page')).toBe('20');
    }
    expect(matches).toEqual([
      { type: 'branch', name: 'feature/login', sha: 'sha1', raw: branchesPayload[0] },
      { type: 'branch', name: 'feature/logout', sha: 'sha2', raw: branchesPayload[1] },
      { type: 'tag', name: 'feat-tag', sha: 'tagsha', raw: tagsPayload[0] },
    ]);
  });

  it('only queries the requested types and truncates to the limit', async () => {
    const { provider, stub } = setup(() => ({ json: branchesPayload }));
    const matches = await provider.searchRefs({
      repo: '42',
      query: 'feat',
      types: ['branch'],
      limit: 1,
    });
    expect(stub.requests).toHaveLength(1);
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v4/projects/42/repository/branches');
    expect(matches).toEqual([
      { type: 'branch', name: 'feature/login', sha: 'sha1', raw: branchesPayload[0] },
    ]);
  });
});

describe('downloadArchive', () => {
  it('requests the zip format with the sha query param', async () => {
    const { provider, stub } = setup(() => ({
      body: 'ZIPDATA',
      headers: {
        'content-type': 'application/zip',
        'content-disposition': 'attachment; filename="repo-sdk.zip"',
      },
    }));
    const archive = await provider.downloadArchive({ repo: '42', ref: 'v1.0.0', format: 'zip' });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/api/v4/projects/42/repository/archive.zip');
    expect(url.searchParams.get('sha')).toBe('v1.0.0');
    expect(archive.contentType).toBe('application/zip');
    expect(archive.filename).toBe('repo-sdk.zip');
    expect(await new Response(archive.stream).text()).toBe('ZIPDATA');
  });

  it('requests the tar.gz format', async () => {
    const { provider, stub } = setup(() => ({ body: 'TARDATA' }));
    await provider.downloadArchive({ repo: '42', ref: 'main', format: 'tar.gz' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/api/v4/projects/42/repository/archive.tar.gz',
    );
  });
});

describe('getCloneUrl', () => {
  it('fetches the project and injects credentials for a numeric id', async () => {
    const { provider, stub } = setup(() => ({ json: projectPayload }));
    const clone = await provider.getCloneUrl({ repo: '42' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v4/projects/42');
    expect(clone.url).toBe(
      `https://oauth2:${encodeURIComponent(TOKEN)}@gitlab.com/capawesome-team/repo-sdk.git`,
    );
    expect(clone.expiresAt).toBeUndefined();
  });

  it('constructs the clone URL from the path without an API call', async () => {
    const { provider, stub } = setup(() => ({ status: 500, json: {} }));
    const clone = await provider.getCloneUrl({ repo: 'capawesome-team/repo-sdk' });
    expect(stub.requests).toHaveLength(0);
    expect(clone.url).toBe(
      `https://oauth2:${encodeURIComponent(TOKEN)}@gitlab.com/capawesome-team/repo-sdk.git`,
    );
  });

  it('derives the host from a self-managed base URL', async () => {
    const { provider } = setup(() => ({ json: {} }), 'https://gitlab.example.com/api/v4');
    const clone = await provider.getCloneUrl({ repo: 'group/project' });
    expect(clone.url).toBe(
      `https://oauth2:${encodeURIComponent(TOKEN)}@gitlab.example.com/group/project.git`,
    );
  });
});

describe('webhooks', () => {
  it('sends all three event flags explicitly on create', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        id: 99,
        url: 'https://example.com/hook',
        push_events: true,
        tag_push_events: true,
        releases_events: false,
      },
    }));
    const webhook = await provider.createWebhook({
      repo: '42',
      url: 'https://example.com/hook',
      events: ['push', 'tag_push'],
      secret: 'shh',
    });
    const body = JSON.parse(stub.requests[0]!.body!);
    expect(body).toMatchObject({
      url: 'https://example.com/hook',
      token: 'shh',
      enable_ssl_verification: true,
      push_events: true,
      tag_push_events: true,
      releases_events: false,
    });
    expect(webhook).toMatchObject({ id: '99', active: true, events: ['push', 'tag_push'] });
  });

  it('merges existing hook fields on a partial update', async () => {
    const { provider, stub } = setup((request) => {
      if (request.method === 'GET') {
        return {
          json: {
            id: 99,
            url: 'https://existing.example.com/hook',
            push_events: true,
            tag_push_events: false,
            releases_events: true,
          },
        };
      }
      return {
        json: {
          id: 99,
          url: 'https://existing.example.com/hook',
          push_events: false,
          tag_push_events: false,
          releases_events: true,
        },
      };
    });
    const webhook = await provider.updateWebhook({ repo: '42', id: '99', events: ['release'] });
    expect(stub.requests[0]!.method).toBe('GET');
    const putBody = JSON.parse(stub.requests[1]!.body!);
    expect(putBody).toMatchObject({
      url: 'https://existing.example.com/hook',
      push_events: false,
      tag_push_events: false,
      releases_events: true,
    });
    expect(putBody.token).toBeUndefined();
    expect(webhook.events).toEqual(['release']);
  });

  it('deletes a webhook', async () => {
    const { provider, stub } = setup(() => ({ status: 204 }));
    await provider.deleteWebhook({ repo: '42', id: '99' });
    expect(stub.requests[0]!.method).toBe('DELETE');
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v4/projects/42/hooks/99');
  });

  it('creates a webhook when active is omitted', async () => {
    const { provider } = setup(() => ({
      json: { id: 99, url: 'https://example.com/hook', push_events: true },
    }));
    const webhook = await provider.createWebhook({
      repo: '42',
      url: 'https://example.com/hook',
      events: ['push'],
    });
    expect(webhook).toMatchObject({ id: '99', active: true });
  });

  it('rejects creating an inactive webhook (unsupported by GitLab)', async () => {
    const { provider, stub } = setup(() => ({ json: {} }));
    await expectRepoError(
      provider.createWebhook({
        repo: '42',
        url: 'https://example.com/hook',
        events: ['push'],
        active: false,
      }),
      'unsupported',
    );
    expect(stub.requests).toHaveLength(0);
  });

  it('rejects updating a webhook to inactive (unsupported by GitLab)', async () => {
    const { provider, stub } = setup(() => ({ json: {} }));
    await expectRepoError(
      provider.updateWebhook({ repo: '42', id: '99', active: false }),
      'unsupported',
    );
    expect(stub.requests).toHaveLength(0);
  });
});

describe('cursor origin guard', () => {
  it('rejects a forged cursor that points to another host and does not fetch it', async () => {
    const { provider, stub } = setup(() => ({ json: [] }));
    const forged = encodeCursor('gitlab', { url: 'https://attacker.example/x' });
    await expectRepoError(provider.listCommits({ repo: '42', cursor: forged }), 'validation');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('error mapping', () => {
  it('maps 401 to unauthorized', async () => {
    const { provider } = setup(() => ({ status: 401, json: { message: '401 Unauthorized' } }));
    await expectRepoError(provider.getRepository({ repo: '42' }), 'unauthorized');
  });

  it('stringifies a nested validation message object', async () => {
    const { provider } = setup(() => ({
      status: 400,
      json: { message: { url: ['is blocked'] } },
    }));
    try {
      await provider.getRepository({ repo: '42' });
      expect.unreachable('expected RepoError');
    } catch (error) {
      expect((error as RepoError).message).toContain('is blocked');
    }
  });
});

describe('verifyWebhook', () => {
  it('accepts a matching token and rejects a mismatch or missing header', async () => {
    const secret = 'topsecret';
    const body = '{"object_kind":"push"}';
    expect(await verifyWebhook({ headers: { 'x-gitlab-token': secret }, body, secret })).toBe(true);
    expect(await verifyWebhook({ headers: { 'x-gitlab-token': 'wrong' }, body, secret })).toBe(
      false,
    );
    expect(await verifyWebhook({ headers: {}, body, secret })).toBe(false);
    expect(await verifyWebhook({ headers: { 'x-gitlab-token': secret }, body, secret: '' })).toBe(
      false,
    );
  });
});

describe('parseWebhookEvent', () => {
  it('distinguishes push, tag push and release', async () => {
    const push = await parseWebhookEvent({
      headers: {
        'x-gitlab-event': 'Push Hook',
        'x-gitlab-event-uuid': 'uuid-1',
        'x-gitlab-webhook-uuid': 'hook-uuid-1',
      },
      body: JSON.stringify({
        ref: 'refs/heads/main',
        after: 'headsha',
        project: { path_with_namespace: 'o/r' },
        commits: [{ id: 'sha1', message: 'msg' }],
      }),
    });
    expect(push).toMatchObject({
      type: 'push',
      repo: 'o/r',
      ref: 'refs/heads/main',
      headCommitSha: 'headsha',
      deliveryId: 'uuid-1',
      webhookId: 'hook-uuid-1',
    });
    expect(push.commits).toEqual([{ sha: 'sha1', message: 'msg' }]);

    const deletion = await parseWebhookEvent({
      headers: { 'x-gitlab-event': 'Push Hook' },
      body: JSON.stringify({ ref: 'refs/heads/gone', after: '0'.repeat(40) }),
    });
    expect(deletion.headCommitSha).toBeUndefined();

    const tagPush = await parseWebhookEvent({
      headers: { 'x-gitlab-event': 'Tag Push Hook' },
      body: JSON.stringify({ ref: 'refs/tags/v1.0.0' }),
    });
    expect(tagPush.type).toBe('tag_push');

    const release = await parseWebhookEvent({
      headers: { 'x-gitlab-event': 'Release Hook' },
      body: JSON.stringify({ project: { path_with_namespace: 'o/r' } }),
    });
    expect(release.type).toBe('release');

    const other = await parseWebhookEvent({
      headers: { 'x-gitlab-event': 'Issue Hook' },
      body: JSON.stringify({}),
    });
    expect(other.type).toBe('unknown');
  });
});

describe('commitWebUrl', () => {
  it('builds the commit web URL from the repository web URL', () => {
    expect(commitWebUrl('https://gitlab.com/group/project', 'abc123')).toBe(
      'https://gitlab.com/group/project/-/commit/abc123',
    );
  });
});

describe('getAuthenticatedUser', () => {
  it('maps the /user payload', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        id: 5,
        username: 'robin',
        name: 'Robin',
        email: 'robin@example.com',
        avatar_url: 'https://gitlab.example/avatar.png',
      },
    }));
    const user = await provider.getAuthenticatedUser({});
    expect(user).toMatchObject({
      id: '5',
      username: 'robin',
      name: 'Robin',
      email: 'robin@example.com',
      avatarUrl: 'https://gitlab.example/avatar.png',
    });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/api/v4/user');
  });

  it('falls back to public_email when email is absent', async () => {
    const { provider } = setup(() => ({
      json: { id: 5, username: 'robin', public_email: 'public@example.com' },
    }));
    const user = await provider.getAuthenticatedUser({});
    expect(user.email).toBe('public@example.com');
  });
});

describe('tokenProvider auth', () => {
  it('sends the minted token and retries once with forceRefresh on a 401', async () => {
    const contexts: boolean[] = [];
    const stub = createFetchStub((request) =>
      request.headers.authorization === 'Bearer fresh'
        ? { json: { id: 5, username: 'robin' } }
        : { status: 401, json: { message: 'unauthorized' } },
    );
    const provider = gitlab({
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

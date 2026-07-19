import { beforeAll, describe, expect, it } from 'vitest';
import { commitWebUrl, github, parseWebhookEvent, verifyWebhook } from '../../src/github.ts';
import { RepoError } from '../../src/errors.ts';
import { encodeCursor } from '../../src/pagination.ts';
import { hmacSha256Hex } from '../../src/webhooks/verify.ts';
import { createFetchStub, type StubHandler } from '../helpers/fetch-stub.ts';

const TOKEN = 'ghp_testtoken';

function setup(handler: StubHandler, baseUrl?: string) {
  const stub = createFetchStub(handler);
  const provider = github({ auth: { token: TOKEN }, fetch: stub.fetch, baseUrl });
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
  html_url: 'https://github.com/capawesome-team/repo-sdk',
  clone_url: 'https://github.com/capawesome-team/repo-sdk.git',
  ssh_url: 'git@github.com:capawesome-team/repo-sdk.git',
};

describe('request headers', () => {
  it('sends auth, accept, api-version and user-agent headers', async () => {
    const { provider, stub } = setup(() => ({ json: repoPayload }));
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    const headers = stub.requests[0]!.headers;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers.accept).toBe('application/vnd.github+json');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
    expect(headers['user-agent']).toBe('repo-sdk');
  });
});

describe('listNamespaces', () => {
  it('returns user plus orgs on the first page and orgs only on the cursor page', async () => {
    const { provider } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/user') {
        return { json: { id: 1, login: 'octocat', avatar_url: 'https://avatars.example/u1' } };
      }
      if (url.pathname === '/user/orgs') {
        if (url.searchParams.get('page') === '2') return { json: [{ id: 20, login: 'org2' }] };
        return {
          json: [{ id: 10, login: 'org1', avatar_url: 'https://avatars.example/o10' }],
          headers: { link: '<https://api.github.com/user/orgs?page=2>; rel="next"' },
        };
      }
      return { status: 404, json: { message: 'not found' } };
    });

    const first = await provider.listNamespaces({});
    expect(first.data[0]).toMatchObject({
      slug: 'octocat',
      kind: 'user',
      id: '1',
      avatarUrl: 'https://avatars.example/u1',
    });
    expect(first.data[1]).toMatchObject({
      slug: 'org1',
      kind: 'organization',
      id: '10',
      avatarUrl: 'https://avatars.example/o10',
    });
    expect(first.cursor).toBeDefined();

    const second = await provider.listNamespaces({ cursor: first.cursor });
    expect(second.data).toHaveLength(1);
    expect(second.data[0]).toMatchObject({ slug: 'org2', kind: 'organization' });
    expect(second.cursor).toBeUndefined();
  });
});

describe('listRepositories', () => {
  it('uses affiliation=owner when owned is set', async () => {
    const { provider, stub } = setup(() => ({ json: [repoPayload] }));
    await provider.listRepositories({ owned: true });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/user/repos');
    expect(url.searchParams.get('affiliation')).toBe('owner');
  });

  it('falls back to /user/repos when the namespace is the authenticated user (404 on orgs)', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/orgs/octocat/repos') return { status: 404, json: { message: 'nf' } };
      if (url.pathname === '/user') return { json: { id: 1, login: 'octocat' } };
      if (url.pathname === '/user/repos') return { json: [repoPayload] };
      return { status: 500, json: {} };
    });
    const page = await provider.listRepositories({ namespace: 'octocat' });
    expect(page.data[0]?.path).toBe('capawesome-team/repo-sdk');
    const last = new URL(stub.requests.at(-1)!.url);
    expect(last.pathname).toBe('/user/repos');
    expect(last.searchParams.get('affiliation')).toBe('owner');
  });

  it('falls back to /users/{ns}/repos for a different user namespace', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/orgs/someone/repos') return { status: 404, json: { message: 'nf' } };
      if (url.pathname === '/user') return { json: { id: 1, login: 'octocat' } };
      if (url.pathname === '/users/someone/repos') return { json: [repoPayload] };
      return { status: 500, json: {} };
    });
    await provider.listRepositories({ namespace: 'someone' });
    expect(new URL(stub.requests.at(-1)!.url).pathname).toBe('/users/someone/repos');
  });

  it('uses the search endpoint with a namespace qualifier for free-text queries', async () => {
    const { provider, stub } = setup(() => ({ json: { items: [repoPayload] } }));
    const page = await provider.listRepositories({ query: 'sdk', namespace: 'capawesome-team' });
    const url = new URL(stub.requests[0]!.url);
    expect(url.pathname).toBe('/search/repositories');
    expect(url.searchParams.get('q')).toBe('sdk user:capawesome-team');
    expect(page.data[0]?.name).toBe('repo-sdk');
  });
});

describe('cursor SSRF protection', () => {
  const forgedCursor = encodeCursor('github', { url: 'https://attacker.example/x' });

  const cases: {
    name: string;
    call: (p: ReturnType<typeof setup>['provider']) => Promise<unknown>;
  }[] = [
    { name: 'listNamespaces', call: (p) => p.listNamespaces({ cursor: forgedCursor }) },
    { name: 'listRepositories', call: (p) => p.listRepositories({ cursor: forgedCursor }) },
    { name: 'listCommits', call: (p) => p.listCommits({ repo: 'o/r', cursor: forgedCursor }) },
    { name: 'listTags', call: (p) => p.listTags({ repo: 'o/r', cursor: forgedCursor }) },
    { name: 'listBranches', call: (p) => p.listBranches({ repo: 'o/r', cursor: forgedCursor }) },
    { name: 'listWebhooks', call: (p) => p.listWebhooks({ repo: 'o/r', cursor: forgedCursor }) },
  ];

  for (const { name, call } of cases) {
    it(`${name} rejects a cross-origin cursor without fetching the attacker host`, async () => {
      const { provider, stub } = setup(() => ({ json: [] }));
      await expectRepoError(call(provider), 'validation');
      expect(stub.requests.some((r) => r.url.includes('attacker.example'))).toBe(false);
    });
  }
});

describe('getRepository', () => {
  it('normalizes the repository payload', async () => {
    const { provider } = setup(() => ({ json: repoPayload }));
    const repo = await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(repo).toMatchObject({
      id: '42',
      name: 'repo-sdk',
      path: 'capawesome-team/repo-sdk',
      namespace: 'capawesome-team',
      defaultBranch: 'main',
      private: true,
      archived: false,
      urls: {
        web: 'https://github.com/capawesome-team/repo-sdk',
        cloneHttp: 'https://github.com/capawesome-team/repo-sdk.git',
        cloneSsh: 'git@github.com:capawesome-team/repo-sdk.git',
      },
    });
  });

  it('constructs urls.web when html_url is absent', async () => {
    const { provider } = setup(() => ({ json: { ...repoPayload, html_url: undefined } }));
    const repo = await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(repo.urls.web).toBe('https://github.com/capawesome-team/repo-sdk');
  });

  it('constructs urls.web from the enterprise host when html_url is absent', async () => {
    const { provider } = setup(
      () => ({ json: { ...repoPayload, html_url: undefined } }),
      'https://ghe.example.com/api/v3',
    );
    const repo = await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(repo.urls.web).toBe('https://ghe.example.com/capawesome-team/repo-sdk');
  });
});

describe('getAuthenticatedUser', () => {
  it('maps the /user payload and reports the userProfile capability', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        id: 7,
        login: 'octocat',
        name: 'Octo Cat',
        email: 'octo@example.com',
        avatar_url: 'https://avatars.example/u7',
      },
    }));
    expect(provider.capabilities.userProfile).toBe(true);
    const user = await provider.getAuthenticatedUser({});
    expect(user).toMatchObject({
      id: '7',
      username: 'octocat',
      name: 'Octo Cat',
      email: 'octo@example.com',
      avatarUrl: 'https://avatars.example/u7',
    });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/user');
  });

  it('drops null name and email', async () => {
    const { provider } = setup(() => ({
      json: { id: 7, login: 'octocat', name: null, email: null },
    }));
    const user = await provider.getAuthenticatedUser({});
    expect(user.name).toBeUndefined();
    expect(user.email).toBeUndefined();
  });

  describe('includeEmail', () => {
    const privateEmailProfile = { id: 7, login: 'octocat', email: null };

    function emailSetup(emails: () => { status?: number; json: unknown }) {
      return setup((request) => {
        const url = new URL(request.url);
        if (url.pathname === '/user/emails') return emails();
        return { json: privateEmailProfile };
      });
    }

    it('resolves the primary verified email when the profile hides it', async () => {
      const { provider, stub } = emailSetup(() => ({
        json: [
          { email: 'secondary@example.com', primary: false, verified: true },
          { email: 'unverified@example.com', primary: true, verified: false },
          { email: 'primary@example.com', primary: true, verified: true },
        ],
      }));
      const user = await provider.getAuthenticatedUser({ includeEmail: true });
      expect(user.email).toBe('primary@example.com');
      expect(stub.requests.map((r) => new URL(r.url).pathname)).toEqual(['/user', '/user/emails']);
    });

    it('skips the emails call when the profile already carries an email', async () => {
      const { provider, stub } = setup(() => ({
        json: { id: 7, login: 'octocat', email: 'public@example.com' },
      }));
      const user = await provider.getAuthenticatedUser({ includeEmail: true });
      expect(user.email).toBe('public@example.com');
      expect(stub.requests).toHaveLength(1);
    });

    it('leaves email unset when the emails call is forbidden (missing user:email scope)', async () => {
      const { provider } = emailSetup(() => ({
        status: 403,
        json: { message: 'Resource not accessible' },
      }));
      const user = await provider.getAuthenticatedUser({ includeEmail: true });
      expect(user.username).toBe('octocat');
      expect(user.email).toBeUndefined();
    });

    it('propagates non-scope failures from the emails call', async () => {
      const { provider } = emailSetup(() => ({ status: 500, json: { message: 'oops' } }));
      await expectRepoError(
        provider.getAuthenticatedUser({ includeEmail: true }),
        'provider_error',
      );
    });
  });
});

describe('listCommits', () => {
  const commitPayload = {
    sha: 'abc123',
    html_url: 'https://github.com/o/r/commit/abc123',
    parents: [{ sha: 'parent1' }],
    commit: {
      message: 'first',
      author: { name: 'Robin', email: 'robin@example.com', date: '2026-01-15T10:00:00Z' },
      committer: { name: 'Robin', email: 'robin@example.com', date: '2026-01-15T10:00:00Z' },
    },
  };

  it('maps query params and round-trips the Link cursor', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('page') === '2') {
        return { json: [{ ...commitPayload, sha: 'def456' }] };
      }
      return {
        json: [commitPayload],
        headers: { link: '<https://api.github.com/repos/o/r/commits?page=2>; rel="next"' },
      };
    });

    const page = await provider.listCommits({
      repo: 'o/r',
      ref: 'main',
      since: new Date('2026-01-01T00:00:00Z'),
      until: new Date('2026-02-01T00:00:00Z'),
      path: 'src/',
      author: 'robin',
      limit: 50,
    });
    const url = new URL(stub.requests[0]!.url);
    expect(url.searchParams.get('sha')).toBe('main');
    expect(url.searchParams.get('path')).toBe('src/');
    expect(url.searchParams.get('author')).toBe('robin');
    expect(url.searchParams.get('since')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('until')).toBe('2026-02-01T00:00:00.000Z');
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(page.data[0]).toMatchObject({
      sha: 'abc123',
      message: 'first',
      parents: ['parent1'],
      url: 'https://github.com/o/r/commit/abc123',
    });
    expect(page.data[0]?.author.date).toBeInstanceOf(Date);
    expect(page.data[0]?.author.email).toBe('robin@example.com');
    expect(page.cursor).toBeDefined();

    const next = await provider.listCommits({ repo: 'o/r', cursor: page.cursor });
    expect(next.data[0]?.sha).toBe('def456');
    expect(next.cursor).toBeUndefined();
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
});

describe('getCommit', () => {
  it('URL-encodes the ref', async () => {
    const { provider, stub } = setup(() => ({ json: { sha: 'abc', commit: { message: 'm' } } }));
    await provider.getCommit({ repo: 'o/r', ref: 'feature/foo' });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/repos/o/r/commits/feature%2Ffoo');
  });
});

describe('listTags', () => {
  it('normalizes tags without dates', async () => {
    const { provider } = setup(() => ({
      json: [{ name: 'v1.0.0', commit: { sha: 'tagsha' } }],
    }));
    const page = await provider.listTags({ repo: 'o/r' });
    expect(page.data[0]).toMatchObject({ name: 'v1.0.0', sha: 'tagsha' });
    expect(page.data[0]?.date).toBeUndefined();
  });
});

describe('listBranches', () => {
  it('normalizes branches and round-trips the Link cursor', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.searchParams.get('page') === '2') {
        return { json: [{ name: 'develop', commit: { sha: 'sha2' } }] };
      }
      return {
        json: [{ name: 'main', commit: { sha: 'sha1' } }],
        headers: { link: '<https://api.github.com/repos/o/r/branches?page=2>; rel="next"' },
      };
    });
    const page = await provider.listBranches({ repo: 'o/r', limit: 50 });
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/repos/o/r/branches');
    expect(new URL(stub.requests[0]!.url).searchParams.get('per_page')).toBe('50');
    expect(page.data[0]).toMatchObject({ name: 'main', sha: 'sha1' });
    expect(page.cursor).toBeDefined();

    const next = await provider.listBranches({ repo: 'o/r', cursor: page.cursor });
    expect(next.data[0]).toMatchObject({ name: 'develop', sha: 'sha2' });
    expect(next.cursor).toBeUndefined();
  });
});

describe('searchRefs', () => {
  const headsPayload = [
    { ref: 'refs/heads/feature/login', object: { sha: 'sha1', type: 'commit' } },
    { ref: 'refs/heads/feature/logout', object: { sha: 'sha2', type: 'commit' } },
  ];
  const tagsPayload = [{ ref: 'refs/tags/feat-tag', object: { sha: 'tagobj', type: 'tag' } }];

  it('queries matching-refs per namespace and maps branches before tags', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/repos/o/r/git/matching-refs/heads/')) {
        return { json: headsPayload };
      }
      if (url.pathname.startsWith('/repos/o/r/git/matching-refs/tags/')) {
        return { json: tagsPayload };
      }
      return { status: 404, json: {} };
    });
    const matches = await provider.searchRefs({
      repo: 'o/r',
      query: 'feat',
      types: ['branch', 'tag'],
      limit: 20,
    });
    expect(stub.requests.map((r) => new URL(r.url).pathname).sort()).toEqual([
      '/repos/o/r/git/matching-refs/heads/feat',
      '/repos/o/r/git/matching-refs/tags/feat',
    ]);
    expect(matches).toEqual([
      { type: 'branch', name: 'feature/login', sha: 'sha1', raw: headsPayload[0] },
      { type: 'branch', name: 'feature/logout', sha: 'sha2', raw: headsPayload[1] },
      { type: 'tag', name: 'feat-tag', sha: 'tagobj', raw: tagsPayload[0] },
    ]);
  });

  it('preserves slashes in the query while encoding other characters', async () => {
    const { provider, stub } = setup(() => ({ json: [] }));
    await provider.searchRefs({
      repo: 'o/r',
      query: 'feature/log in',
      types: ['branch'],
      limit: 20,
    });
    expect(stub.requests).toHaveLength(1);
    expect(new URL(stub.requests[0]!.url).pathname).toBe(
      '/repos/o/r/git/matching-refs/heads/feature/log%20in',
    );
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
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe('feature/login');
  });
});

describe('downloadArchive', () => {
  it('follows a 302 to codeload without forwarding the Authorization header', async () => {
    const { provider, stub } = setup((request) => {
      const url = new URL(request.url);
      if (url.hostname === 'api.github.com' && url.pathname.includes('/zipball/')) {
        return { status: 302, headers: { location: 'https://codeload.github.com/o/r/zip/main' } };
      }
      if (url.hostname === 'codeload.github.com') {
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

    const codeloadRequest = stub.requests.find((r) => r.url.includes('codeload.github.com'));
    expect(codeloadRequest).toBeDefined();
    expect(codeloadRequest!.headers.authorization).toBeUndefined();
  });

  it('throws when the redirect target returns an error status instead of a stream', async () => {
    const { provider } = setup((request) => {
      const url = new URL(request.url);
      if (url.hostname === 'api.github.com' && url.pathname.includes('/zipball/')) {
        return { status: 302, headers: { location: 'https://codeload.github.com/o/r/zip/main' } };
      }
      if (url.hostname === 'codeload.github.com') {
        return { status: 404, json: { message: 'Not Found' } };
      }
      return { status: 500, json: {} };
    });

    await expectRepoError(
      provider.downloadArchive({ repo: 'o/r', ref: 'main', format: 'zip' }),
      'not_found',
    );
  });
});

describe('getCloneUrl', () => {
  it('embeds the token for the default host', async () => {
    const { provider } = setup(() => ({ json: {} }));
    const clone = await provider.getCloneUrl({ repo: 'o/r' });
    expect(clone.url).toBe(`https://x-access-token:${TOKEN}@github.com/o/r.git`);
    expect(clone.expiresAt).toBeUndefined();
  });

  it('derives the git host from a GHES base URL', async () => {
    const { provider } = setup(() => ({ json: {} }), 'https://ghe.example.com/api/v3');
    const clone = await provider.getCloneUrl({ repo: 'o/r' });
    expect(clone.url).toBe(`https://x-access-token:${TOKEN}@ghe.example.com/o/r.git`);
  });
});

describe('webhooks', () => {
  it('maps tag_push to create+delete and normalizes the response back', async () => {
    const { provider, stub } = setup(() => ({
      json: {
        id: 99,
        active: true,
        events: ['create', 'delete', 'push'],
        config: { url: 'https://example.com/hook' },
      },
    }));
    const webhook = await provider.createWebhook({
      repo: 'o/r',
      url: 'https://example.com/hook',
      events: ['tag_push', 'push'],
      secret: 'shh',
    });
    const body = JSON.parse(stub.requests[0]!.body!);
    expect(body.name).toBe('web');
    expect(body.active).toBe(true);
    expect(body.events).toEqual(['create', 'delete', 'push']);
    expect(body.config).toMatchObject({
      url: 'https://example.com/hook',
      content_type: 'json',
      insecure_ssl: '0',
      secret: 'shh',
    });
    expect(webhook.id).toBe('99');
    expect(webhook.events).toEqual(['tag_push', 'push']);
  });

  it('deletes a webhook expecting 204', async () => {
    const { provider, stub } = setup(() => ({ status: 204 }));
    await provider.deleteWebhook({ repo: 'o/r', id: '99' });
    expect(stub.requests[0]!.method).toBe('DELETE');
    expect(new URL(stub.requests[0]!.url).pathname).toBe('/repos/o/r/hooks/99');
  });
});

describe('updateWebhook', () => {
  const existingHook = {
    id: 99,
    active: true,
    events: ['push'],
    config: { url: 'https://old.example/hook', content_type: 'json', insecure_ssl: '0' },
  };

  function hookSetup() {
    return setup((request) => {
      if (request.method === 'PATCH') {
        const body = JSON.parse(request.body!) as Record<string, unknown>;
        return {
          json: {
            id: 99,
            active: body.active ?? existingHook.active,
            events: body.events ?? existingHook.events,
            config: body.config ?? existingHook.config,
          },
        };
      }
      return { json: existingHook };
    });
  }

  it('preserves the stored secret when only the url changes (GET-then-merge, no secret key)', async () => {
    const { provider, stub } = hookSetup();
    await provider.updateWebhook({ repo: 'o/r', id: '99', url: 'https://new.example/hook' });

    const get = stub.requests.find((r) => r.method === 'GET');
    expect(get).toBeDefined();
    const patch = stub.requests.find((r) => r.method === 'PATCH')!;
    const body = JSON.parse(patch.body!) as { config: Record<string, unknown> };
    expect(body.config.url).toBe('https://new.example/hook');
    expect('secret' in body.config).toBe(false);
    expect(body.config.content_type).toBe('json');
    expect(body.config.insecure_ssl).toBe('0');
  });

  it('includes the existing url when only the secret changes', async () => {
    const { provider, stub } = hookSetup();
    await provider.updateWebhook({ repo: 'o/r', id: '99', secret: 'newsecret' });

    const patch = stub.requests.find((r) => r.method === 'PATCH')!;
    const body = JSON.parse(patch.body!) as { config: Record<string, unknown> };
    expect(body.config.url).toBe('https://old.example/hook');
    expect(body.config.secret).toBe('newsecret');
  });

  it('sends no config block (and skips the GET) when only active/events change', async () => {
    const { provider, stub } = hookSetup();
    await provider.updateWebhook({ repo: 'o/r', id: '99', active: false });

    expect(stub.requests.some((r) => r.method === 'GET')).toBe(false);
    const patch = stub.requests.find((r) => r.method === 'PATCH')!;
    const body = JSON.parse(patch.body!) as Record<string, unknown>;
    expect('config' in body).toBe(false);
    expect(body.active).toBe(false);
  });
});

describe('error mapping', () => {
  it('maps 401 to unauthorized', async () => {
    const { provider } = setup(() => ({ status: 401, json: { message: 'Bad credentials' } }));
    await expectRepoError(provider.getRepository({ repo: 'o/r' }), 'unauthorized');
  });

  it('maps 403 with exhausted rate limit to rate_limited', async () => {
    const { provider } = setup(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' },
      json: { message: 'API rate limit exceeded' },
    }));
    await expectRepoError(provider.getRepository({ repo: 'o/r' }), 'rate_limited');
  });
});

describe('verifyWebhook', () => {
  it('accepts a valid signature and rejects an invalid one', async () => {
    const secret = 'topsecret';
    const body = '{"zen":"Keep it simple"}';
    const signature = `sha256=${await hmacSha256Hex(secret, body)}`;
    expect(
      await verifyWebhook({ headers: { 'x-hub-signature-256': signature }, body, secret }),
    ).toBe(true);
    expect(
      await verifyWebhook({ headers: { 'x-hub-signature-256': 'sha256=deadbeef' }, body, secret }),
    ).toBe(false);
  });

  it('returns false when the header or secret is missing', async () => {
    expect(await verifyWebhook({ headers: {}, body: '{}', secret: 'x' })).toBe(false);
    expect(
      await verifyWebhook({
        headers: { 'x-hub-signature-256': 'sha256=x' },
        body: '{}',
        secret: '',
      }),
    ).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('distinguishes push, tag push, tag create and ping', async () => {
    const push = await parseWebhookEvent({
      headers: { 'x-github-event': 'push', 'x-github-delivery': 'd1', 'x-github-hook-id': 'h1' },
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
      deliveryId: 'd1',
      webhookId: 'h1',
    });
    expect(push.commits).toEqual([{ sha: 'sha1', message: 'msg' }]);

    const deletion = await parseWebhookEvent({
      headers: { 'x-github-event': 'push' },
      body: JSON.stringify({ ref: 'refs/heads/gone', after: '0'.repeat(40) }),
    });
    expect(deletion.type).toBe('push');
    expect(deletion.headCommitSha).toBeUndefined();

    const tagPush = await parseWebhookEvent({
      headers: { 'x-github-event': 'push' },
      body: JSON.stringify({ ref: 'refs/tags/v1.0.0' }),
    });
    expect(tagPush.type).toBe('tag_push');

    const tagCreate = await parseWebhookEvent({
      headers: { 'x-github-event': 'create' },
      body: JSON.stringify({ ref: 'v1.0.0', ref_type: 'tag' }),
    });
    expect(tagCreate).toMatchObject({ type: 'tag_push', ref: 'refs/tags/v1.0.0' });

    const branchCreate = await parseWebhookEvent({
      headers: { 'x-github-event': 'create' },
      body: JSON.stringify({ ref: 'feature', ref_type: 'branch' }),
    });
    expect(branchCreate.type).toBe('unknown');

    const ping = await parseWebhookEvent({
      headers: { 'x-github-event': 'ping' },
      body: JSON.stringify({ zen: 'hi' }),
    });
    expect(ping.type).toBe('ping');
  });
});

describe('GitHub App auth avoids user-scoped endpoints', () => {
  const APP_ID = 12345;
  const INSTALLATION_TOKEN = 'ghs_installationtoken';
  let appPem: string;

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
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    const base64 = btoa(String.fromCharCode(...pkcs8))
      .match(/.{1,64}/g)!
      .join('\n');
    appPem = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
  });

  const appRepoPayload = {
    id: 42,
    name: 'repo-sdk',
    full_name: 'capawesome-team/repo-sdk',
    owner: { login: 'capawesome-team', type: 'Organization' },
    private: true,
  };

  function appSetup(handler: StubHandler) {
    const stub = createFetchStub((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/app/installations') return { json: [{ id: 99 }] };
      if (url.pathname.endsWith('/access_tokens')) {
        return {
          json: {
            token: INSTALLATION_TOKEN,
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          },
        };
      }
      return handler(request);
    });
    const provider = github({
      auth: { appId: APP_ID, privateKey: appPem, installationId: 99 },
      fetch: stub.fetch,
    });
    return { provider, stub };
  }

  it('listNamespaces uses /installation/repositories instead of /user', async () => {
    const { provider, stub } = appSetup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/installation/repositories') {
        return { json: { repositories: [appRepoPayload] } };
      }
      return { status: 404, json: {} };
    });

    const page = await provider.listNamespaces({});
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ slug: 'capawesome-team', kind: 'organization' });
    expect(page.cursor).toBeUndefined();

    const paths = stub.requests.map((r) => new URL(r.url).pathname);
    expect(paths).toContain('/installation/repositories');
    expect(paths).not.toContain('/user');
    expect(paths).not.toContain('/user/orgs');
  });

  it('returns an empty page when the installation has no repositories', async () => {
    const { provider } = appSetup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/installation/repositories') return { json: { repositories: [] } };
      return { status: 404, json: {} };
    });
    const page = await provider.listNamespaces({});
    expect(page.data).toHaveLength(0);
  });

  it('listRepositories default path uses /installation/repositories instead of /user/repos', async () => {
    const { provider, stub } = appSetup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/installation/repositories') {
        return { json: { repositories: [appRepoPayload] } };
      }
      return { status: 404, json: {} };
    });

    const page = await provider.listRepositories({});
    expect(page.data[0]?.path).toBe('capawesome-team/repo-sdk');

    const paths = stub.requests.map((r) => new URL(r.url).pathname);
    expect(paths).toContain('/installation/repositories');
    expect(paths).not.toContain('/user/repos');
  });

  it('keeps the namespace-scoped org path under app auth', async () => {
    const { provider, stub } = appSetup((request) => {
      const url = new URL(request.url);
      if (url.pathname === '/orgs/capawesome-team/repos') return { json: [appRepoPayload] };
      return { status: 404, json: {} };
    });

    await provider.listRepositories({ namespace: 'capawesome-team' });
    const paths = stub.requests.map((r) => new URL(r.url).pathname);
    expect(paths).toContain('/orgs/capawesome-team/repos');
    expect(paths).not.toContain('/user');
  });

  it('rejects search-by-self (query + owned) as unsupported', async () => {
    const { provider } = appSetup(() => ({ status: 404, json: {} }));
    await expectRepoError(provider.listRepositories({ query: 'sdk', owned: true }), 'unsupported');
  });
});

describe('commitWebUrl', () => {
  it('builds the commit web URL from the repository web URL', () => {
    expect(commitWebUrl('https://github.com/o/r', 'abc123')).toBe(
      'https://github.com/o/r/commit/abc123',
    );
    expect(commitWebUrl('https://github.com/o/r/', 'abc123')).toBe(
      'https://github.com/o/r/commit/abc123',
    );
  });
});

describe('tokenProvider auth', () => {
  it('sends the minted token as a bearer token', async () => {
    const stub = createFetchStub(() => ({ json: repoPayload }));
    const provider = github({
      auth: { tokenProvider: () => Promise.resolve('minted-token') },
      fetch: stub.fetch,
    });
    await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(stub.requests[0]!.headers.authorization).toBe('Bearer minted-token');
  });

  it('refreshes once with forceRefresh and retries on a 401', async () => {
    const contexts: boolean[] = [];
    const stub = createFetchStub((request) =>
      request.headers.authorization === 'Bearer fresh'
        ? { json: repoPayload }
        : { status: 401, json: { message: 'Bad credentials' } },
    );
    const provider = github({
      auth: {
        tokenProvider: ({ forceRefresh }) => {
          contexts.push(forceRefresh);
          return Promise.resolve(forceRefresh ? 'fresh' : 'stale');
        },
      },
      fetch: stub.fetch,
    });
    const repo = await provider.getRepository({ repo: 'capawesome-team/repo-sdk' });
    expect(repo.path).toBe('capawesome-team/repo-sdk');
    expect(contexts).toEqual([false, true]);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1]!.headers.authorization).toBe('Bearer fresh');
  });

  it('fails with unauthorized after a single refresh attempt', async () => {
    const stub = createFetchStub(() => ({ status: 401, json: { message: 'Bad credentials' } }));
    const provider = github({
      auth: { tokenProvider: () => Promise.resolve('always-stale') },
      fetch: stub.fetch,
    });
    await expectRepoError(provider.getRepository({ repo: 'o/r' }), 'unauthorized');
    expect(stub.requests).toHaveLength(2);
  });

  it('does not retry a 401 under static token auth', async () => {
    const { provider, stub } = setup(() => ({
      status: 401,
      json: { message: 'Bad credentials' },
    }));
    await expectRepoError(provider.getRepository({ repo: 'o/r' }), 'unauthorized');
    expect(stub.requests).toHaveLength(1);
  });
});

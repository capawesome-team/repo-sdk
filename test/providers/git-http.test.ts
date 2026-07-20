import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/index.ts';
import { gitHttp } from '../../src/git-http.ts';
import { RepoError } from '../../src/errors.ts';
import { encodeCursor } from '../../src/pagination.ts';
import { createFetchStub, type StubHandler, type StubResponseInit } from '../helpers/fetch-stub.ts';

const REPO = 'https://git.example.com/team/app.git';
const SHA_MAIN = 'a'.repeat(40);
const SHA_FEATURE = 'b'.repeat(40);
const SHA_TAG_OBJECT = 'c'.repeat(40);
const SHA_TAG_COMMIT = 'd'.repeat(40);
const SHA_LIGHT_TAG = 'e'.repeat(40);

const ADVERTISEMENT_HEADERS = {
  'content-type': 'application/x-git-upload-pack-advertisement',
};

function pkt(line: string): string {
  const length = new TextEncoder().encode(line).length + 4;
  return length.toString(16).padStart(4, '0') + line;
}

function advertisement(
  records: string[],
  capabilities = 'multi_ack thin-pack symref=HEAD:refs/heads/main agent=git/2.46.0',
): StubResponseInit {
  const [first, ...rest] = records;
  const lines = [
    pkt('# service=git-upload-pack\n'),
    '0000',
    ...(first === undefined ? [] : [pkt(`${first}\0${capabilities}\n`)]),
    ...rest.map((record) => pkt(`${record}\n`)),
    '0000',
  ];
  return { body: lines.join(''), headers: ADVERTISEMENT_HEADERS };
}

const DEFAULT_RECORDS = [
  `${SHA_MAIN} HEAD`,
  `${SHA_FEATURE} refs/heads/feature/login`,
  `${SHA_MAIN} refs/heads/main`,
  `${SHA_LIGHT_TAG} refs/tags/v0.9.0`,
  `${SHA_TAG_OBJECT} refs/tags/v1.0.0`,
  `${SHA_TAG_COMMIT} refs/tags/v1.0.0^{}`,
];

function setup(handler?: StubHandler, options?: Parameters<typeof gitHttp>[0]) {
  const stub = createFetchStub(handler ?? (() => advertisement(DEFAULT_RECORDS)));
  const provider = gitHttp({ ...options, fetch: stub.fetch });
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

describe('ref advertisement request', () => {
  it('requests info/refs with the upload-pack service and no credentials by default', async () => {
    const { provider, stub } = setup(undefined, { auth: { password: 'secret' } });
    await provider.listBranches({ repo: REPO });
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.url).toBe(`${REPO}/info/refs?service=git-upload-pack`);
    expect(stub.requests[0]!.headers.authorization).toBeUndefined();
  });

  it('normalizes trailing slashes in the repository URL', async () => {
    const { provider, stub } = setup();
    await provider.listBranches({ repo: `${REPO}/` });
    expect(stub.requests[0]!.url).toBe(`${REPO}/info/refs?service=git-upload-pack`);
  });

  it('rejects responses that are not an upload-pack advertisement', async () => {
    const { provider } = setup(() => ({
      body: '<html>not git</html>',
      headers: { 'content-type': 'text/html' },
    }));
    await expectRepoError(provider.listBranches({ repo: REPO }), 'provider_error');
  });

  it('rejects malformed pkt-line payloads', async () => {
    const { provider } = setup(() => ({ body: 'zzzz', headers: ADVERTISEMENT_HEADERS }));
    await expectRepoError(provider.listBranches({ repo: REPO }), 'provider_error');
  });
});

describe('authentication', () => {
  const requireAuth: StubHandler = (request) =>
    request.headers.authorization === undefined
      ? { status: 401, body: 'auth required' }
      : advertisement(DEFAULT_RECORDS);

  it('upgrades to basic auth after a 401 and keeps sending it for that repository', async () => {
    const { provider, stub } = setup(requireAuth, { auth: { password: 'secret' } });
    await provider.listBranches({ repo: REPO });
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]!.headers.authorization).toBeUndefined();
    expect(stub.requests[1]!.headers.authorization).toBe(`Basic ${btoa('git:secret')}`);

    await provider.listTags({ repo: REPO });
    expect(stub.requests).toHaveLength(3);
    expect(stub.requests[2]!.headers.authorization).toBe(`Basic ${btoa('git:secret')}`);
  });

  it('uses the configured username', async () => {
    const { provider, stub } = setup(requireAuth, {
      auth: { username: 'robin', password: 'secret' },
    });
    await provider.listBranches({ repo: REPO });
    expect(stub.requests[1]!.headers.authorization).toBe(`Basic ${btoa('robin:secret')}`);
  });

  it('mints the password through a token provider', async () => {
    const calls: boolean[] = [];
    const { provider, stub } = setup(requireAuth, {
      auth: {
        tokenProvider: async ({ forceRefresh }) => {
          calls.push(forceRefresh);
          return 'minted';
        },
      },
    });
    await provider.listBranches({ repo: REPO });
    expect(stub.requests[1]!.headers.authorization).toBe(`Basic ${btoa('git:minted')}`);
    // The upgrade from an anonymous attempt is not a token refresh.
    expect(calls).toEqual([false]);
  });

  it('fails with unauthorized when the remote requires auth and none is configured', async () => {
    const { provider, stub } = setup(requireAuth);
    await expectRepoError(provider.listBranches({ repo: REPO }), 'unauthorized');
    expect(stub.requests).toHaveLength(1);
  });
});

describe('listBranches', () => {
  it('maps advertised branch refs and excludes HEAD and tags', async () => {
    const { provider } = setup();
    const page = await provider.listBranches({ repo: REPO });
    expect(page.data).toEqual([
      {
        name: 'feature/login',
        sha: SHA_FEATURE,
        raw: { name: 'refs/heads/feature/login', sha: SHA_FEATURE },
      },
      { name: 'main', sha: SHA_MAIN, raw: { name: 'refs/heads/main', sha: SHA_MAIN } },
    ]);
    expect(page.cursor).toBeUndefined();
  });

  it('decodes multi-byte ref names using byte-accurate pkt lengths', async () => {
    const { provider } = setup(() =>
      advertisement([`${SHA_MAIN} HEAD`, `${SHA_MAIN} refs/heads/feature/ümlaut`]),
    );
    const page = await provider.listBranches({ repo: REPO });
    expect(page.data.map((branch) => branch.name)).toEqual(['feature/ümlaut']);
  });

  it('returns an empty page for an empty repository', async () => {
    const { provider } = setup(() => advertisement([`${'0'.repeat(40)} capabilities^{}`]));
    const page = await provider.listBranches({ repo: REPO });
    expect(page.data).toEqual([]);
    expect(page.cursor).toBeUndefined();
  });
});

describe('listTags', () => {
  it('peels annotated tags to the commit SHA and flags annotation', async () => {
    const { provider } = setup();
    const page = await provider.listTags({ repo: REPO });
    expect(page.data).toEqual([
      {
        name: 'v0.9.0',
        sha: SHA_LIGHT_TAG,
        isAnnotated: false,
        raw: { name: 'refs/tags/v0.9.0', sha: SHA_LIGHT_TAG },
      },
      {
        name: 'v1.0.0',
        sha: SHA_TAG_COMMIT,
        isAnnotated: true,
        raw: { name: 'refs/tags/v1.0.0', sha: SHA_TAG_OBJECT, peeledSha: SHA_TAG_COMMIT },
      },
    ]);
  });
});

describe('pagination', () => {
  it('slices in memory and pages through with cursors', async () => {
    const { provider } = setup();
    const first = await provider.listBranches({ repo: REPO, limit: 1 });
    expect(first.data.map((branch) => branch.name)).toEqual(['feature/login']);
    expect(first.cursor).toBeDefined();

    const second = await provider.listBranches({ repo: REPO, limit: 1, cursor: first.cursor });
    expect(second.data.map((branch) => branch.name)).toEqual(['main']);
    expect(second.cursor).toBeUndefined();
  });

  it('iterates every branch through the client listAll generator', async () => {
    const { provider } = setup();
    const client = createClient({ provider });
    const names: string[] = [];
    for await (const branch of client.branches.listAll({ repo: REPO, limit: 1 })) {
      names.push(branch.name);
    }
    expect(names).toEqual(['feature/login', 'main']);
  });

  it('rejects cursors issued for a different repository', async () => {
    const { provider } = setup();
    const cursor = encodeCursor('git-http', { u: 'https://git.example.com/other.git', o: 1 });
    await expectRepoError(provider.listBranches({ repo: REPO, cursor }), 'validation');
  });
});

describe('getRepository', () => {
  it('derives the repository shape from the URL and advertisement', async () => {
    const { provider } = setup();
    const repository = await provider.getRepository({ repo: REPO });
    expect(repository).toMatchObject({
      id: REPO,
      name: 'app',
      path: 'team/app',
      namespace: 'team',
      defaultBranch: 'main',
      private: false,
      urls: { web: 'https://git.example.com/team/app', cloneHttp: REPO },
    });
  });

  it('reports private repositories after an auth upgrade', async () => {
    const { provider } = setup(
      (request) =>
        request.headers.authorization === undefined
          ? { status: 401, body: 'auth required' }
          : advertisement(DEFAULT_RECORDS),
      { auth: { password: 'secret' } },
    );
    const repository = await provider.getRepository({ repo: REPO });
    expect(repository.private).toBe(true);
  });

  it('falls back to the unambiguous HEAD branch when the symref capability is missing', async () => {
    const { provider } = setup(() =>
      advertisement(
        [`${SHA_MAIN} HEAD`, `${SHA_FEATURE} refs/heads/develop`, `${SHA_MAIN} refs/heads/trunk`],
        'multi_ack agent=git/1.8.0',
      ),
    );
    const repository = await provider.getRepository({ repo: REPO });
    expect(repository.defaultBranch).toBe('trunk');
  });
});

describe('searchRefs', () => {
  it('prefix-matches ref names, branches before tags, up to the limit', async () => {
    const { provider } = setup();
    const matches = await provider.searchRefs({
      repo: REPO,
      query: 'v1',
      types: ['branch', 'tag'],
      limit: 10,
    });
    expect(matches).toEqual([
      {
        type: 'tag',
        name: 'v1.0.0',
        sha: SHA_TAG_OBJECT,
        raw: { name: 'refs/tags/v1.0.0', sha: SHA_TAG_OBJECT },
      },
    ]);

    const all = await provider.searchRefs({
      repo: REPO,
      query: '',
      types: ['branch', 'tag'],
      limit: 3,
    });
    expect(all.map((match) => `${match.type}:${match.name}`)).toEqual([
      'branch:feature/login',
      'branch:main',
      'tag:v0.9.0',
    ]);
  });

  it('contributes no commit matches for SHA queries through the client', async () => {
    const { provider } = setup();
    const client = createClient({ provider });
    const matches = await client.refs.search({ repo: REPO, query: 'deadbeef' });
    expect(matches).toEqual([]);
  });
});

describe('getCloneUrl', () => {
  it('returns the plain URL without credentials', async () => {
    const { provider } = setup();
    await expect(provider.getCloneUrl({ repo: REPO })).resolves.toEqual({ url: REPO });
  });

  it('embeds the configured credentials', async () => {
    const { provider } = setup(undefined, { auth: { username: 'robin', password: 'p@ss word' } });
    const { url } = await provider.getCloneUrl({ repo: REPO });
    expect(url).toBe('https://robin:p%40ss%20word@git.example.com/team/app.git');
  });
});

describe('repository URL validation', () => {
  it.each([
    'git@git.example.com:team/app.git',
    'ssh://git@git.example.com/team/app.git',
    'git://git.example.com/team/app.git',
    'ftp://git.example.com/team/app.git',
    'not a url',
    'https://user:pass@git.example.com/team/app.git',
  ])('rejects %s', async (repo) => {
    const { provider } = setup();
    await expectRepoError(provider.listBranches({ repo }), 'validation');
  });
});

describe('unsupported operations', () => {
  it('throws unsupported for everything beyond ref discovery and clone URLs', async () => {
    const { provider } = setup();
    const params = { repo: REPO } as never;
    await expectRepoError(provider.getAuthenticatedUser(params), 'unsupported');
    await expectRepoError(provider.listNamespaces(params), 'unsupported');
    await expectRepoError(provider.listRepositories(params), 'unsupported');
    await expectRepoError(provider.listCommits(params), 'unsupported');
    await expectRepoError(provider.getCommit(params), 'unsupported');
    await expectRepoError(provider.downloadArchive(params), 'unsupported');
    await expectRepoError(provider.createWebhook(params), 'unsupported');
    await expectRepoError(provider.listWebhooks(params), 'unsupported');
    await expectRepoError(provider.getWebhook(params), 'unsupported');
    await expectRepoError(provider.updateWebhook(params), 'unsupported');
    await expectRepoError(provider.deleteWebhook(params), 'unsupported');
  });

  it('is gated by capabilities at the client level', async () => {
    const { provider } = setup();
    const client = createClient({ provider });
    await expectRepoError(client.users.me(), 'unsupported');
    await expectRepoError(client.repos.downloadArchive({ repo: REPO, ref: 'main' }), 'unsupported');
    await expectRepoError(
      client.webhooks.create({ repo: REPO, url: 'https://example.com/hook', events: ['push'] }),
      'unsupported',
    );
  });
});

describe('error mapping', () => {
  it('maps a 404 with a short plain-text body onto the error message', async () => {
    const { provider } = setup(() => ({ status: 404, body: 'Repository not found.' }));
    try {
      await provider.listBranches({ repo: REPO });
      expect.unreachable('expected RepoError');
    } catch (error) {
      expect(error).toBeInstanceOf(RepoError);
      expect((error as RepoError).code).toBe('not_found');
      expect((error as RepoError).message).toContain('Repository not found.');
    }
  });
});

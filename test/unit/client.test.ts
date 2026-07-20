import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.ts';
import { RepoError } from '../../src/errors.ts';
import type { Branch, Commit, Page, RefMatch, RepoProvider, Tag } from '../../src/types.ts';

function fakeCommit(sha: string): Commit {
  return {
    sha,
    message: `commit ${sha}`,
    author: { name: 'Test', date: new Date(0) },
    parents: [],
    raw: {},
  };
}

function notImplemented(): never {
  throw new Error('not implemented in fake provider');
}

function fakeProvider(overrides: Partial<RepoProvider> = {}): RepoProvider {
  return {
    name: 'github',
    capabilities: {
      userProfile: true,
      tagDates: false,
      repoSearch: true,
      ownedRepoFilter: true,
      commitUserRef: true,
      refSearch: true,
      webhookEvents: ['push', 'tag_push'],
      webhookVerification: 'hmac-sha256',
      archiveFormats: ['zip', 'tar.gz'],
    },
    getAuthenticatedUser: notImplemented,
    listNamespaces: notImplemented,
    listRepositories: notImplemented,
    getRepository: notImplemented,
    listCommits: notImplemented,
    getCommit: notImplemented,
    listTags: notImplemented,
    listBranches: notImplemented,
    getBranch: notImplemented,
    getTag: notImplemented,
    searchRefs: notImplemented,
    downloadArchive: notImplemented,
    getCloneUrl: notImplemented,
    createWebhook: notImplemented,
    listWebhooks: notImplemented,
    getWebhook: notImplemented,
    updateWebhook: notImplemented,
    deleteWebhook: notImplemented,
    ...overrides,
  };
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

describe('capability gating', () => {
  it('rejects users.me when the user profile cannot be resolved', async () => {
    const provider = fakeProvider();
    provider.capabilities.userProfile = false;
    const client = createClient({ provider });
    await expectRepoError(client.users.me(), 'unsupported');
  });

  it('rejects free-text search when unsupported', async () => {
    const provider = fakeProvider({ listRepositories: notImplemented });
    provider.capabilities.repoSearch = false;
    const client = createClient({ provider });
    await expectRepoError(client.repos.list({ query: 'sdk' }), 'unsupported');
  });

  it('rejects owned filter when unsupported', async () => {
    const provider = fakeProvider();
    provider.capabilities.ownedRepoFilter = false;
    const client = createClient({ provider });
    await expectRepoError(client.repos.list({ owned: true }), 'unsupported');
  });

  it('rejects unsupported archive formats', async () => {
    const provider = fakeProvider();
    provider.capabilities.archiveFormats = ['zip'];
    const client = createClient({ provider });
    await expectRepoError(
      client.repos.downloadArchive({ repo: 'a/b', ref: 'main', format: 'tar.gz' }),
      'unsupported',
    );
  });

  it('rejects unsupported webhook events and empty event lists', async () => {
    const client = createClient({ provider: fakeProvider() });
    await expectRepoError(
      client.webhooks.create({ repo: 'a/b', url: 'https://x.test', events: ['release'] }),
      'unsupported',
    );
    await expectRepoError(
      client.webhooks.create({ repo: 'a/b', url: 'https://x.test', events: [] }),
      'validation',
    );
  });
});

describe('validation', () => {
  it('rejects empty repo', async () => {
    const client = createClient({ provider: fakeProvider() });
    await expectRepoError(client.repos.get({ repo: '  ' }), 'validation');
    await expectRepoError(client.commits.get({ repo: '', ref: 'main' }), 'validation');
  });

  it('rejects empty webhook id', async () => {
    const client = createClient({ provider: fakeProvider() });
    await expectRepoError(client.webhooks.delete({ repo: 'a/b', id: '' }), 'validation');
  });
});

describe('listAll', () => {
  it('follows cursors across pages', async () => {
    const pages: Record<string, Page<Commit>> = {
      start: { data: [fakeCommit('a'), fakeCommit('b')], cursor: 'next' },
      next: { data: [fakeCommit('c')] },
    };
    const provider = fakeProvider({
      listCommits: (params) => Promise.resolve(pages[params.cursor ?? 'start'] as Page<Commit>),
    });
    const client = createClient({ provider });
    const shas: string[] = [];
    for await (const commit of client.commits.listAll({ repo: 'a/b' })) {
      shas.push(commit.sha);
    }
    expect(shas).toEqual(['a', 'b', 'c']);
  });
});

describe('refs.search', () => {
  function branch(name: string): Branch {
    return { name, sha: `sha-${name}`, raw: {} };
  }
  function tag(name: string): Tag {
    return { name, sha: `sha-${name}`, raw: {} };
  }
  function match(type: RefMatch['type'], name: string): RefMatch {
    return { type, name, sha: `sha-${name}`, raw: {} };
  }

  it('rejects when the provider lacks the refSearch capability', async () => {
    const provider = fakeProvider();
    provider.capabilities.refSearch = false;
    const client = createClient({ provider });
    await expectRepoError(client.refs.search({ repo: 'a/b', query: 'feat' }), 'unsupported');
  });

  it('rejects an empty types array', async () => {
    const client = createClient({ provider: fakeProvider() });
    await expectRepoError(
      client.refs.search({ repo: 'a/b', query: 'feat', types: [] }),
      'validation',
    );
  });

  it('passes defaulted types and limit to the provider', async () => {
    let seen: unknown;
    const provider = fakeProvider({
      searchRefs: (params) => {
        seen = params;
        return Promise.resolve([match('branch', 'feature-x')]);
      },
    });
    const client = createClient({ provider });
    const matches = await client.refs.search({ repo: 'a/b', query: 'feat' });
    expect(seen).toMatchObject({ repo: 'a/b', query: 'feat', types: ['branch', 'tag'], limit: 20 });
    expect(matches).toEqual([match('branch', 'feature-x')]);
  });

  it('serves an empty query from the list endpoints instead of searchRefs', async () => {
    const provider = fakeProvider({
      listBranches: () => Promise.resolve({ data: [branch('main'), branch('develop')] }),
      listTags: () => Promise.resolve({ data: [tag('v1.0.0')] }),
    });
    const client = createClient({ provider });
    const matches = await client.refs.search({ repo: 'a/b', query: '' });
    expect(matches).toEqual([
      match('branch', 'main'),
      match('branch', 'develop'),
      match('tag', 'v1.0.0'),
    ]);
  });

  it('applies limit and type filtering to an empty query', async () => {
    const provider = fakeProvider({
      listTags: () => Promise.resolve({ data: [tag('v1'), tag('v2'), tag('v3')] }),
    });
    const client = createClient({ provider });
    const matches = await client.refs.search({ repo: 'a/b', query: '', types: ['tag'], limit: 2 });
    expect(matches).toEqual([match('tag', 'v1'), match('tag', 'v2')]);
  });

  it('appends a commit match for a resolvable hex query', async () => {
    const provider = fakeProvider({
      searchRefs: () => Promise.resolve([match('branch', 'abc-branch')]),
      getCommit: (params) => Promise.resolve({ ...fakeCommit(params.ref), raw: { full: true } }),
    });
    const client = createClient({ provider });
    const matches = await client.refs.search({ repo: 'a/b', query: 'abc1234' });
    expect(matches).toEqual([
      match('branch', 'abc-branch'),
      { type: 'commit', name: 'abc1234', sha: 'abc1234', raw: { full: true } },
    ]);
  });

  it('ignores commit resolution misses but propagates other errors', async () => {
    const notFound = new RepoError('nope', { code: 'not_found', provider: 'github' });
    const provider = fakeProvider({
      searchRefs: () => Promise.resolve([]),
      getCommit: () => Promise.reject(notFound),
    });
    const client = createClient({ provider });
    expect(await client.refs.search({ repo: 'a/b', query: 'abc1234' })).toEqual([]);

    provider.getCommit = () =>
      Promise.reject(new RepoError('boom', { code: 'forbidden', provider: 'github' }));
    await expectRepoError(client.refs.search({ repo: 'a/b', query: 'abc1234' }), 'forbidden');
  });

  it('does not resolve commits for non-hex queries or when commit is not requested', async () => {
    const provider = fakeProvider({
      searchRefs: () => Promise.resolve([]),
    });
    const client = createClient({ provider });
    expect(await client.refs.search({ repo: 'a/b', query: 'feature' })).toEqual([]);
    expect(await client.refs.search({ repo: 'a/b', query: 'abc1234', types: ['branch'] })).toEqual(
      [],
    );
  });

  it('searches only commits when requested', async () => {
    const provider = fakeProvider({
      getCommit: (params) => Promise.resolve(fakeCommit(params.ref)),
    });
    const client = createClient({ provider });
    const matches = await client.refs.search({ repo: 'a/b', query: 'abc1234', types: ['commit'] });
    expect(matches).toMatchObject([{ type: 'commit', name: 'abc1234' }]);
  });

  it('truncates merged results to the limit', async () => {
    const provider = fakeProvider({
      searchRefs: () => Promise.resolve([match('branch', 'abc1'), match('tag', 'abc2')]),
      getCommit: (params) => Promise.resolve(fakeCommit(params.ref)),
    });
    const client = createClient({ provider });
    const matches = await client.refs.search({ repo: 'a/b', query: 'abc1234', limit: 2 });
    expect(matches).toEqual([match('branch', 'abc1'), match('tag', 'abc2')]);
  });
});

describe('branches.get / tags.get', () => {
  it('validates repo and name', async () => {
    const client = createClient({ provider: fakeProvider() });
    await expectRepoError(client.branches.get({ repo: '', name: 'main' }), 'validation');
    await expectRepoError(client.branches.get({ repo: 'a/b', name: ' ' }), 'validation');
    await expectRepoError(client.tags.get({ repo: 'a/b', name: '' }), 'validation');
  });

  it('passes through to the provider', async () => {
    const provider = fakeProvider({
      getBranch: (params) => Promise.resolve({ name: params.name, sha: 'b1', raw: {} }),
      getTag: (params) =>
        Promise.resolve({ name: params.name, sha: 't1', isAnnotated: true, raw: {} }),
    });
    const client = createClient({ provider });
    expect(await client.branches.get({ repo: 'a/b', name: 'main' })).toEqual({
      name: 'main',
      sha: 'b1',
      raw: {},
    });
    expect(await client.tags.get({ repo: 'a/b', name: 'v1' })).toEqual({
      name: 'v1',
      sha: 't1',
      isAnnotated: true,
      raw: {},
    });
  });
});

describe('refs.resolve', () => {
  function miss(): Promise<never> {
    return Promise.reject(new RepoError('missing', { code: 'not_found', provider: 'github' }));
  }
  function branchOf(name: string, sha: string): Branch {
    return { name, sha, raw: { kind: 'branch' } };
  }
  function tagOf(name: string, sha: string): Tag {
    return { name, sha, isAnnotated: true, raw: { kind: 'tag' } };
  }

  it('validates repo and ref', async () => {
    const client = createClient({ provider: fakeProvider() });
    await expectRepoError(client.refs.resolve({ repo: '', ref: 'main' }), 'validation');
    await expectRepoError(client.refs.resolve({ repo: 'a/b', ref: ' ' }), 'validation');
  });

  it('resolves a branch when no tag matches', async () => {
    const provider = fakeProvider({
      getBranch: (params) => Promise.resolve(branchOf(params.name, 'b-sha')),
      getTag: miss,
    });
    const client = createClient({ provider });
    expect(await client.refs.resolve({ repo: 'a/b', ref: 'main' })).toEqual({
      type: 'branch',
      name: 'main',
      sha: 'b-sha',
      raw: { kind: 'branch' },
    });
  });

  it('resolves a tag when no branch matches', async () => {
    const provider = fakeProvider({
      getBranch: miss,
      getTag: (params) => Promise.resolve(tagOf(params.name, 'peeled-sha')),
    });
    const client = createClient({ provider });
    expect(await client.refs.resolve({ repo: 'a/b', ref: 'v1.0.0' })).toEqual({
      type: 'tag',
      name: 'v1.0.0',
      sha: 'peeled-sha',
      raw: { kind: 'tag' },
    });
  });

  it('prefers the tag when a branch and tag share the name', async () => {
    const provider = fakeProvider({
      getBranch: (params) => Promise.resolve(branchOf(params.name, 'b-sha')),
      getTag: (params) => Promise.resolve(tagOf(params.name, 't-sha')),
    });
    const client = createClient({ provider });
    expect(await client.refs.resolve({ repo: 'a/b', ref: 'release' })).toMatchObject({
      type: 'tag',
      sha: 't-sha',
    });
  });

  it('honors a branch type hint without touching tags', async () => {
    const provider = fakeProvider({
      getBranch: (params) => Promise.resolve(branchOf(params.name, 'b-sha')),
    });
    const client = createClient({ provider });
    expect(
      await client.refs.resolve({ repo: 'a/b', ref: 'release', type: 'branch' }),
    ).toMatchObject({ type: 'branch', sha: 'b-sha' });
  });

  it('honors a tag type hint without touching branches', async () => {
    const provider = fakeProvider({
      getTag: (params) => Promise.resolve(tagOf(params.name, 't-sha')),
    });
    const client = createClient({ provider });
    expect(await client.refs.resolve({ repo: 'a/b', ref: 'release', type: 'tag' })).toMatchObject({
      type: 'tag',
      sha: 't-sha',
    });
  });

  it('resolves directly via getCommit for a commit type hint', async () => {
    const provider = fakeProvider({
      getCommit: (params) => Promise.resolve(fakeCommit(params.ref)),
    });
    const client = createClient({ provider });
    expect(await client.refs.resolve({ repo: 'a/b', ref: 'main', type: 'commit' })).toMatchObject({
      type: 'commit',
      name: 'main',
      sha: 'main',
    });
  });

  it('falls back to a commit lookup for hex refs', async () => {
    const provider = fakeProvider({
      getBranch: miss,
      getTag: miss,
      getCommit: (params) => Promise.resolve({ ...fakeCommit(params.ref), raw: { full: true } }),
    });
    const client = createClient({ provider });
    expect(await client.refs.resolve({ repo: 'a/b', ref: 'abc1234' })).toEqual({
      type: 'commit',
      name: 'abc1234',
      sha: 'abc1234',
      raw: { full: true },
    });

    provider.getCommit = miss;
    await expectRepoError(client.refs.resolve({ repo: 'a/b', ref: 'abc1234' }), 'not_found');
  });

  it('does not attempt a commit lookup for non-hex refs or with a name hint', async () => {
    const provider = fakeProvider({ getBranch: miss, getTag: miss });
    const client = createClient({ provider });
    await expectRepoError(client.refs.resolve({ repo: 'a/b', ref: 'feature' }), 'not_found');
    await expectRepoError(
      client.refs.resolve({ repo: 'a/b', ref: 'abc1234', type: 'branch' }),
      'not_found',
    );
  });

  it('resolves HEAD via the default branch', async () => {
    const provider = fakeProvider({
      getRepository: () =>
        Promise.resolve({
          id: '1',
          name: 'b',
          path: 'a/b',
          namespace: 'a',
          defaultBranch: 'main',
          private: false,
          urls: { web: 'https://x.test/a/b' },
          raw: {},
        }),
      getBranch: (params) => Promise.resolve(branchOf(params.name, 'head-sha')),
    });
    const client = createClient({ provider });
    expect(await client.refs.resolve({ repo: 'a/b', ref: 'HEAD' })).toMatchObject({
      type: 'branch',
      name: 'main',
      sha: 'head-sha',
    });
  });

  it('rejects HEAD when the repository has no default branch', async () => {
    const provider = fakeProvider({
      getRepository: () =>
        Promise.resolve({
          id: '1',
          name: 'b',
          path: 'a/b',
          namespace: 'a',
          private: false,
          urls: { web: 'https://x.test/a/b' },
          raw: {},
        }),
    });
    const client = createClient({ provider });
    await expectRepoError(client.refs.resolve({ repo: 'a/b', ref: 'HEAD' }), 'not_found');
  });

  it('returns the tag even when the branch lookup fails hard', async () => {
    const provider = fakeProvider({
      getBranch: () =>
        Promise.reject(new RepoError('nope', { code: 'forbidden', provider: 'github' })),
      getTag: (params) => Promise.resolve(tagOf(params.name, 't-sha')),
    });
    const client = createClient({ provider });
    expect(await client.refs.resolve({ repo: 'a/b', ref: 'v1' })).toMatchObject({ type: 'tag' });
  });

  it('propagates a hard tag failure even when the branch resolves', async () => {
    const provider = fakeProvider({
      getBranch: (params) => Promise.resolve(branchOf(params.name, 'b-sha')),
      getTag: () =>
        Promise.reject(new RepoError('nope', { code: 'forbidden', provider: 'github' })),
    });
    const client = createClient({ provider });
    await expectRepoError(client.refs.resolve({ repo: 'a/b', ref: 'v1' }), 'forbidden');
  });

  it('propagates unsupported from the commit fallback', async () => {
    const provider = fakeProvider({
      getBranch: miss,
      getTag: miss,
      getCommit: () =>
        Promise.reject(new RepoError('nope', { code: 'unsupported', provider: 'git-http' })),
    });
    const client = createClient({ provider });
    await expectRepoError(client.refs.resolve({ repo: 'a/b', ref: 'abc1234' }), 'unsupported');
  });
});

describe('rate-limit retry', () => {
  function rateLimitedOnce(retryAfter: number | undefined): {
    provider: RepoProvider;
    calls: () => number;
  } {
    let callCount = 0;
    const provider = fakeProvider({
      getCommit: () => {
        callCount += 1;
        if (callCount === 1) {
          throw new RepoError('rate limited', {
            code: 'rate_limited',
            provider: 'github',
            retryAfter,
          });
        }
        return Promise.resolve(fakeCommit('a'));
      },
    });
    return { provider, calls: () => callCount };
  }

  it('retries once when retryAfter is small', async () => {
    const { provider, calls } = rateLimitedOnce(0);
    const client = createClient({ provider });
    const commit = await client.commits.get({ repo: 'a/b', ref: 'main' });
    expect(commit.sha).toBe('a');
    expect(calls()).toBe(2);
  });

  it('does not retry when retryAfter exceeds the maximum', async () => {
    const { provider, calls } = rateLimitedOnce(3600);
    const client = createClient({ provider });
    await expectRepoError(client.commits.get({ repo: 'a/b', ref: 'main' }), 'rate_limited');
    expect(calls()).toBe(1);
  });

  it('does not retry when disabled', async () => {
    const { provider, calls } = rateLimitedOnce(0);
    const client = createClient({ provider, retry: { rateLimit: false } });
    await expectRepoError(client.commits.get({ repo: 'a/b', ref: 'main' }), 'rate_limited');
    expect(calls()).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/client.ts';
import { RepoError } from '../../src/errors.ts';
import type { Commit, Page, RepoProvider } from '../../src/types.ts';

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
      tagDates: false,
      repoSearch: true,
      ownedRepoFilter: true,
      commitUserRef: true,
      webhookEvents: ['push', 'tag_push'],
      webhookVerification: 'hmac-sha256',
      archiveFormats: ['zip', 'tar.gz'],
    },
    listNamespaces: notImplemented,
    listRepositories: notImplemented,
    getRepository: notImplemented,
    listCommits: notImplemented,
    getCommit: notImplemented,
    listTags: notImplemented,
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

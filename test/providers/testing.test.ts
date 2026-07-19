import { describe, expect, it } from 'vitest';
import { createClient } from '../../src/index.ts';
import { createInMemoryProvider, type InMemorySeed } from '../../src/testing.ts';
import { RepoError } from '../../src/errors.ts';

const seed: InMemorySeed = {
  namespaces: [
    { id: '1', slug: 'acme', name: 'Acme', kind: 'organization' },
    { id: '2', slug: 'beta', name: 'Beta', kind: 'organization' },
    { id: '3', slug: 'gamma', name: 'Gamma', kind: 'user' },
  ],
  repositories: {
    'acme/service': { owned: true, defaultBranch: 'main', private: true },
    'acme/web': {},
    'beta/api': { owned: false },
  },
  commits: {
    'acme/service': [
      {
        sha: 'c3',
        message: 'third',
        author: { date: new Date('2026-03-01T00:00:00Z') },
        refs: ['main'],
      },
      { sha: 'c2', message: 'second', author: { date: new Date('2026-02-01T00:00:00Z') } },
      {
        sha: 'c1',
        message: 'first',
        author: { date: new Date('2026-01-01T00:00:00Z') },
        refs: ['main'],
      },
    ],
  },
  tags: {
    'acme/service': [{ name: 'v1.0.0', sha: 'c1' }],
  },
  branches: {
    'acme/service': [
      { name: 'main', sha: 'c3' },
      { name: 'feature/login', sha: 'c2' },
      { name: 'feature/logout', sha: 'c2' },
      { name: 'v1-hotfix', sha: 'c1' },
    ],
  },
  webhooks: {
    'acme/service': [{ url: 'https://example.com/seeded', events: ['push'] }],
  },
};

function setup(customSeed: InMemorySeed = seed) {
  const provider = createInMemoryProvider(customSeed);
  const client = createClient({ provider });
  return { provider, client };
}

async function expectRepoError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    expect.unreachable('expected RepoError');
  } catch (error) {
    expect(error).toBeInstanceOf(RepoError);
    expect((error as RepoError).code).toBe(code);
    expect((error as RepoError).provider).toBe('github');
  }
}

async function collect<T>(generator: AsyncGenerator<T, void>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of generator) items.push(item);
  return items;
}

describe('createInMemoryProvider through createClient', () => {
  it('reports the provider identity and full capabilities', () => {
    const { client } = setup();
    expect(client.providerName).toBe('github');
    expect(client.capabilities).toMatchObject({
      tagDates: true,
      repoSearch: true,
      ownedRepoFilter: true,
      webhookEvents: ['push', 'tag_push', 'release'],
      webhookVerification: 'hmac-sha256',
      archiveFormats: ['zip', 'tar.gz'],
    });
  });

  describe('pagination', () => {
    it('crosses the fixed size-2 page boundary for namespaces', async () => {
      const { client } = setup();
      const first = await client.namespaces.list();
      expect(first.data).toHaveLength(2);
      expect(first.cursor).toBeDefined();

      const namespaces = await collect(client.namespaces.listAll());
      expect(namespaces.map((namespace) => namespace.slug)).toEqual(['acme', 'beta', 'gamma']);
    });

    it('crosses the size-2 boundary for repositories', async () => {
      const { client } = setup();
      const repos = await collect(client.repos.listAll());
      expect(repos).toHaveLength(3);
    });
  });

  describe('repos.list filters', () => {
    it('filters by namespace', async () => {
      const { client } = setup();
      const page = await client.repos.list({ namespace: 'acme' });
      expect(page.data.map((repo) => repo.path)).toEqual(['acme/service', 'acme/web']);
    });

    it('filters by owned', async () => {
      const { client } = setup();
      const owned = await collect(client.repos.listAll({ owned: true }));
      expect(owned.map((repo) => repo.path)).toEqual(['acme/service']);
    });

    it('filters by query substring on name', async () => {
      const { client } = setup();
      const page = await client.repos.list({ query: 'serv' });
      expect(page.data.map((repo) => repo.path)).toEqual(['acme/service']);
    });
  });

  describe('repos.get', () => {
    it('returns a normalized repository', async () => {
      const { client } = setup();
      const repo = await client.repos.get({ repo: 'acme/service' });
      expect(repo).toMatchObject({
        path: 'acme/service',
        namespace: 'acme',
        defaultBranch: 'main',
      });
    });

    it('rejects an unknown repo with not_found', async () => {
      const { client } = setup();
      await expectRepoError(client.repos.get({ repo: 'acme/missing' }), 'not_found');
    });
  });

  describe('commits.get', () => {
    it('resolves a sha', async () => {
      const { client } = setup();
      expect((await client.commits.get({ repo: 'acme/service', ref: 'c2' })).sha).toBe('c2');
    });

    it('resolves a tag name to its commit', async () => {
      const { client } = setup();
      expect((await client.commits.get({ repo: 'acme/service', ref: 'v1.0.0' })).sha).toBe('c1');
    });

    it('resolves the default branch to the newest commit', async () => {
      const { client } = setup();
      expect((await client.commits.get({ repo: 'acme/service', ref: 'main' })).sha).toBe('c3');
    });

    it('rejects an unknown ref with not_found', async () => {
      const { client } = setup();
      await expectRepoError(client.commits.get({ repo: 'acme/service', ref: 'nope' }), 'not_found');
    });
  });

  describe('commits.list', () => {
    it('filters by ref, keeping ref-less commits', async () => {
      const { client } = setup();
      const commits = await collect(client.commits.listAll({ repo: 'acme/service', ref: 'main' }));
      expect(commits.map((commit) => commit.sha)).toEqual(['c3', 'c2', 'c1']);
    });

    it('filters by since/until on the author date', async () => {
      const { client } = setup();
      const commits = await collect(
        client.commits.listAll({
          repo: 'acme/service',
          since: new Date('2026-02-01T00:00:00Z'),
          until: new Date('2026-02-28T00:00:00Z'),
        }),
      );
      expect(commits.map((commit) => commit.sha)).toEqual(['c2']);
    });
  });

  describe('tags.list', () => {
    it('lists seeded tags', async () => {
      const { client } = setup();
      const page = await client.tags.list({ repo: 'acme/service' });
      expect(page.data).toMatchObject([{ name: 'v1.0.0', sha: 'c1' }]);
    });
  });

  describe('branches.list', () => {
    it('lists seeded branches with raw seed passthrough', async () => {
      const { client } = setup();
      const page = await client.branches.list({ repo: 'acme/service' });
      expect(page.data).toHaveLength(2);
      expect(page.data[0]).toMatchObject({ name: 'main', sha: 'c3' });
      expect(page.cursor).toBeDefined();
    });

    it('crosses the size-2 page boundary via listAll', async () => {
      const { client } = setup();
      const branches = await collect(client.branches.listAll({ repo: 'acme/service' }));
      expect(branches.map((branch) => branch.name)).toEqual([
        'main',
        'feature/login',
        'feature/logout',
        'v1-hotfix',
      ]);
    });

    it('rejects an unknown repo with not_found', async () => {
      const { client } = setup();
      await expectRepoError(client.branches.list({ repo: 'acme/missing' }), 'not_found');
    });
  });

  describe('refs.search', () => {
    it('prefix-filters branch names case-sensitively', async () => {
      const { client } = setup();
      const matches = await client.refs.search({ repo: 'acme/service', query: 'feature/' });
      expect(matches).toEqual([
        { type: 'branch', name: 'feature/login', sha: 'c2', raw: expect.anything() },
        { type: 'branch', name: 'feature/logout', sha: 'c2', raw: expect.anything() },
      ]);
    });

    it('orders branch matches before tag matches', async () => {
      const { client } = setup();
      const matches = await client.refs.search({ repo: 'acme/service', query: 'v1' });
      expect(matches.map((match) => [match.type, match.name])).toEqual([
        ['branch', 'v1-hotfix'],
        ['tag', 'v1.0.0'],
      ]);
    });

    it('truncates to the given limit', async () => {
      const { client } = setup();
      const matches = await client.refs.search({
        repo: 'acme/service',
        query: 'feature/',
        limit: 1,
      });
      expect(matches).toHaveLength(1);
      expect(matches[0]?.name).toBe('feature/login');
    });

    it('restricts results to the requested ref types', async () => {
      const { client } = setup();
      const tagsOnly = await client.refs.search({
        repo: 'acme/service',
        query: 'v1',
        types: ['tag'],
      });
      expect(tagsOnly.map((match) => [match.type, match.name])).toEqual([['tag', 'v1.0.0']]);
    });

    it('rejects an unknown repo with not_found', async () => {
      const { client } = setup();
      await expectRepoError(
        client.refs.search({ repo: 'acme/missing', query: 'feature/' }),
        'not_found',
      );
    });
  });

  describe('downloadArchive', () => {
    it('returns a readable stream with archive metadata', async () => {
      const { client } = setup();
      const archive = await client.repos.downloadArchive({ repo: 'acme/service', ref: 'main' });
      expect(archive.contentType).toBe('application/zip');
      expect(archive.filename).toBe('service-main.zip');
      expect(await new Response(archive.stream).text()).toBe(
        'repo-sdk in-memory archive: acme/service@main',
      );
    });

    it('uses application/gzip for tar.gz', async () => {
      const { client } = setup();
      const archive = await client.repos.downloadArchive({
        repo: 'acme/service',
        ref: 'main',
        format: 'tar.gz',
      });
      expect(archive.contentType).toBe('application/gzip');
      expect(archive.filename).toBe('service-main.tar.gz');
    });
  });

  describe('getCloneUrl', () => {
    it('returns an in-memory clone url', async () => {
      const { client } = setup();
      const clone = await client.repos.getCloneUrl({ repo: 'acme/service' });
      expect(clone.url).toBe('https://x-token:test@in-memory.invalid/acme/service.git');
    });
  });

  describe('webhooks round-trip', () => {
    it('creates, lists, gets, updates and deletes while mutating state', async () => {
      const { provider, client } = setup();

      const created = await client.webhooks.create({
        repo: 'acme/service',
        url: 'https://example.com/hook',
        events: ['push', 'release'],
      });
      expect(created.id).toBe('hook-2');
      expect(provider.state.webhooks.get('acme/service')).toHaveLength(2);

      const listed = await client.webhooks.list({ repo: 'acme/service' });
      expect(listed.data).toHaveLength(2);

      const fetched = await client.webhooks.get({ repo: 'acme/service', id: 'hook-2' });
      expect(fetched.url).toBe('https://example.com/hook');

      const updated = await client.webhooks.update({
        repo: 'acme/service',
        id: 'hook-2',
        active: false,
        events: ['push'],
      });
      expect(updated.active).toBe(false);
      expect(provider.state.webhooks.get('acme/service')?.[1]?.active).toBe(false);

      await client.webhooks.delete({ repo: 'acme/service', id: 'hook-2' });
      expect(provider.state.webhooks.get('acme/service')).toHaveLength(1);

      await expectRepoError(
        client.webhooks.get({ repo: 'acme/service', id: 'hook-2' }),
        'not_found',
      );
    });

    it('rejects webhook operations on an unknown repo with not_found', async () => {
      const { client } = setup();
      await expectRepoError(client.webhooks.list({ repo: 'acme/missing' }), 'not_found');
    });
  });

  describe('capability gating via the client', () => {
    it('rejects an empty webhook event list with validation', async () => {
      const { client } = setup();
      await expectRepoError(
        client.webhooks.create({ repo: 'acme/service', url: 'https://example.com/x', events: [] }),
        'validation',
      );
    });
  });

  describe('users.me', () => {
    it('returns a default user when none is seeded', async () => {
      const { client } = setup();
      const user = await client.users.me();
      expect(user).toMatchObject({ id: 'user-1', username: 'in-memory-user' });
    });

    it('returns the seeded user', async () => {
      const { client } = setup({
        ...seed,
        user: { id: 'u-9', username: 'robin', name: 'Robin', email: 'robin@example.com' },
      });
      const user = await client.users.me();
      expect(user).toMatchObject({
        id: 'u-9',
        username: 'robin',
        name: 'Robin',
        email: 'robin@example.com',
      });
    });

    it('accepts includeEmail as a no-op', async () => {
      const { client } = setup({ ...seed, user: { email: 'robin@example.com' } });
      const user = await client.users.me({ includeEmail: true });
      expect(user.email).toBe('robin@example.com');
    });

    it('is gated by a userProfile capability override', async () => {
      const provider = createInMemoryProvider(seed, { capabilities: { userProfile: false } });
      const client = createClient({ provider });
      await expectRepoError(client.users.me(), 'unsupported');
    });
  });

  describe('provider options', () => {
    it('reports a configured provider name, including in errors and cursors', async () => {
      const provider = createInMemoryProvider(seed, { name: 'azure-devops' });
      const client = createClient({ provider });
      expect(client.providerName).toBe('azure-devops');

      const namespaces = await collect(client.namespaces.listAll());
      expect(namespaces).toHaveLength(3);

      try {
        await client.repos.get({ repo: 'acme/missing' });
        expect.unreachable('expected RepoError');
      } catch (error) {
        expect((error as RepoError).provider).toBe('azure-devops');
      }
    });

    it('merges capability overrides over the full-featured defaults', async () => {
      const provider = createInMemoryProvider(seed, {
        name: 'azure-devops',
        capabilities: { repoSearch: false, refSearch: false },
      });
      const client = createClient({ provider });
      expect(client.capabilities.repoSearch).toBe(false);
      expect(client.capabilities.ownedRepoFilter).toBe(true);

      try {
        await client.repos.list({ query: 'serv' });
        expect.unreachable('expected RepoError');
      } catch (error) {
        expect(error).toBeInstanceOf(RepoError);
        expect((error as RepoError).code).toBe('unsupported');
        expect((error as RepoError).message).toContain('azure-devops');
      }
    });
  });
});

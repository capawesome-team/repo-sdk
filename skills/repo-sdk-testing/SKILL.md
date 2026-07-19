---
name: repo-sdk-testing
description: Test code that uses `repo-sdk` with the in-memory provider from `repo-sdk/testing`. Use when writing unit/integration tests for repo-sdk integrations — seeding namespaces/repos/commits/tags/webhooks via `createInMemoryProvider(seed)`, driving it through `createClient`, and asserting against the exposed `state` — instead of mocking `fetch`.
---

# Testing repo-sdk integrations

`repo-sdk/testing` ships an in-memory `RepoProvider`. It implements the same contract as the real providers and uses a small page size (2) so cursor pagination is exercised too. Prefer it over mocking `fetch`: you seed normalized domain objects and assert against real client behavior, instead of hand-rolling HTTP fixtures.

## Seed & drive through the client

`createInMemoryProvider(seed?)` returns a `RepoProvider & { state }`. Pass it to `createClient` like any provider.

```ts
import { createClient } from 'repo-sdk';
import { createInMemoryProvider } from 'repo-sdk/testing';

const provider = createInMemoryProvider({
  namespaces: [{ id: '1', slug: 'acme', name: 'Acme', kind: 'organization' }],
  // repositories are keyed by their path
  repositories: {
    'acme/app': { private: false, defaultBranch: 'main', owned: true },
  },
  // commits keyed by repo path, newest first
  commits: {
    'acme/app': [
      { sha: 'c2', message: 'second', refs: ['main'] },
      { sha: 'c1', message: 'first', refs: ['main'] },
    ],
  },
  // tags keyed by repo path
  tags: {
    'acme/app': [{ name: 'v1.0.0', sha: 'c1', isAnnotated: true }],
  },
  // webhooks keyed by repo path
  webhooks: {
    'acme/app': [{ url: 'https://example.com/hook', events: ['push'] }],
  },
});

const client = createClient({ provider });
const { data: repos } = await client.repos.list({ namespace: 'acme' });
const head = await client.commits.get({ repo: 'acme/app', ref: 'main' });
```

The seed is optional (`createInMemoryProvider()` starts empty). Seed shapes are forgiving: repository fields default (`private: false`, `defaultBranch: 'main'`, `id`/`name` derived from the path key), and `owned: true` makes a repo honor the `owned` filter.

## Assert against `state`

The provider exposes its live `state` so you can assert side effects (e.g. a hook your code created) without another API round-trip.

```ts
// state.namespaces: Namespace[]
// state.repositories, state.commits, state.tags, state.webhooks: Map<path, ...>

await client.webhooks.create({ repo: 'acme/app', url: 'https://x.test/h', events: ['push'] });

const hooks = provider.state.webhooks.get('acme/app')!;
expect(hooks.at(-1)!.url).toBe('https://x.test/h');
```

## Notes

- The double reports `providerName: 'github'` and exposes full capabilities (tag dates, repo search, owned filter, `push`/`tag_push`/`release` webhooks, zip + tar.gz), so capability-gated code paths run.
- Unknown repos/refs/webhook ids throw `RepoError` with `code: 'not_found'`, matching real behavior.
- Because the page size is 2, tests that iterate `listAll` (or follow `cursor`) genuinely exercise pagination.

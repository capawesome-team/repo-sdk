/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { gitHttp } from '../../src/git-http.ts';
import { createClient } from '../../src/index.ts';

const url = process.env.REPO_SDK_LIVE_GIT_HTTP_URL;
const username = process.env.REPO_SDK_LIVE_GIT_HTTP_USERNAME;
const password = process.env.REPO_SDK_LIVE_GIT_HTTP_PASSWORD;

describe.skipIf(!url)('git-http live (read-only)', () => {
  const client = createClient({
    provider: gitHttp({ auth: password ? { username, password } : undefined }),
  });

  it('gets the configured repository', async () => {
    const repository = await client.repos.get({ repo: url! });
    expect(repository.path).toBeTruthy();
    expect(repository.defaultBranch).toBeTruthy();
  });

  it('lists branches including the default branch', async () => {
    const repository = await client.repos.get({ repo: url! });
    const page = await client.branches.list({ repo: url! });
    expect(page.data.length).toBeGreaterThan(0);
    expect(page.data.map((branch) => branch.name)).toContain(repository.defaultBranch);
  });

  it('lists tags without error', async () => {
    const page = await client.tags.list({ repo: url! });
    expect(Array.isArray(page.data)).toBe(true);
  });

  it('searches refs by prefix', async () => {
    const repository = await client.repos.get({ repo: url! });
    const matches = await client.refs.search({
      repo: url!,
      query: repository.defaultBranch!.slice(0, 1),
    });
    expect(matches.length).toBeGreaterThan(0);
  });
});

/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { github } from '../../src/github.ts';
import { createClient } from '../../src/index.ts';

const token = process.env.REPO_SDK_LIVE_GITHUB_TOKEN;
const repo = process.env.REPO_SDK_LIVE_GITHUB_REPO;

describe.skipIf(!token || !repo)('GitHub live (read-only)', () => {
  const client = createClient({ provider: github({ auth: { token: token! } }) });

  it('lists namespaces', async () => {
    const page = await client.namespaces.list();
    expect(page.data.length).toBeGreaterThanOrEqual(1);
  });

  it('gets the configured repository', async () => {
    const repository = await client.repos.get({ repo: repo! });
    expect(repository.path).toBeTruthy();
    expect(repository.defaultBranch).toBeTruthy();
  });

  it('lists commits and resolves the default branch', async () => {
    const repository = await client.repos.get({ repo: repo! });
    const page = await client.commits.list({ repo: repo! });
    expect(page.data.length).toBeGreaterThan(0);
    const commit = await client.commits.get({
      repo: repo!,
      ref: repository.defaultBranch!,
    });
    expect(commit.sha).toBeTruthy();
  });

  it('lists tags without error', async () => {
    const page = await client.tags.list({ repo: repo! });
    expect(Array.isArray(page.data)).toBe(true);
  });

  it('streams the first archive chunk', async () => {
    const repository = await client.repos.get({ repo: repo! });
    const archive = await client.repos.downloadArchive({
      repo: repo!,
      ref: repository.defaultBranch!,
    });
    const reader = archive.stream.getReader();
    const { value } = await reader.read();
    expect(value && value.byteLength).toBeGreaterThan(0);
    await reader.cancel();
  });
});

/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { bitbucket } from '../../src/bitbucket.ts';
import { RepoError } from '../../src/errors.ts';
import { createClient } from '../../src/index.ts';

const email = process.env.REPO_SDK_LIVE_BITBUCKET_EMAIL;
const apiToken = process.env.REPO_SDK_LIVE_BITBUCKET_API_TOKEN;
const repo = process.env.REPO_SDK_LIVE_BITBUCKET_REPO;

describe.skipIf(!email || !apiToken || !repo)('Bitbucket live (read-only)', () => {
  const client = createClient({
    provider: bitbucket({ auth: { email: email!, apiToken: apiToken! } }),
  });

  it('rejects namespace listing as unsupported (Atlassian removed it via CHANGE-2770)', async () => {
    await expect(client.namespaces.list()).rejects.toMatchObject({
      code: 'unsupported',
      provider: 'bitbucket',
    });
    await expect(client.namespaces.list()).rejects.toBeInstanceOf(RepoError);
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

  // Verifies live that the archive host accepts API-token Basic auth and that the
  // tar.gz extension works against a real repository.
  it('streams the first tar.gz archive chunk', async () => {
    const repository = await client.repos.get({ repo: repo! });
    const archive = await client.repos.downloadArchive({
      repo: repo!,
      ref: repository.defaultBranch!,
      format: 'tar.gz',
    });
    const reader = archive.stream.getReader();
    const { value } = await reader.read();
    expect(value && value.byteLength).toBeGreaterThan(0);
    await reader.cancel();
  });
});

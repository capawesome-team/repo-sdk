import { describe, expect, it } from 'vitest';
import { detectWebhookProvider } from '../../src/index.ts';

describe('detectWebhookProvider', () => {
  it('detects each provider from its event header', async () => {
    await expect(detectWebhookProvider({ headers: { 'x-github-event': 'push' } })).resolves.toBe(
      'github',
    );
    await expect(
      detectWebhookProvider({ headers: { 'x-gitlab-event': 'Push Hook' } }),
    ).resolves.toBe('gitlab');
    await expect(detectWebhookProvider({ headers: { 'x-event-key': 'repo:push' } })).resolves.toBe(
      'bitbucket',
    );
    await expect(detectWebhookProvider({ headers: { 'x-gitea-event': 'push' } })).resolves.toBe(
      'gitea',
    );
  });

  it('prefers gitea when the compatibility x-github-event header is also present', async () => {
    await expect(
      detectWebhookProvider({
        headers: { 'x-github-event': 'push', 'x-gitea-event': 'push' },
      }),
    ).resolves.toBe('gitea');
  });

  it('matches headers case-insensitively', async () => {
    await expect(detectWebhookProvider({ headers: { 'X-GitHub-Event': 'push' } })).resolves.toBe(
      'github',
    );
  });

  it('detects azure-devops from the body eventType', async () => {
    await expect(
      detectWebhookProvider({
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'git.push', publisherId: 'tfs' }),
      }),
    ).resolves.toBe('azure-devops');
  });

  it('accepts a fetch Request and leaves its body readable', async () => {
    const request = new Request('https://example.com/hook', {
      method: 'POST',
      body: JSON.stringify({ eventType: 'git.push' }),
    });
    await expect(detectWebhookProvider(request)).resolves.toBe('azure-devops');
    await expect(request.text()).resolves.toContain('git.push');
  });

  it('prefers a provider header over the body', async () => {
    const request = new Request('https://example.com/hook', {
      method: 'POST',
      headers: { 'x-gitlab-event': 'Push Hook' },
      body: JSON.stringify({ eventType: 'git.push' }),
    });
    await expect(detectWebhookProvider(request)).resolves.toBe('gitlab');
  });

  it('returns undefined for unidentifiable input', async () => {
    await expect(detectWebhookProvider({ headers: {} })).resolves.toBeUndefined();
    await expect(detectWebhookProvider({ headers: {}, body: 'not json' })).resolves.toBeUndefined();
    await expect(
      detectWebhookProvider({ headers: {}, body: JSON.stringify({ hello: 'world' }) }),
    ).resolves.toBeUndefined();
    await expect(
      detectWebhookProvider({ headers: {}, body: JSON.stringify(['array']) }),
    ).resolves.toBeUndefined();
  });
});

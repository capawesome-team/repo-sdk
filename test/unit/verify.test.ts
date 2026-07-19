import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, timingSafeEqual, toIncomingWebhook } from '../../src/webhooks/verify.ts';

describe('hmacSha256Hex', () => {
  it('matches the RFC test vector', async () => {
    const signature = await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog');
    expect(signature).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('accepts binary payloads', async () => {
    const text = await hmacSha256Hex('secret', 'payload');
    const binary = await hmacSha256Hex('secret', new TextEncoder().encode('payload'));
    expect(binary).toBe(text);
  });
});

describe('timingSafeEqual', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqual('sha256=abc', 'sha256=abc')).toBe(true);
  });

  it('returns false for different strings and different lengths', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', 'a')).toBe(false);
  });
});

describe('toIncomingWebhook', () => {
  it('normalizes a fetch Request', async () => {
    const request = new Request('https://example.com/hook', {
      method: 'POST',
      headers: { 'X-GitHub-Event': 'push' },
      body: '{"ok":true}',
    });
    const incoming = await toIncomingWebhook(request);
    expect(incoming.headers['x-github-event']).toBe('push');
    expect(incoming.body).toBe('{"ok":true}');
    await expect(request.text()).resolves.toBe('{"ok":true}');
  });

  it('lower-cases header keys of plain objects', async () => {
    const incoming = await toIncomingWebhook({
      headers: { 'X-Gitlab-Token': 'secret' },
      body: '{}',
    });
    expect(incoming.headers['x-gitlab-token']).toBe('secret');
  });
});

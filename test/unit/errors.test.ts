import { describe, expect, it } from 'vitest';
import { codeFromStatus, parseRetryAfter, redactSecrets, RepoError } from '../../src/errors.ts';

describe('codeFromStatus', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [410, 'not_found'],
    [429, 'rate_limited'],
    [400, 'validation'],
    [422, 'validation'],
    [500, 'provider_error'],
    [503, 'provider_error'],
    [418, 'provider_error'],
  ])('maps %i to %s', (status, code) => {
    expect(codeFromStatus(status)).toBe(code);
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence of every secret', () => {
    expect(redactSecrets('token abc123 and again abc123 plus xyz', ['abc123', 'xyz'])).toBe(
      'token [redacted] and again [redacted] plus [redacted]',
    );
  });

  it('ignores empty secrets', () => {
    expect(redactSecrets('unchanged', [''])).toBe('unchanged');
  });
});

describe('RepoError', () => {
  it('redacts secrets in the message', () => {
    const error = new RepoError('request with token s3cret failed', {
      code: 'unauthorized',
      provider: 'github',
      secrets: ['s3cret'],
    });
    expect(error.message).toBe('request with token [redacted] failed');
  });

  it('defaults retryable for rate_limited and network_error', () => {
    for (const code of ['rate_limited', 'network_error'] as const) {
      expect(new RepoError('x', { code, provider: 'gitlab' }).retryable).toBe(true);
    }
    expect(new RepoError('x', { code: 'not_found', provider: 'gitlab' }).retryable).toBe(false);
  });

  it('marks 5xx as retryable', () => {
    const error = new RepoError('x', {
      code: 'provider_error',
      provider: 'bitbucket',
      status: 502,
    });
    expect(error.retryable).toBe(true);
  });

  it('honors an explicit retryable flag', () => {
    const error = new RepoError('x', {
      code: 'rate_limited',
      provider: 'github',
      retryable: false,
    });
    expect(error.retryable).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
  });

  it('parses HTTP dates into seconds from now', () => {
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(inTenSeconds);
    expect(parsed).toBeGreaterThanOrEqual(8);
    expect(parsed).toBeLessThanOrEqual(11);
  });

  it('returns undefined for null or garbage', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
  });
});

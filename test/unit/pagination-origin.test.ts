import { describe, expect, it } from 'vitest';
import { RepoError } from '../../src/errors.ts';
import { assertSameOriginUrl } from '../../src/pagination.ts';

describe('assertSameOriginUrl', () => {
  it('accepts a same-origin URL', () => {
    const url = 'https://api.github.com/repositories/1/commits?page=2';
    expect(assertSameOriginUrl('github', 'https://api.github.com', url)).toBe(url);
  });

  it('rejects a different host', () => {
    try {
      assertSameOriginUrl('github', 'https://api.github.com', 'https://attacker.example/x');
      expect.unreachable('expected RepoError');
    } catch (error) {
      expect(error).toBeInstanceOf(RepoError);
      expect((error as RepoError).code).toBe('validation');
    }
  });

  it('rejects a different scheme or port', () => {
    expect(() =>
      assertSameOriginUrl('gitlab', 'https://gitlab.com/api/v4', 'http://gitlab.com/api/v4/x'),
    ).toThrowError(RepoError);
    expect(() =>
      assertSameOriginUrl('gitlab', 'https://gitlab.com', 'https://gitlab.com:8443/x'),
    ).toThrowError(RepoError);
  });

  it('rejects a non-URL string', () => {
    expect(() =>
      assertSameOriginUrl('bitbucket', 'https://api.bitbucket.org/2.0', 'not-a-url'),
    ).toThrowError(RepoError);
  });
});

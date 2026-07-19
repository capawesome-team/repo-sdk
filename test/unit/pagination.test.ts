import { describe, expect, it } from 'vitest';
import { RepoError } from '../../src/errors.ts';
import { decodeCursor, encodeCursor } from '../../src/pagination.ts';

describe('cursor encoding', () => {
  it('round-trips arbitrary state', () => {
    const state = { page: 3, next: 'https://api.example.com/x?page=4', note: 'ünïcode ✓' };
    const cursor = encodeCursor('github', state);
    expect(decodeCursor('github', cursor)).toEqual(state);
  });

  it('produces URL-safe strings', () => {
    const cursor = encodeCursor('gitlab', { next: 'https://x.test/?a=1&b=2#frag' });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects cursors from another provider', () => {
    const cursor = encodeCursor('github', { page: 1 });
    expect(() => decodeCursor('gitlab', cursor)).toThrowError(RepoError);
    try {
      decodeCursor('gitlab', cursor);
    } catch (error) {
      expect((error as RepoError).code).toBe('validation');
    }
  });

  it('rejects garbage cursors', () => {
    expect(() => decodeCursor('github', 'not-a-cursor')).toThrowError(RepoError);
  });
});

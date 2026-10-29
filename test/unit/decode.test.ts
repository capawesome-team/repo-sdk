import { describe, expect, it } from 'vitest';
import {
  DecodeError,
  expectArray,
  expectBoolean,
  expectNumber,
  expectRecord,
  expectString,
} from '../../src/decode.ts';

describe('decode', () => {
  it.each([
    ['expectArray', () => expectArray({}, 'repositories'), 'expected an array of repositories'],
    [
      'expectBoolean',
      () => expectBoolean('yes', 'repository.private'),
      'expected a boolean for repository.private',
    ],
    [
      'expectNumber',
      () => expectNumber('1', 'repository.id'),
      'expected a number for repository.id',
    ],
    ['expectRecord', () => expectRecord([], 'repository'), 'expected an object for repository'],
    ['expectRecord', () => expectRecord(null, 'repository'), 'expected an object for repository'],
    [
      'expectString',
      () => expectString(1, 'repository.name'),
      'expected a string for repository.name',
    ],
  ])('%s names what was expected when the value has another shape', (_name, decode, message) => {
    expect(decode).toThrow(new DecodeError(message));
  });

  it('returns the value when it has the expected shape', () => {
    const repository = { id: 1, name: 'repo-sdk', private: true };
    expect(expectRecord(repository, 'repository')).toBe(repository);
    expect(expectArray([repository], 'repositories')).toEqual([repository]);
    expect(expectNumber(repository.id, 'repository.id')).toBe(1);
    expect(expectString(repository.name, 'repository.name')).toBe('repo-sdk');
    expect(expectBoolean(repository.private, 'repository.private')).toBe(true);
  });
});

import { expect, test } from 'vitest';

import * as sdk from '../src/index.ts';

test('sdk entry module loads', () => {
  expect(sdk).toBeDefined();
});

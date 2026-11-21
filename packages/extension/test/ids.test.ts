/** Test builds leave out the git-ignored cloud-ids.local.json (build/targets.ts). */
import { afterEach, expect, test } from 'vitest';
import { useLocalIds } from '../build/targets';

const saved = process.env.INK_NO_LOCAL_IDS;
afterEach(() => {
  if (saved === undefined) delete process.env.INK_NO_LOCAL_IDS;
  else process.env.INK_NO_LOCAL_IDS = saved;
});

test('a release build reads the local ids; a test build and a fake cloud build do not', () => {
  delete process.env.INK_NO_LOCAL_IDS;
  expect(useLocalIds(false)).toBe(true);
  expect(useLocalIds(true)).toBe(false);
  process.env.INK_NO_LOCAL_IDS = '1';
  expect(useLocalIds(false)).toBe(false);
});

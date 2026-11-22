/** The e2e run refuses a build that carries the local client ids (e2e/build-check.ts). */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { carries, idsIn, localIdsMessage } from '../e2e/build-check';

const made: string[] = [];
const folder = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ink-build-check-'));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('the ids of a file: the set ones, and none for a missing or broken file', () => {
  const d = folder();
  writeFileSync(join(d, 'a.json'), JSON.stringify({ google: 'g-1', microsoft: '' }));
  writeFileSync(join(d, 'b.json'), '{');
  expect(idsIn(join(d, 'a.json'))).toEqual(['g-1']);
  expect(idsIn(join(d, 'b.json'))).toEqual([]);
  expect(idsIn(join(d, 'none.json'))).toEqual([]);
});

test('a build with a local id in a chunk is found, and one without is not', () => {
  const d = folder();
  const local = join(d, 'cloud-ids.local.json');
  writeFileSync(local, JSON.stringify({ google: 'g-1.apps.test', microsoft: 'm-2' }));
  const clean = join(d, 'clean');
  const withIds = join(d, 'with');
  mkdirSync(join(clean, 'chunks'), { recursive: true });
  mkdirSync(join(withIds, 'chunks'), { recursive: true });
  writeFileSync(join(clean, 'chunks', 'options.js'), 'const ids={google:"",microsoft:""}');
  writeFileSync(join(withIds, 'chunks', 'options.js'), 'const ids={google:"g-1.apps.test",microsoft:""}');
  expect(carries(clean, idsIn(local))).toBe(false);
  expect(carries(withIds, idsIn(local))).toBe(true);
  expect(localIdsMessage(local, [clean])).toBe('');
  const said = localIdsMessage(local, [clean, withIds, join(d, 'missing')]);
  expect(said).toContain(withIds);
  expect(said).not.toContain(clean);
  expect(said).toContain('test:e2e');
});

test('no local file: nothing is refused', () => {
  const d = folder();
  writeFileSync(join(d, 'x.js'), 'anything');
  expect(localIdsMessage(join(d, 'cloud-ids.local.json'), [d])).toBe('');
});

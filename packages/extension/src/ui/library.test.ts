import { createStore, exportArchive, memoryKV } from 'pageink-core/store';
import { expect, test } from 'vitest';
import { identity, note, record } from '../testing/records';
import { exportName, hostOfPage, importFile, matches, moveTargets, reportText, targetOf } from './library';

const page = {
  key: 'k',
  hash: 'h',
  title: 'Ink and Paper',
  url: 'https://ex.test/ink',
  updatedAt: 1,
  notes: 2,
};

test('matches searches title and address, ignoring case', () => {
  expect(matches(page, '')).toBe(true);
  expect(matches(page, 'PAPER')).toBe(true);
  expect(matches(page, 'ex.test')).toBe(true);
  expect(matches(page, 'nothing')).toBe(false);
});

test('saved files carry the product name', () => {
  expect(exportName('zip')).toMatch(/^pageink-notes-\d{4}-\d{2}-\d{2}\.zip$/);
  expect(exportName('md')).toMatch(/^pageink-notes-\d{4}-\d{2}-\d{2}\.md$/);
});

test('reportText', () => {
  expect(reportText({ pulled: 2, pushed: 0, merged: 1, conflictsFolded: 0, errors: [] })).toBe(
    'Imported 2 new, merged 1',
  );
  expect(reportText({ pulled: 0, pushed: 0, merged: 0, conflictsFolded: 0, errors: ['x'] })).toContain(
    '1 failed',
  );
});

test('importFile reads an archive file into the store', async () => {
  const a = createStore(memoryKV());
  await a.save(record('https://ex.test/ink', [note('n1')]), identity('https://ex.test/ink'));
  const bytes = await exportArchive(a);
  const b = createStore(memoryKV());
  const r = await importFile(b, new File([bytes as BlobPart], 'ink.zip'));
  expect(r.pulled + r.merged).toBe(1);
  expect((await b.get('https://ex.test/ink'))?.notes).toHaveLength(1);
});

test('notes move to pages on the same site, or to a pasted web address', () => {
  const at = (key: string) => ({ ...page, key, url: key });
  const all = [
    at('https://ex.test/a'),
    at('https://ex.test/b'),
    at('https://other.test/c'),
    at('file:///x.pdf'),
  ];
  expect(moveTargets(all[0]!, all).map((p) => p.key)).toEqual(['https://ex.test/b']);
  expect(hostOfPage(all[3]!)).toBe('');
  expect(targetOf(' https://ex.test/new?token=abc ')?.key).toBe('https://ex.test/new');
  expect(targetOf('javascript:alert(1)')).toBeNull();
  expect(targetOf('ex.test/new')).toBeNull();
});

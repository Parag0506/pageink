import { expect, test } from 'vitest';
import { hostOf, readCfg, resetCfg, setSite, withSite } from './cfg';

test('hostOf takes web and file addresses only', () => {
  expect(hostOf('https://en.wikipedia.org/wiki/Ink')).toBe('en.wikipedia.org');
  expect(hostOf('chrome://extensions')).toBe('');
  expect(hostOf(undefined)).toBe('');
  expect(hostOf('not a url')).toBe('');
});

test('withSite adds and removes a host once', () => {
  expect(withSite(undefined, 'a.test', false)).toEqual(['a.test']);
  expect(withSite(['a.test'], 'a.test', false)).toEqual(['a.test']);
  expect(withSite(['a.test', 'b.test'], 'a.test', true)).toEqual(['b.test']);
});

test('setSite keeps the other settings', async () => {
  const m: Record<string, unknown> = { cfg: { v: 1, device: 'd', off: ['x.test'], modifier: 'Meta' } };
  const area = {
    get: async (k: string) => (k in m ? { [k]: m[k] } : {}),
    set: async (o: Record<string, unknown>) => void Object.assign(m, o),
  } as unknown as chrome.storage.StorageArea;
  expect((await readCfg(area)).modifier).toBe('Meta');
  await setSite(area, 'a.test', false);
  expect(m.cfg).toEqual({ v: 1, device: 'd', off: ['x.test', 'a.test'], modifier: 'Meta' });
  await setSite(area, 'x.test', true);
  expect((await readCfg(area)).off).toEqual(['a.test']);
  delete m.cfg;
  expect(await readCfg(area)).toEqual({});
  // Settings of the wrong shape count as absent, so the popup never trusts them.
  m.cfg = 'cfg';
  expect(await readCfg(area)).toEqual({});
  m.cfg = { off: 'a.test', modifier: 'Meta' };
  expect(await readCfg(area)).toEqual({ modifier: 'Meta' });
  await setSite(area, 'b.test', false);
  expect((m.cfg as { off: string[] }).off).toEqual(['b.test']);
});

test('resetCfg keeps only the install id and the folder', async () => {
  const m: Record<string, unknown> = {
    cfg: {
      v: 1,
      device: 'd',
      folder: 'Notes',
      off: ['x.test'],
      theme: 'dark',
      thumbs: false,
      drawOn: ['y.test'],
    },
    'p:abc': { notes: 1 },
  };
  const area = {
    get: async (k: string) => (k in m ? { [k]: m[k] } : {}),
    set: async (o: Record<string, unknown>) => void Object.assign(m, o),
  } as unknown as chrome.storage.StorageArea;
  expect(await resetCfg(area)).toEqual({ v: 1, device: 'd', folder: 'Notes' });
  expect(await readCfg(area)).toEqual({ v: 1, device: 'd', folder: 'Notes' });
  expect(m['p:abc']).toEqual({ notes: 1 });
});

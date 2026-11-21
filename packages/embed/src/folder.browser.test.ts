import { hashKey } from 'pageink-core';
import type { PageRecord } from 'pageink-core/types';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { fsFolder } from './folder';
import { type InkHandle, mountWith } from './mount';
import { ARTICLE, fromTest, recordingKV, stroke, until, zigzag } from './testkit';

let dir: FileSystemDirectoryHandle;
const handles: InkHandle[] = [];

beforeAll(async () => {
  await page.viewport(900, 800);
});

/**
 * The origin private file system, or null where the test browser has none. Playwright's
 * WebKit throws UnknownError from getDirectory in its throwaway profile.
 */
async function opfs(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.destroy();
  document.body.innerHTML = '';
  const root = await opfs();
  if (dir) await root?.removeEntry(dir.name, { recursive: true }).catch(() => {});
});

async function fresh(skip: (note: string) => never): Promise<FileSystemDirectoryHandle> {
  const root = await opfs();
  if (!root) skip('no origin private file system in this test browser');
  dir = await root.getDirectoryHandle(`ink-test-${Math.random().toString(36).slice(2)}`, { create: true });
  return dir;
}

describe('fsFolder over the origin private file system', () => {
  test('write, read, list and remove, with folders made on demand', async ({ skip }) => {
    const io = fsFolder(await fresh(skip));
    expect(await io.list('pages')).toEqual([]);
    await io.write('pages/a.ink.json', '{"a":1}');
    await io.write('pages/b.ink.json', 'β');
    await io.write('pages/a.ink.json', '{"a":2}');
    expect(await io.read('pages/a.ink.json')).toBe('{"a":2}');
    expect(await io.read('pages/b.ink.json')).toBe('β');
    const list = await io.list('pages');
    expect(list.map((f) => f.name)).toEqual(['a.ink.json', 'b.ink.json']);
    expect(list[0]!.size).toBe(7);
    expect(list[0]!.mtime).toBeGreaterThan(0);
    await io.remove?.('pages/b.ink.json');
    await io.remove?.('pages/never.ink.json');
    expect((await io.list('pages')).map((f) => f.name)).toEqual(['a.ink.json']);
    await expect(io.read('pages/b.ink.json')).rejects.toThrow();
    await expect(io.write('../x', 'no')).rejects.toThrow(/leaves the folder/);
  });

  test('handle.sync pushes to the folder and a second store pulls from it', async ({ skip }) => {
    document.body.innerHTML = ARTICLE;
    const io = fsFolder(await fresh(skip));
    let h = mountWith({ store: recordingKV(), page: 'synced' }, { real: fromTest });
    handles.push(h);
    await h.ready;
    const r = document.getElementById('p0')!.getBoundingClientRect();
    await stroke(zigzag(r.right + 20, r.top, 80, 20));
    await until(() => h.state().notes === 1, 'note');
    const push = await h.sync(io);
    expect(push.errors).toEqual([]);
    expect(push.pushed).toBe(1);
    const text = await io.read(`pages/${hashKey('synced')}.ink.json`);
    const rec = JSON.parse(text) as PageRecord;
    expect(rec.key).toBe('synced');
    expect(rec.notes).toHaveLength(1);
    await h.destroy();
    handles.length = 0;

    h = mountWith({ store: recordingKV(), page: 'synced' }, { real: fromTest });
    handles.push(h);
    await h.ready;
    expect(h.state().notes).toBe(0);
    const pull = await h.sync(io);
    expect(pull.pulled).toBe(1);
    await until(() => h.state().notes === 1, 'note from the folder');
  });
});

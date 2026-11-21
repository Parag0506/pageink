import { describe, expect, test } from 'vitest';
import { canPickFolder, type DirHandle, type FileHandle, folderAccess, fsFolder } from './folder-fs';

/** In-memory directory handle with the File System Access shape. */
function dir(name = 'root', perm: 'granted' | 'prompt' = 'granted'): DirHandle & { perm: string } {
  const kids = new Map<string, DirHandle | FileHandle>();
  const notFound = () => Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
  const d = {
    kind: 'directory' as const,
    name,
    perm,
    async getDirectoryHandle(n: string, o?: { create?: boolean }) {
      let k = kids.get(n);
      if (!k && o?.create) {
        k = dir(n);
        kids.set(n, k);
      }
      if (k?.kind !== 'directory') throw notFound();
      return k;
    },
    async getFileHandle(n: string, o?: { create?: boolean }) {
      let k = kids.get(n);
      if (!k && o?.create) {
        let text = '';
        let mtime = 0;
        const f: FileHandle = {
          kind: 'file',
          name: n,
          getFile: async () =>
            Object.assign(new Blob([text]), { lastModified: mtime, name: n }) as unknown as File,
          createWritable: async () => {
            let buf = '';
            return {
              write: async (s: string) => {
                buf += s;
              },
              close: async () => {
                text = buf;
                mtime++;
              },
            };
          },
        };
        k = f;
        kids.set(n, f);
      }
      if (k?.kind !== 'file') throw notFound();
      return k;
    },
    async removeEntry(n: string) {
      if (!kids.delete(n)) throw notFound();
    },
    async *values() {
      yield* kids.values();
    },
    async queryPermission() {
      return d.perm as 'granted' | 'prompt';
    },
    async requestPermission() {
      d.perm = 'granted';
      return 'granted' as const;
    },
  };
  return d;
}

describe('fsFolder', () => {
  test('write creates folders, list returns names from the root, read and remove work', async () => {
    const io = fsFolder(dir());
    expect(await io.list('pages')).toEqual([]);
    await io.write('pages/a.ink.json', 'A');
    await io.write('pages/b.ink.json', 'BB');
    await io.write('other.txt', 'x');
    const listed = await io.list('pages');
    expect(listed.map((f) => [f.name, f.size])).toEqual([
      ['pages/a.ink.json', 1],
      ['pages/b.ink.json', 2],
    ]);
    expect(await io.read('pages/b.ink.json')).toBe('BB');
    await io.write('pages/b.ink.json', 'new');
    expect(await io.read('pages/b.ink.json')).toBe('new');
    await io.remove!('pages/a.ink.json');
    expect((await io.list('pages')).map((f) => f.name)).toEqual(['pages/b.ink.json']);
    await expect(io.read('pages/none')).rejects.toThrow();
  });
});

describe('folderAccess', () => {
  test('reports the state and asks only when told to', async () => {
    const d = dir('x', 'prompt');
    expect(await folderAccess(d)).toBe('prompt');
    expect(d.perm).toBe('prompt');
    expect(await folderAccess(d, true)).toBe('granted');
  });

  test('a handle without permission methods counts as granted', async () => {
    const d = dir();
    delete (d as Partial<DirHandle>).queryPermission;
    expect(await folderAccess(d)).toBe('granted');
  });
});

test('canPickFolder looks for showDirectoryPicker', () => {
  expect(canPickFolder({})).toBe(false);
  expect(canPickFolder({ showDirectoryPicker() {} })).toBe(true);
});

/**
 * FolderIO over a folder the reader picked with showDirectoryPicker
 * (Chromium only). The handle is kept in IndexedDB so the background can use
 * it later. Access to a stored handle lapses when the browser restarts. The
 * popup and the options page ask again with one click. Chromium 122 and later
 * then shows its restore prompt, whose "Allow on every visit" keeps access
 * across restarts from then on. requestPermission has no option to ask for
 * that directly, so the click is the best there is. Names are paths relative
 * to the picked folder.
 */
import type { FolderIO } from 'pageink-core/types';

type Mode = { mode: 'readwrite' };
type PermissionState = 'granted' | 'denied' | 'prompt';

/** The parts of the File System Access API this file uses. Not all are in the TS DOM types. */
export interface DirHandle {
  kind: 'directory';
  name: string;
  getDirectoryHandle(name: string, o?: { create?: boolean }): Promise<DirHandle>;
  getFileHandle(name: string, o?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterable<DirHandle | FileHandle>;
  queryPermission?(o: Mode): Promise<PermissionState>;
  requestPermission?(o: Mode): Promise<PermissionState>;
}

export interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
}

const RW: Mode = { mode: 'readwrite' };

export const canPickFolder = (g: unknown = globalThis): boolean =>
  typeof (g as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

/** Ask the reader for a folder. Must run from a click. */
export async function pickFolder(): Promise<DirHandle> {
  const pick = (globalThis as unknown as { showDirectoryPicker(o: object): Promise<DirHandle> })
    .showDirectoryPicker;
  const h = await pick({ id: 'ink-notes', mode: 'readwrite' });
  await saveHandle(h);
  return h;
}

/** Current access. With `ask`, prompts the reader, which needs a click. */
export async function folderAccess(h: DirHandle, ask = false): Promise<PermissionState> {
  let s = (await h.queryPermission?.(RW)) ?? 'granted';
  if (s !== 'granted' && ask && h.requestPermission) s = await h.requestPermission(RW);
  return s;
}

async function dirOf(root: DirHandle, parts: string[], create: boolean): Promise<DirHandle> {
  let d = root;
  for (const p of parts) if (p) d = await d.getDirectoryHandle(p, { create });
  return d;
}

const split = (name: string): [string[], string] => {
  const parts = name.split('/').filter(Boolean);
  const file = parts.pop() ?? '';
  return [parts, file];
};

export function fsFolder(root: DirHandle): FolderIO {
  return {
    async list(dir) {
      const out: { name: string; mtime: number; size: number }[] = [];
      let d: DirHandle;
      try {
        d = await dirOf(root, dir.split('/'), false);
      } catch {
        return out;
      }
      const pre = dir.replace(/\/$/, '');
      for await (const e of d.values()) {
        if (e.kind !== 'file') continue;
        const f = await e.getFile();
        out.push({ name: pre ? `${pre}/${e.name}` : e.name, mtime: f.lastModified, size: f.size });
      }
      return out;
    },
    async read(name) {
      const [dirs, file] = split(name);
      const d = await dirOf(root, dirs, false);
      return (await (await d.getFileHandle(file)).getFile()).text();
    },
    async write(name, text) {
      const [dirs, file] = split(name);
      const d = await dirOf(root, dirs, true);
      const w = await (await d.getFileHandle(file, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    },
    async remove(name) {
      const [dirs, file] = split(name);
      await (await dirOf(root, dirs, false)).removeEntry(file);
    },
  };
}

// The handle lives in IndexedDB because extension storage cannot hold it.
const DB = 'ink-folder';
const STORE = 'handles';
const KEY = 'folder';

function db(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = idb.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

async function tx<T>(
  idb: IDBFactory,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const d = await db(idb);
  try {
    return await new Promise<T>((ok, fail) => {
      const r = fn(d.transaction(STORE, mode).objectStore(STORE));
      r.onsuccess = () => ok(r.result as T);
      r.onerror = () => fail(r.error);
    });
  } finally {
    d.close();
  }
}

export const saveHandle = (h: DirHandle | null, idb: IDBFactory = indexedDB): Promise<void> =>
  tx(idb, 'readwrite', (s) => (h ? s.put(h, KEY) : s.delete(KEY)));

export const loadHandle = async (idb: IDBFactory = indexedDB): Promise<DirHandle | null> =>
  ((await tx<DirHandle | undefined>(idb, 'readonly', (s) => s.get(KEY))) ?? null) as DirHandle | null;

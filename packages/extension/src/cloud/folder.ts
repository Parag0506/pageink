/**
 * A cloud seen as a folder (FolderIO), so the same syncFolder merges with it as with a folder
 * on disk. Names map to file ids through a list that is kept in storage and rebuilt by
 * listing: in full now and then, and otherwise brought up to date with the provider's cheap
 * change check. Same layout as the folder: pages/<hash>.ink.json, and the lock file on top.
 */
import type { FolderIO } from 'pageink-core/types';
import { CloudError, isCode } from './http';
import type { Folders, Provider, RemoteFile } from './provider';

const DIR = 'pages';
/** A full listing at least this often. Between them the change check is enough. */
export const RELIST_MS = 60 * 60 * 1000;

/** The name list as kept between runs. */
export interface NameCache {
  files: RemoteFile[];
  cursor: string | null;
  listedAt: number;
}

export interface CacheStore {
  get(): Promise<NameCache | null>;
  set(c: NameCache | null): Promise<void>;
}

/** A file's version as last seen, for the read cache above (connect/cache.ts). */
export interface Peek {
  version: string;
}

export interface CloudFolder extends FolderIO {
  /** The version the listing holds for a name, without any request. */
  peek(name: string): Peek | undefined;
  /** Writes refused because another device wrote first, since the last call. */
  takeConflicts(): number;
}

/**
 * Two files with one name can happen on Drive. The one with the lowest id keeps the name, so
 * every device picks the same one and a write does not move the name. Each other one is
 * shown as a sync copy, "<stem> (copy <id>).ink.json", which sync folds in and removes.
 */
function named(files: RemoteFile[]): Map<string, RemoteFile> {
  const byName = new Map<string, RemoteFile[]>();
  for (const f of files) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const out = new Map<string, RemoteFile>();
  for (const [name, list] of byName) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    out.set(name, list[0]!);
    for (const f of list.slice(1)) {
      const stem = name.replace(/\.ink\.json$/, '');
      out.set(`${stem} (copy ${f.id.replace(/[^a-zA-Z0-9]/g, '').slice(-8)}).ink.json`, f);
    }
  }
  return out;
}

export interface CloudFolderDeps {
  provider: Provider;
  cache: CacheStore;
  now?: () => number;
}

export function cloudFolder(d: CloudFolderDeps): CloudFolder {
  const { provider: p } = d;
  const now = d.now ?? Date.now;
  let folders: Folders | null = null;
  let state: NameCache | null = null;
  let pages = new Map<string, RemoteFile>();
  let top: Map<string, RemoteFile> | null = null;
  let conflicts = 0;

  const ensure = async () => (folders ??= await p.folders());

  async function fullList(): Promise<void> {
    const f = await ensure();
    const l = await p.list(f.pages);
    state = { files: l.files, cursor: l.cursor, listedAt: now() };
    await d.cache.set(state);
  }

  async function refresh(): Promise<void> {
    const f = await ensure();
    state ??= await d.cache.get();
    if (!state?.cursor || now() - state.listedAt > RELIST_MS) return fullList();
    try {
      const c = await p.changes(f.pages, state.cursor);
      const byId = new Map(state.files.map((x) => [x.id, x]));
      for (const id of c.gone) byId.delete(id);
      for (const x of c.files) byId.set(x.id, x);
      state = { ...state, files: [...byId.values()], cursor: c.cursor };
      await d.cache.set(state);
    } catch (e) {
      if (isCode(e, 'reset') || isCode(e, 'not-found')) return fullList();
      throw e;
    }
  }

  /** Keep the stored list in step with what this device just did. */
  async function remember(f: RemoteFile | null, dropId?: string): Promise<void> {
    if (!state) return;
    const files = state.files.filter((x) => x.id !== dropId && x.id !== f?.id);
    if (f) files.push(f);
    state = { ...state, files };
    pages = named(files);
    await d.cache.set(state);
  }

  const split = (name: string): [string, string] => {
    const i = name.lastIndexOf('/');
    return i < 0 ? ['', name] : [name.slice(0, i), name.slice(i + 1)];
  };

  async function topFiles(): Promise<Map<string, RemoteFile>> {
    if (top) return top;
    const f = await ensure();
    top = new Map((await p.list(f.top)).files.map((x) => [x.name, x]));
    return top;
  }

  async function lookup(name: string): Promise<RemoteFile | undefined> {
    const [dir, base] = split(name);
    if (dir === DIR) {
      if (!state) {
        await refresh();
        pages = named(state!.files);
      }
      return pages.get(base);
    }
    if (dir === '') return (await topFiles()).get(base);
    return undefined;
  }

  return {
    async list(dir) {
      const clean = dir.replace(/\/$/, '');
      if (clean === '') {
        return [...(await topFiles()).values()].map((f) => ({ name: f.name, mtime: f.mtime, size: f.size }));
      }
      if (clean !== DIR) return [];
      await refresh();
      pages = named(state!.files);
      return [...pages].map(([name, f]) => ({ name: `${DIR}/${name}`, mtime: f.mtime, size: f.size }));
    },

    async read(name) {
      const f = await lookup(name);
      if (!f) throw new CloudError('not-found', 404, name);
      try {
        return await p.download(f);
      } catch (e) {
        // Deleted elsewhere: forget it, so the next write makes a new file.
        if (isCode(e, 'not-found')) await remember(null, f.id);
        throw e;
      }
    },

    async write(name, text) {
      const [dir, base] = split(name);
      if (dir !== DIR && dir !== '') throw new CloudError('denied', 0, 'outside the folder');
      const f = await lookup(name);
      const fs = await ensure();
      const parent = dir === DIR ? fs.pages : fs.top;
      let out: RemoteFile;
      try {
        if (f) {
          try {
            out = await p.update(f, text);
          } catch (e) {
            if (!isCode(e, 'not-found')) throw e;
            // Removed elsewhere since the last listing: write it anew.
            await remember(null, f.id);
            out = await p.create(parent, base, text);
          }
        } else {
          out = await p.create(parent, base, text);
        }
      } catch (e) {
        if (isCode(e, 'conflict')) {
          conflicts++;
          // Another device wrote first. List again, so the next pass reads its version.
          if (state) {
            state = { ...state, listedAt: 0 };
            await d.cache.set(state);
          }
          top = null;
        }
        throw e;
      }
      if (dir === DIR) await remember(out, f?.id);
      else top?.set(base, out);
    },

    async remove(name) {
      const f = await lookup(name);
      if (!f) return;
      await p.remove(f);
      const [dir, base] = split(name);
      if (dir === DIR) await remember(null, f.id);
      else top?.delete(base);
    },

    peek(name) {
      const [dir, base] = split(name);
      const f = dir === DIR ? pages.get(base) : top?.get(base);
      return f ? { version: f.version } : undefined;
    },

    takeConflicts() {
      const n = conflicts;
      conflicts = 0;
      return n;
    },
  };
}

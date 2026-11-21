import type { FolderIO, KV } from '../types';

type Listener = (changed: Record<string, unknown | undefined>) => void;

/**
 * In-memory KV for tests and hosts without storage. Values are copied on the way in
 * and out, like real storage. Change events arrive after the write, as in browsers.
 */
export function memoryKV(initial: Record<string, unknown> = {}): KV {
  const data = new Map<string, unknown>(Object.entries(structuredClone(initial)));
  const listeners = new Set<Listener>();
  const emit = (changed: Record<string, unknown | undefined>) => {
    if (Object.keys(changed).length === 0) return;
    queueMicrotask(() => {
      for (const l of [...listeners]) l(structuredClone(changed));
    });
  };
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items) {
      const copy = structuredClone(items);
      for (const [k, v] of Object.entries(copy)) data.set(k, v);
      emit(copy);
    },
    async remove(keys) {
      const changed: Record<string, undefined> = {};
      for (const k of keys) if (data.delete(k)) changed[k] = undefined;
      emit(changed);
    },
    async keys(prefix) {
      return [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** In-memory folder. `list(dir)` returns full relative names such as "pages/a.ink.json". */
export function memoryFolder(initial: Record<string, string> = {}): FolderIO {
  const files = new Map<string, { text: string; mtime: number }>();
  let clock = 0;
  for (const [k, v] of Object.entries(initial)) files.set(k, { text: v, mtime: ++clock });
  return {
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...files]
        .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
        .map(([name, f]) => ({ name, mtime: f.mtime, size: f.text.length }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    async read(name) {
      const f = files.get(name);
      if (!f) throw new Error(`no such file: ${name}`);
      return f.text;
    },
    async write(name, text) {
      files.set(name, { text, mtime: ++clock });
    },
    async remove(name) {
      files.delete(name);
    },
  };
}

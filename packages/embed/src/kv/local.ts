import type { KV } from 'pageink-core/types';

/** A KV this script created. close() lets it go when the handle is destroyed. */
export interface OwnedKV extends KV {
  close(): void;
}

type Changed = Record<string, unknown | undefined>;
type Listener = (changed: Changed) => void;

/** Calls listeners after the current task, each with its own copy. */
export function fanout(): { add(cb: Listener): () => void; emit(changed: Changed): void; clear(): void } {
  const listeners = new Set<Listener>();
  return {
    add(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    emit(changed) {
      if (!listeners.size) return;
      queueMicrotask(() => {
        for (const l of [...listeners]) l(structuredClone(changed));
      });
    },
    clear: () => listeners.clear(),
  };
}

export interface LocalKVOptions {
  /** Prefix for every key in localStorage. Default "ink:". */
  prefix?: string;
  /** Default: window.localStorage. */
  storage?: Storage;
}

/**
 * A KV over localStorage. Values are JSON. Other tabs learn of changes through the
 * storage event. localStorage holds a few megabytes, so IndexedDB is the better default.
 */
export function localKV(opts: LocalKVOptions = {}): OwnedKV {
  const prefix = opts.prefix ?? 'ink:';
  const ls = opts.storage ?? window.localStorage;
  const out = fanout();

  const read = (k: string): unknown => {
    const v = ls.getItem(prefix + k);
    if (v === null) return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  };

  const onStorage = (e: StorageEvent): void => {
    if (e.storageArea !== ls) return;
    // clear() in another tab arrives with no key.
    if (e.key === null) return;
    if (!e.key.startsWith(prefix)) return;
    let v: unknown;
    try {
      v = e.newValue === null ? undefined : JSON.parse(e.newValue);
    } catch {
      return;
    }
    out.emit({ [e.key.slice(prefix.length)]: v });
  };
  window.addEventListener('storage', onStorage);

  return {
    async get(keys) {
      const res: Record<string, unknown> = {};
      for (const k of keys) {
        const v = read(k);
        if (v !== undefined) res[k] = v;
      }
      return res;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) ls.setItem(prefix + k, JSON.stringify(v));
      out.emit(items);
    },
    async remove(keys) {
      const changed: Changed = {};
      for (const k of keys) {
        ls.removeItem(prefix + k);
        changed[k] = undefined;
      }
      out.emit(changed);
    },
    async keys(p) {
      const res: string[] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k?.startsWith(prefix + p)) res.push(k.slice(prefix.length));
      }
      return res.sort();
    },
    onChange: (cb) => out.add(cb),
    close() {
      window.removeEventListener('storage', onStorage);
      out.clear();
    },
  };
}

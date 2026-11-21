/**
 * Where the background keeps sign-in tokens and the lock key: the extension's own IndexedDB.
 * Content scripts run with the page's origin, so they cannot open it, and nothing here is in
 * `storage.local`, which every content script can read and whose changes reach every tab.
 * Where the browser lets `storage.session` be limited to the extension's own pages, it is used
 * as a quick copy that goes when the browser closes.
 *
 * Values from before this store existed are moved out of `storage.local` once, then removed
 * there.
 */

import { DEST_KEY } from '../connect/dest';

/** The few calls the place and the cloud code need. */
export interface Secrets {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** The keys that are secrets: every cloud's tokens and the lock key. */
export const isSecretKey = (k: string): boolean => k.startsWith('tok:') || k === 'lockKey';

type Local = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;
type Session = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'> & {
  setAccessLevel?: (o: { accessLevel: string }) => Promise<void>;
};

const DB = 'pageink-secrets';
const STORE = 'kv';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, no) => {
    r.onsuccess = () => ok(r.result);
    r.onerror = () => no(r.error);
  });
}

/** A key-value store in IndexedDB. One database, one object store, values as given. */
export function idbSecrets(idb: IDBFactory = globalThis.indexedDB, name = DB): Secrets {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    db ??= new Promise<IDBDatabase>((ok, no) => {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => {
        db = null;
        no(r.error);
      };
    });
    return db;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  const done = (s: IDBObjectStore) =>
    new Promise<void>((ok, no) => {
      s.transaction.oncomplete = () => ok();
      s.transaction.onerror = () => no(s.transaction.error);
      s.transaction.onabort = () => no(s.transaction.error);
    });
  return {
    get: async (key) => req((await tx('readonly')).get(key)),
    async set(key, value) {
      const s = await tx('readwrite');
      s.put(value, key);
      await done(s);
    },
    async remove(keys) {
      const s = await tx('readwrite');
      for (const k of Array.isArray(keys) ? keys : [keys]) s.delete(k);
      await done(s);
    },
  };
}

/** Secrets in memory, for tests and for a background with no IndexedDB. */
export function memorySecrets(seed: Record<string, unknown> = {}): Secrets & { all: Map<string, unknown> } {
  const all = new Map(Object.entries(seed));
  return {
    all,
    get: async (k) => structuredClone(all.get(k)),
    set: async (k, v) => {
      all.set(k, structuredClone(v));
    },
    remove: async (keys) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) all.delete(k);
    },
  };
}

/** Move secrets kept in storage.local by older versions into the store, then remove them there. */
export async function moveSecrets(local: Local, to: Secrets): Promise<string[]> {
  const everything = (await local.get(null)) as Record<string, unknown>;
  const keys = Object.keys(everything).filter(isSecretKey);
  for (const k of keys) {
    // A value already in the store is newer than the old copy.
    if ((await to.get(k)) === undefined) await to.set(k, everything[k]);
  }
  if (keys.length) await local.remove(keys);
  // Older builds kept the account name in the place as well. It belongs with the tokens only.
  const dest = everything[DEST_KEY];
  if (dest && typeof dest === 'object' && 'account' in dest) {
    const { account: _, ...rest } = dest as Record<string, unknown>;
    await local.set({ [DEST_KEY]: rest });
  }
  return keys;
}

/**
 * The background's secrets: IndexedDB, with storage.session as a copy where it can be kept
 * from content scripts, and the old values moved out of storage.local before the first use.
 */
export function backgroundSecrets(d: { local: Local; session?: Session; store?: Secrets }): Secrets {
  const store = d.store ?? idbSecrets();
  let session: Promise<Session | null> | null = null;
  const cache = () => {
    session ??= (async () => {
      const s = d.session;
      if (!s || typeof s.setAccessLevel !== 'function') return null;
      try {
        await s.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        return s;
      } catch {
        return null;
      }
    })();
    return session;
  };
  let ready: Promise<unknown> | null = null;
  const moved = () => {
    ready ??= moveSecrets(d.local, store).catch(() => {
      // Tried again on the next call.
      ready = null;
    });
    return ready;
  };
  return {
    async get(key) {
      await moved();
      const s = await cache();
      const hit = s ? ((await s.get(key).catch(() => ({}))) as Record<string, unknown>)[key] : undefined;
      if (hit !== undefined) return hit;
      const v = await store.get(key);
      if (s && v !== undefined) await s.set({ [key]: v }).catch(() => {});
      return v;
    },
    async set(key, value) {
      await moved();
      await store.set(key, value);
      const s = await cache();
      if (s) await s.set({ [key]: value }).catch(() => {});
    },
    async remove(keys) {
      await moved();
      await store.remove(keys);
      const s = await cache();
      if (s) await s.remove(keys).catch(() => {});
    },
  };
}

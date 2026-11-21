import { fanout, type OwnedKV } from './local';

export interface IndexedDbKVOptions {
  /** Database name. Default "ink". */
  name?: string;
}

const STORE = 'kv';

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });

/**
 * A KV over IndexedDB, one object store of structured values. Other tabs and other
 * KVs over the same database learn of changes through a BroadcastChannel.
 */
export function indexedDbKV(opts: IndexedDbKVOptions = {}): OwnedKV {
  const name = opts.name ?? 'ink';
  const out = fanout();
  let dbp: Promise<IDBDatabase> | null = null;
  let closed = false;

  const open = (): Promise<IDBDatabase> => {
    if (closed) return Promise.reject(new Error('This store is closed.'));
    dbp ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab wants a newer version: let it, and reopen on the next call.
        db.onversionchange = () => {
          db.close();
          dbp = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbp = null;
        reject(req.error ?? new Error('IndexedDB could not be opened'));
      };
    });
    return dbp;
  };

  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`ink-kv:${name}`) : null;
  if (channel) {
    channel.onmessage = (e: MessageEvent) => {
      const changed = e.data as unknown;
      if (changed && typeof changed === 'object') out.emit(changed as Record<string, unknown>);
    };
  }
  const tell = (changed: Record<string, unknown | undefined>): void => {
    out.emit(changed);
    try {
      channel?.postMessage(changed);
    } catch {
      // A value that cannot be cloned still reaches this tab.
    }
  };

  return {
    async get(keys) {
      const db = await open();
      const tx = db.transaction(STORE, 'readonly');
      const st = tx.objectStore(STORE);
      const res: Record<string, unknown> = {};
      for (const k of keys) {
        const r = st.get(k);
        r.onsuccess = () => {
          if (r.result !== undefined) res[k] = r.result;
        };
      }
      await done(tx);
      return res;
    },
    async set(items) {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      for (const [k, v] of Object.entries(items)) st.put(v, k);
      await done(tx);
      tell(items);
    },
    async remove(keys) {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const changed: Record<string, undefined> = {};
      for (const k of keys) {
        st.delete(k);
        changed[k] = undefined;
      }
      await done(tx);
      tell(changed);
    },
    async keys(prefix) {
      const db = await open();
      const tx = db.transaction(STORE, 'readonly');
      const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined;
      const r = tx.objectStore(STORE).getAllKeys(range);
      await done(tx);
      return (r.result as IDBValidKey[]).filter((k): k is string => typeof k === 'string').sort();
    },
    onChange: (cb) => out.add(cb),
    close() {
      closed = true;
      channel?.close();
      out.clear();
      void dbp?.then((db) => db.close()).catch(() => {});
      dbp = null;
    },
  };
}

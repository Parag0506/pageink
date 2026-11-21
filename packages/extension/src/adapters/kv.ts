/**
 * KV over extension storage.local. Works in content scripts, extension pages
 * and the background, with no message passing.
 */
import type { KV } from 'pageink-core/types';

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'> & {
  getKeys?: () => Promise<string[]>;
};
type ChangeFn = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;
type Changed = { addListener(fn: ChangeFn): void; removeListener(fn: ChangeFn): void };

export function storageKV(area: Area, changed?: Changed, areaName = 'local'): KV {
  const kv: KV = {
    get: (keys) => (keys.length ? area.get(keys) : Promise.resolve({})),
    set: (items) => area.set(items),
    remove: (keys) => (keys.length ? area.remove(keys) : Promise.resolve()),
    async keys(prefix) {
      // getKeys avoids reading every value. Older browsers lack it.
      const all = area.getKeys ? await area.getKeys() : Object.keys(await area.get(null));
      return all.filter((k) => k.startsWith(prefix));
    },
  };
  if (changed) {
    kv.onChange = (cb) => {
      const fn = (changes: Record<string, chrome.storage.StorageChange>, name: string) => {
        if (name !== areaName) return;
        const out: Record<string, unknown> = {};
        for (const [k, c] of Object.entries(changes)) out[k] = c.newValue;
        cb(out);
      };
      changed.addListener(fn);
      return () => changed.removeListener(fn);
    };
  }
  return kv;
}

/** KV for this extension's storage.local. */
export const localKV = (api: typeof chrome): KV => storageKV(api.storage.local, api.storage.onChanged);

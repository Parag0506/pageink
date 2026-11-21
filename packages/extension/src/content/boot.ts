/**
 * The first read of a page with ink. The background registers boot.js ahead of loader.js on hosts
 * that have ink, at document start, so this read is on its way while the browser compiles and
 * runs the viewer. It holds only what the read needs: the page's identity and the storage keys.
 */
import { pageIdentity } from 'pageink-core/anchor';
import { CFG_KEY, idxKey, pageKeyOf } from 'pageink-core/hash';
import type { PageIdentity } from 'pageink-core/types';
import { pickApi } from '../api';
import { world } from './modules';

/**
 * Storage keys the viewer's first load reads for a page: the site index of every host the page
 * can be on, the record slot its key maps to, and the settings. Keys storage does not hold come
 * back as undefined, so a read answered from these items never goes to storage for them again.
 */
export function bootKeys(id: PageIdentity): string[] {
  const hosts = [...new Set([id.host, ...id.hosts].filter(Boolean))];
  return [...hosts.map(idxKey), pageKeyOf(id.key), CFG_KEY];
}

/**
 * Starts the read of everything the viewer's first load needs, beside the stub's read of the site
 * index, so the viewer starts after one storage trip, with no second one for a host's other index
 * or the settings. The stub uses it only when the index points at the same slot. Without it (an
 * injected viewer, a browser that registers nothing) the stub and the viewer read as they need.
 */
export function boot(): void {
  if (window !== window.top || world().early) return;
  // The bench sees that the registered viewer ran. Release builds leave this out.
  if (__INK_BENCH__) performance.mark('ink:boot');
  const id = pageIdentity(location.href);
  const keys = bootKeys(id);
  const items = pickApi()
    .storage.local.get(keys)
    .then((r) => {
      const out: Record<string, unknown> = { ...r };
      for (const k of keys) if (!(k in out)) out[k] = undefined;
      return out;
    });
  world().early = { key: pageKeyOf(id.key), items };
}

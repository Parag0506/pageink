/**
 * Small settings helpers for the popup, which stays free of the store so it
 * opens fast. The store fills in defaults for any field left out.
 */
import { CFG_KEY } from 'pageink-core/hash';
import type { InkConfig } from 'pageink-core/types';

export type StoredCfg = Partial<InkConfig>;

export function hostOf(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:' ? u.hostname : '';
  } catch {
    return '';
  }
}

/** Off list with the host added or removed. */
export function withSite(off: string[] | undefined, host: string, on: boolean): string[] {
  const rest = (off ?? []).filter((h) => h !== host);
  return on ? rest : [...rest, host];
}

/**
 * The stored settings, read raw. The store checks every field; the popup reads only `off`, so a
 * value that is not an object, or an off list that is not a list of names, counts as absent.
 */
export async function readCfg(area: Pick<chrome.storage.StorageArea, 'get'>): Promise<StoredCfg> {
  const v = (await area.get(CFG_KEY))[CFG_KEY];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const cfg = { ...(v as StoredCfg) };
  if (!Array.isArray(cfg.off) || !cfg.off.every((h) => typeof h === 'string')) delete cfg.off;
  return cfg;
}

export async function setSite(
  area: chrome.storage.StorageArea,
  host: string,
  on: boolean,
): Promise<StoredCfg> {
  const cur = await readCfg(area);
  const next = { ...cur, off: withSite(cur.off, host, on) };
  await area.set({ [CFG_KEY]: next });
  return next;
}

/**
 * Settings back to their defaults. The install id and the connected folder stay: they are
 * not settings. Notes are in other keys and are never touched.
 */
export async function resetCfg(area: Pick<chrome.storage.StorageArea, 'get' | 'set'>): Promise<StoredCfg> {
  const cur = await readCfg(area);
  const next: StoredCfg = { v: 1 };
  if (typeof cur.device === 'string') next.device = cur.device;
  if (typeof cur.folder === 'string') next.folder = cur.folder;
  await area.set({ [CFG_KEY]: next });
  return next;
}

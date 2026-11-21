import type { KV } from '../types';

/**
 * A KV that reads through to `base` but keeps every write in memory. Used in private
 * windows: ink works and earlier ink still shows, but nothing reaches storage, so nothing
 * is saved or synced, and no setting records which sites were visited.
 */
export function memoryOverKV(base: KV): KV {
  /** Values written here. undefined marks a key removed here. */
  const mine = new Map<string, unknown>();
  const subs = new Set<(c: Record<string, unknown | undefined>) => void>();
  const emit = (c: Record<string, unknown | undefined>): void => {
    if (!Object.keys(c).length) return;
    // After the write, as storage does.
    queueMicrotask(() => {
      for (const f of [...subs]) f(structuredClone(c));
    });
  };
  const kv: KV = {
    async get(keys) {
      const rest = keys.filter((k) => !mine.has(k));
      const out = rest.length ? await base.get(rest) : {};
      for (const k of keys) {
        if (!mine.has(k)) continue;
        const v = mine.get(k);
        if (v !== undefined) out[k] = structuredClone(v);
      }
      return out;
    },
    async set(items) {
      const copy = structuredClone(items);
      for (const [k, v] of Object.entries(copy)) mine.set(k, v);
      emit(copy);
    },
    async remove(keys) {
      const c: Record<string, undefined> = {};
      for (const k of keys) {
        mine.set(k, undefined);
        c[k] = undefined;
      }
      emit(c);
    },
    async keys(prefix) {
      const all = new Set(await base.keys(prefix));
      for (const [k, v] of mine) {
        if (!k.startsWith(prefix)) continue;
        if (v === undefined) all.delete(k);
        else all.add(k);
      }
      return [...all].sort();
    },
    onChange(cb) {
      subs.add(cb);
      // Changes from other windows still arrive, except for keys this window holds itself.
      const off = base.onChange?.((c) => {
        const out: Record<string, unknown | undefined> = {};
        for (const [k, v] of Object.entries(c)) if (!mine.has(k)) out[k] = v;
        if (Object.keys(out).length) cb(out);
      });
      return () => {
        subs.delete(cb);
        off?.();
      };
    },
  };
  return kv;
}

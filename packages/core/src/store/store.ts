import { CFG_KEY, hashKey, idxKey, newId } from '../hash';
import type { CreateStore, InkConfig, KV, PageIdentity, PageRecord, PageSummary, Store } from '../types';
import { addresses, identityUrls, indexTargets } from './identity';
import { canon, merge } from './merge';
import { showsInk } from './patch';
import { cleanConfig, cleanRecord, isSlot } from './validate';

export { cleanConfig };

export const DEFAULT_CONFIG: Omit<InkConfig, 'device'> = {
  v: 1,
  off: [],
  modifier: 'Alt',
  penReady: false,
  barHideMs: 4000,
  penW: 2,
  hiW: 14,
  theme: 'auto',
  rememberDraw: true,
  drawOn: [],
  penNeedsToggle: false,
  thumbs: true,
  privateKeep: false,
};

/**
 * Record slots are named by a short hash of the page key, which is not collision proof.
 * When a slot holds another page, the record goes to the next overflow slot `<hash>.<n>`.
 * Every read checks the key, so a page never sees a record that is not its own.
 */
export const SLOTS = 8;

/** Storage keys of the main slot and the overflow slots for a key. */
export function slotKeys(key: string): string[] {
  const h = hashKey(key);
  return [`p:${h}`, ...Array.from({ length: SLOTS - 1 }, (_, i) => `p:${h}.${i + 1}`)];
}

interface IndexValue {
  v: 1;
  m: Record<string, string>;
}

const isIndex = (v: unknown): v is IndexValue =>
  !!v &&
  typeof v === 'object' &&
  (v as IndexValue).v === 1 &&
  !!(v as IndexValue).m &&
  typeof (v as IndexValue).m === 'object';

/** The slot the index lists for an address hash, when it is a well formed slot name. */
const indexed = (v: unknown, ah: string): string | undefined => {
  if (!isIndex(v) || !Object.hasOwn(v.m, ah)) return undefined;
  const s = v.m[ah];
  return isSlot(s) ? s : undefined;
};

const isEmpty = (r: PageRecord) => r.notes.length === 0 && r.deleted.length === 0;

/**
 * True when the record belongs to one of these addresses: its key is one of them, or it
 * lists one of them, which is how the index came to point at it.
 */
const belongs = (rec: PageRecord, addrs: string[]): boolean =>
  addrs.includes(rec.key) || rec.urls.some((u) => addrs.includes(u));

/**
 * The one way content code accepts a raw record read from storage: checked deeply, cleaned,
 * and only when it belongs to this page. Null otherwise.
 */
export function acceptRecord(raw: unknown, id: PageIdentity): PageRecord | null {
  if (raw === undefined || raw === null) return null;
  const c = cleanRecord(raw);
  if (!c.rec) return null;
  return belongs(c.rec, [id.key, ...id.aliases]) ? c.rec : null;
}

/** The key a stored value says it belongs to, readable or not. */
const ownerOf = (v: unknown): string | undefined =>
  v && typeof v === 'object' && typeof (v as PageRecord).key === 'string' ? (v as PageRecord).key : undefined;

/** True when `stored` already holds everything in `mine`. */
function covers(stored: unknown, mine: PageRecord): boolean {
  const c = cleanRecord(stored);
  if (!c.rec || c.rec.key !== mine.key) return isEmpty(mine);
  return canon(merge(c.rec, mine)) === canon(merge(c.rec, c.rec));
}

export const createStore: CreateStore = (kv) => storeOver(kv);

/** A save that would overwrite a record this version cannot read. The stored record is kept. */
export class BadRecordError extends Error {
  constructor(
    readonly key: string,
    readonly problem: string,
  ) {
    super(`ink: ${key} cannot be read: ${problem}`);
  }
}

/** The slot was taken by another page between finding it and writing it. */
class SlotTaken extends Error {}

export interface StoreOptions {
  /** Called when a stored record, or a part of one, is ignored because it cannot be read. */
  onBadRecord?(key: string, problem: string): void;
}

/**
 * Storage has no compare and swap, so two tabs can read, merge and write over each other.
 * Each store keeps the last record it wrote per slot. When storage later holds less than
 * that, because another writer raced it, the store merges and writes again. Merge only
 * grows, so the writers settle on the union and no stroke is lost.
 */
export function storeOver(kv: KV, opts: StoreOptions = {}) {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };

  const mine = new Map<string, PageRecord>();
  // Each problem is told once per slot.
  const told = new Set<string>();
  const tell = (sk: string, problem: string) => {
    const k = `${sk}|${problem}`;
    if (told.has(k)) return;
    told.add(k);
    opts.onBadRecord?.(sk, problem);
  };

  /** A clean record from a stored value, or null. Bad parts are reported once. */
  function asRecord(sk: string, v: unknown): PageRecord | null {
    if (v === undefined) return null;
    const c = cleanRecord(v);
    if (c.problem) tell(sk, c.problem);
    for (const d of c.dropped) tell(sk, d);
    return c.rec ?? null;
  }

  interface Slot {
    sk: string;
    rec: PageRecord | null;
  }

  /**
   * The slot that holds this key, or the first free one. Overflow slots are read only when the
   * main slot holds something else, so the usual case is one read. `known` holds values already read.
   */
  async function findSlot(key: string, known: Record<string, unknown> = {}): Promise<Slot | null> {
    const [main, ...more] = slotKeys(key) as [string, ...string[]];
    const v = main in known ? known[main] : (await kv.get([main]))[main];
    if (v === undefined) return { sk: main, rec: null };
    // A main slot we cannot read counts as ours unless it names another key, so a record
    // from a newer version is never split from the notes written here.
    if (ownerOf(v) === key || ownerOf(v) === undefined) return { sk: main, rec: asRecord(main, v) };
    const got = await kv.get(more);
    let free: string | null = null;
    for (const sk of more) {
      if (got[sk] === undefined) free ??= sk;
      else if (ownerOf(got[sk]) === key) return { sk, rec: asRecord(sk, got[sk]) };
    }
    return free ? { sk: free, rec: null } : null;
  }

  async function writeMerged(sk: string, rec: PageRecord): Promise<PageRecord> {
    let want = rec;
    for (let i = 0; i < 4; i++) {
      const cur = (await kv.get([sk]))[sk];
      let stored: PageRecord | null = null;
      if (cur !== undefined) {
        const c = cleanRecord(cur);
        // A newer version, a damaged write or a note that cannot be read: never replace it.
        const bad = c.problem ?? c.dropped[0];
        if (bad || !c.rec) {
          tell(sk, bad ?? 'unreadable');
          throw new BadRecordError(sk, bad ?? 'unreadable');
        }
        if (c.rec.key !== want.key) throw new SlotTaken();
        stored = c.rec;
      }
      const m = stored ? merge(stored, want) : merge(want, want);
      mine.set(sk, m);
      if (isEmpty(m)) {
        if (cur !== undefined) await kv.remove([sk]);
      } else if (!stored || canon(m) !== canon(stored)) {
        await kv.set({ [sk]: m });
      }
      // Read back once. Without change events this is the only guard against a racing writer.
      const back = (await kv.get([sk]))[sk];
      if (covers(back, m)) return m;
      want = m;
    }
    return want;
  }

  /**
   * A main slot that was emptied while overflow slots are in use takes the first of them,
   * so a lookup that finds the main slot empty can stop there.
   */
  async function compact(sk: string): Promise<void> {
    if (sk.includes('.')) return;
    const more = Array.from({ length: SLOTS - 1 }, (_, i) => `${sk}.${i + 1}`);
    const got = await kv.get(more);
    const next = more.find((k) => got[k] !== undefined);
    if (!next) return;
    const rec = asRecord(next, got[next]);
    if (!rec) return;
    await kv.set({ [sk]: got[next] });
    await kv.remove([next]);
    mine.delete(next);
    mine.set(sk, rec);
    await ensureIndex(rec, sk.slice(2));
  }

  async function ensureIndex(rec: PageRecord, slot: string, gone = false): Promise<void> {
    const { hosts, addrs } = indexTargets(rec);
    const keep = !gone && rec.notes.some(showsInk);
    const keys = [...new Set(hosts.map(idxKey))];
    if (keys.length === 0) return;
    const cur = await kv.get(keys);
    const set: Record<string, unknown> = {};
    const drop: string[] = [];
    for (const k of keys) {
      const had = isIndex(cur[k]) ? cur[k] : undefined;
      const m: Record<string, string> = {};
      for (const [a, s] of Object.entries(had?.m ?? {})) if (isSlot(s) && a !== '__proto__') m[a] = s;
      if (keep) {
        const own = hashKey(rec.key);
        for (const a of addrs) {
          const ah = hashKey(a);
          const had = m[ah];
          // Two records can claim one address hash: an alias, or two keys with the same hash.
          // A record claims its own key's hash over an alias of another record; otherwise the
          // first claim stays. Two writers then agree, and the loser is found by its key.
          if (had === undefined || had === slot || (ah === own && had.split('.')[0] !== ah)) m[ah] = slot;
        }
      } else {
        for (const a of Object.keys(m)) if (m[a] === slot) delete m[a];
      }
      const empty = Object.keys(m).length === 0;
      if (empty) {
        if (cur[k] !== undefined) drop.push(k);
      } else if (!had || canon(had.m) !== canon(m)) {
        set[k] = { v: 1, m } satisfies IndexValue;
      }
    }
    if (Object.keys(set).length) await kv.set(set);
    if (drop.length) await kv.remove(drop);
  }

  kv.onChange?.((changed) => {
    for (const [k, v] of Object.entries(changed)) {
      if (k.startsWith('p:')) {
        const m = mine.get(k);
        if (!m) continue;
        if (v === undefined) {
          // Removed on purpose by another context. Respect it.
          mine.delete(k);
          continue;
        }
        if (!covers(v, m)) {
          run(async () => {
            const cur = mine.get(k);
            if (!cur) return;
            const w = await writeMerged(k, cur);
            await ensureIndex(w, k.slice(2));
          }).catch(() => {
            mine.delete(k);
          });
        }
      } else if (k.startsWith('idx:')) {
        for (const [sk, rec] of mine) {
          if (!indexTargets(rec).hosts.some((h) => idxKey(h) === k)) continue;
          run(async () => {
            const cur = mine.get(sk);
            if (cur) await ensureIndex(cur, sk.slice(2));
          }).catch(() => {});
        }
      }
    }
  });

  async function load(id: PageIdentity): Promise<PageRecord | null> {
    const hosts = [...new Set([id.host, ...id.hosts].filter(Boolean))];
    // The page's own main slot is read with the index, so the usual case costs one round trip.
    const own = slotKeys(id.key)[0]!;
    const first = await kv.get([...hosts.map(idxKey), own]);
    for (const addr of [id.key, ...id.aliases]) {
      const ah = hashKey(addr);
      const sks = new Set<string>();
      for (const h of hosts) {
        const s = indexed(first[idxKey(h)], ah);
        if (s) sks.add(`p:${s}`);
      }
      for (const sk of sks) {
        const v = sk in first ? first[sk] : (await kv.get([sk]))[sk];
        const r = asRecord(sk, v);
        // The index is keyed by a short hash, so what it points at must list this address.
        if (r && belongs(r, [addr])) return r;
      }
      const found = await findSlot(addr, first);
      if (found?.rec) return found.rec;
    }
    return null;
  }

  async function save(rec: PageRecord, id: PageIdentity): Promise<PageRecord> {
    return run(async () => {
      const withId: PageRecord = { ...rec, urls: [...rec.urls, ...identityUrls(id)] };
      for (let i = 0; i < SLOTS; i++) {
        const slot = await findSlot(rec.key);
        if (!slot) throw new Error(`ink: no free storage slot for ${rec.key}`);
        const prev = mine.get(slot.sk);
        const base = prev?.key === rec.key ? merge(prev, withId) : withId;
        try {
          const out = await writeMerged(slot.sk, base);
          await ensureIndex(out, slot.sk.slice(2));
          if (isEmpty(out)) await compact(slot.sk);
          return out;
        } catch (e) {
          if (!(e instanceof SlotTaken)) throw e;
          mine.delete(slot.sk);
        }
      }
      throw new Error(`ink: no free storage slot for ${rec.key}`);
    });
  }

  async function remove(key: string): Promise<void> {
    return run(async () => {
      const slot = await findSlot(key);
      if (!slot?.rec) return;
      mine.delete(slot.sk);
      await kv.remove([slot.sk]);
      await ensureIndex(slot.rec, slot.sk.slice(2), true);
      await compact(slot.sk);
    });
  }

  async function list(): Promise<PageSummary[]> {
    const keys = await kv.keys('p:');
    const got = await kv.get(keys);
    const out = new Map<string, PageSummary>();
    for (const k of keys) {
      const r = asRecord(k, got[k]);
      if (!r || out.has(r.key)) continue;
      out.set(r.key, {
        key: r.key,
        hash: k.slice(2),
        title: r.title,
        url: addresses(r)[0] ?? r.key,
        updatedAt: r.updatedAt,
        // A note left with no strokes after a merge shows nothing, so it is not counted.
        notes: r.notes.filter(showsInk).length,
      });
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1));
  }

  /** A device id this store made, until storage holds one. */
  let made: string | undefined;

  async function readConfig(): Promise<InkConfig> {
    const stored = cleanConfig((await kv.get([CFG_KEY]))[CFG_KEY]);
    const cfg: InkConfig = { ...DEFAULT_CONFIG, ...stored, v: 1, device: stored.device || '' };
    if (!cfg.device) {
      made ??= newId();
      const device = made;
      cfg.device = device;
      // Stored behind the caller's back: a page that only shows ink does not wait a storage
      // round trip for an id it uses only when it writes. The write is queued, so every later
      // call of this store runs after it, and it adds the id only to what is stored by then.
      // Only the id is added. Defaults stay out of storage, so a later default still applies.
      void run(async () => {
        const now = cleanConfig((await kv.get([CFG_KEY]))[CFG_KEY]);
        if (!now.device) await kv.set({ [CFG_KEY]: { ...now, v: 1, device } });
      }).catch(() => {});
    }
    return cfg;
  }

  const store: Store & { idle(): Promise<void> } = {
    load,
    save,
    watch(key: string, cb: (rec: PageRecord | null) => void) {
      const [main] = slotKeys(key) as [string];
      let at: string | undefined;
      return (
        kv.onChange?.((changed) => {
          for (const [k, v] of Object.entries(changed)) {
            if (k !== main && !k.startsWith(`${main}.`)) continue;
            if (v === undefined) {
              if (k === at) cb(null);
              continue;
            }
            const r = asRecord(k, v);
            // Another page that shares the hash is none of this page's business.
            if (r?.key !== key) continue;
            at = k;
            cb(r);
          }
        }) ?? (() => {})
      );
    },
    get: async (key: string) => (await findSlot(key))?.rec ?? null,
    remove,
    list,
    config: () => run(readConfig),
    /**
     * Store only the fields given, over what is stored. Defaults stay out of storage, so a later
     * default still applies; config() fills them in on read. A field set to undefined is removed.
     */
    setConfig: (patch: Partial<InkConfig>) =>
      run(async () => {
        const device = (await readConfig()).device;
        const stored: Record<string, unknown> = { ...cleanConfig((await kv.get([CFG_KEY]))[CFG_KEY]) };
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'v' || k === 'device') continue;
          if (v === undefined) delete stored[k];
          else stored[k] = v;
        }
        await kv.set({ [CFG_KEY]: { ...stored, v: 1, device } });
        return readConfig();
      }),
    /** Resolves when this store has no queued work. For tests and shutdown. */
    async idle() {
      let t: Promise<unknown>;
      do {
        t = tail;
        await t;
        await new Promise((r) => setTimeout(r, 0));
      } while (t !== tail);
    },
  };
  return store;
}

/**
 * Deep checks for records that come from storage, a synced folder or an archive.
 * Any of these may have been edited by hand or written by a hostile tool, so every
 * field is checked and copied into a fresh object. Unknown fields are left behind.
 * A bad note is dropped alone; a record whose own fields are bad is refused whole.
 * The checks are small combinators because this code is in the view chunk on every page with ink.
 */
import type { InkConfig, Note, PageRecord, Tombstone } from '../types';

/** Generous caps. Real records stay far below them. */
export const LIMITS = {
  text: 4096,
  urls: 256,
  title: 2000,
  notes: 5000,
  strokes: 5000,
  /** Points per stroke. pts holds three numbers per point. */
  points: 20000,
  d: 400_000,
  deleted: 200_000,
  /** Thumbnail data address, in characters. */
  thumb: 8192,
  /** Largest absolute coordinate or size. */
  coord: 1e7,
} as const;

/** Ids are short and plain. `~` joins a note id and a time in derived ids (FORMAT "Merge"). */
export const ID = /^[\w.:~-]{1,160}$/;
const COLOR = /^((ink|hi)-\d\d?|#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8}))$/i;
/** Only M L Q C Z commands, in either case, and numbers. */
const PATH = /^([MLQCZ]|[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?|[\s,])*$/i;
const THUMB = /^data:image\/(png|jpeg|webp);base64,[\w+/]+={0,2}$/;
const SLOT = /^[\da-z]{1,16}(\.[1-9]\d?)?$/;

/**
 * A check returns the clean value or throws with the path of the field that failed. With an empty
 * path no field names are built: a check runs that way first, since a record holds thousands of
 * fields, and again with names only to word the failure.
 */
type Check<T = unknown> = (v: unknown, at: string) => T;
const sub = (at: string, k: string | number): string => (at ? `${at}.${k}` : '');

const no = (at: string): never => {
  throw new TypeError(at);
};
const is =
  <T>(ok: (v: unknown) => boolean): Check<T> =>
  (v, at) =>
    ok(v) ? (v as T) : no(at);

const str = (max: number = LIMITS.text, re?: RegExp) =>
  is<string>((v) => typeof v === 'string' && v.length <= max && (!re || re.test(v)));
const num = (min: number = -LIMITS.coord, max: number = LIMITS.coord) =>
  is<number>((v) => typeof v === 'number' && v >= min && v <= max);
const oneOf = (...xs: string[]) => is<string>((v) => xs.includes(v as string));
/** Epoch ms, up to the year 2400. */
const time = num(0, 136e11);
const id = str(160, ID);
const color = str(12, COLOR);

const list =
  <T>(each: Check<T>, max: number): Check<T[]> =>
  (v, at) =>
    Array.isArray(v) && v.length <= max ? v.map((x, i) => each(x, sub(at, i))) : no(at);

/** An object with these fields. Keys ending in `?` may be absent. Others are left behind. */
const obj =
  <T>(shape: Record<string, Check>): Check<T> =>
  (v, at) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return no(at);
    const out: Record<string, unknown> = {};
    for (const [k, check] of Object.entries(shape)) {
      const name = k.replace('?', '');
      const x = (v as Record<string, unknown>)[name];
      const opt = k.endsWith('?');
      if (x === undefined && opt) continue;
      const c = check(x, sub(at, name));
      if (c !== undefined || !opt) out[name] = c;
    }
    return out as T;
  };

const path = obj({ 'id?': str(), css: str(8192), xpath: str(8192) });
/**
 * The same check as a list of numbers, in one loop: a record holds thousands of them, and the
 * viewer checks the record before the page's first paint with ink, so no field name is built
 * for a number unless it fails.
 */
const pts: Check<number[]> = (v, at) => {
  if (!Array.isArray(v) || v.length > LIMITS.points * 3) return no(at);
  const a = new Array<number>(v.length);
  for (let i = 0; i < v.length; i++) {
    const x: unknown = v[i];
    if (typeof x !== 'number' || !(x >= -1e8 && x <= 1e8)) return no(sub(at, i));
    a[i] = x;
  }
  return a.length % 3 || !a.every(Number.isInteger) ? no(at) : a;
};

const note = obj<Note>({
  id,
  createdAt: time,
  updatedAt: time,
  device: str(128),
  kind: oneOf('ink', 'textmark'),
  anchor: obj({
    type: oneOf('text', 'block', 'media', 'viewport'),
    quote: obj({ exact: str(), prefix: str(), suffix: str() }),
    path,
    pos: obj({ start: num(0, 1e9), end: num(0, 1e9) }),
    hash: str(128),
    place: oneOf('on', 'left', 'right', 'above', 'below'),
    'media?': obj({ src: str(), alt: str(), caption: str() }),
    'scroller?': path,
    'frame?': obj({ url: str(), path }),
    'frac?': obj({ x: num(-10, 10), y: num(-10, 10) }),
    'link?': str(),
  }),
  frame: obj({ w: num(0), h: num(0), fontPx: num(0), viewportW: num(0) }),
  strokes: list(
    obj({
      id,
      t: time,
      tool: oneOf('pen', 'hi'),
      color,
      w: num(0, 1000),
      pts,
      d: str(LIMITS.d, PATH),
    }),
    LIMITS.strokes,
  ),
  'mark?': obj({ style: oneOf('highlight', 'underline', 'strike'), color }),
  // A thumbnail that is not a small picture is left out below. The note stays.
  'thumb?': (v) => (typeof v === 'string' && v.length <= LIMITS.thumb && THUMB.test(v) ? v : undefined),
});

const head = obj<Omit<PageRecord, 'notes' | 'deleted'>>({
  key: str(),
  urls: list(str(), LIMITS.urls),
  updatedAt: time,
  'snapshot?': obj({ ref: str(), t: time }),
});
const tomb = obj<Tombstone>({ id, t: time });

export interface Cleaned {
  /** The clean record. Absent when the record as a whole cannot be read. */
  rec?: PageRecord;
  /** Why the whole record was refused. */
  problem?: string;
  /** One line per part that was left out, such as a bad note. */
  dropped: string[];
}

const why = (e: unknown) => (e instanceof TypeError ? `bad ${e.message}` : String(e));

/**
 * Records this check built itself, whole. They live only in this script's memory, which no
 * page can reach, and the code never changes a record in place, so passing one in again (the
 * viewer's first read takes the copy its loader already checked) skips a second check.
 */
const checked = new WeakSet<object>();

/** Check and copy a record. Bad notes and bad tombstones are left out and listed in `dropped`. */
export function cleanRecord(v: unknown): Cleaned {
  if (v && typeof v === 'object' && checked.has(v)) return { rec: v as PageRecord, dropped: [] };
  const dropped: string[] = [];
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const problem =
    o !== v || Array.isArray(v)
      ? 'not an object'
      : o.v !== 1
        ? `unsupported version ${String(o.v).slice(0, 20)}`
        : !o.key || !Array.isArray(o.notes) || !Array.isArray(o.deleted)
          ? 'missing fields'
          : o.notes.length > LIMITS.notes || o.deleted.length > LIMITS.deleted
            ? 'too large'
            : '';
  if (problem) return { problem, dropped };
  const each = <T>(xs: unknown[], check: Check<T>, name: string): T[] =>
    xs.flatMap((x, i) => {
      try {
        return [check(x, '')];
      } catch {
        // Checked again with field names, only to say which field failed.
        try {
          check(x, `${name} ${i}`);
          dropped.push(`bad ${name} ${i}`);
        } catch (e) {
          dropped.push(why(e));
        }
        return [];
      }
    });
  try {
    const h = head(o, 'record');
    const rec: PageRecord = {
      ...h,
      v: 1,
      title: typeof o.title === 'string' ? o.title.slice(0, LIMITS.title) : '',
      notes: each(o.notes as unknown[], note, 'note'),
      deleted: each(o.deleted as unknown[], tomb, 'deleted'),
    };
    if (!dropped.length) checked.add(rec);
    return { rec, dropped };
  } catch (e) {
    return { problem: why(e), dropped };
  }
}

/** Shape problem of a record, or null. Bad notes count as a problem here. */
export function recordProblem(v: unknown): string | null {
  const c = cleanRecord(v);
  return c.problem ?? c.dropped[0] ?? null;
}

/** JSON.parse that drops keys able to reach a prototype when the result is copied. */
export const safeParse = (text: string): unknown =>
  JSON.parse(text, (k, v) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));

/** A storage slot name: the hash of a key, with `.<n>` for an overflow slot. */
export const isSlot = (s: unknown): s is string => typeof s === 'string' && SLOT.test(s);

const bool = is<boolean>((v) => typeof v === 'boolean');
const hosts = list(str(253), 10_000);
const CONFIG: Record<string, Check> = {
  device: str(64, /^[\w-]+$/),
  off: hosts,
  modifier: oneOf('Alt', 'Control', 'Meta', 'none'),
  penReady: bool,
  hinted: bool,
  barHideMs: num(0, 36e5),
  penW: num(0.1, 100),
  hiW: num(0.1, 200),
  theme: oneOf('auto', 'light', 'dark'),
  folder: str(256),
  lastSync: time,
  pdf: bool,
  rememberDraw: bool,
  drawOn: hosts,
  penNeedsToggle: bool,
  thumbs: bool,
  privateKeep: bool,
};

/** Settings from storage with every field checked. A field that fails is left out alone. */
export function cleanConfig(v: unknown): Partial<InkConfig> {
  const out: Record<string, unknown> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, check] of Object.entries(CONFIG)) {
    try {
      out[k] = check((v as Record<string, unknown>)[k], k);
    } catch {
      // Missing or wrong: the default applies.
    }
  }
  return out as Partial<InkConfig>;
}

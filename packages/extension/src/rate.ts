/**
 * The one quiet ask for a rating. Once someone really uses the extension, the popup shows one
 * line that says where they can rate it. It shows until they choose "Rate PageInk" or "No
 * thanks", and then never again. Nothing is offered for a rating and nothing is sent anywhere:
 * the state below lives in the extension's local storage, under its own key, and the link only
 * opens the store page in a new tab.
 *
 * The rule, from data the extension already keeps:
 * - ink on at least RATE_PAGES different pages, so it is in use beyond a first try, and
 * - at least RATE_DAYS days since the first use, so the reader came back on another day.
 *
 * "First use" is the earlier of the time this browser first saw a page with ink (`first`) and
 * the oldest last-change time among the pages with ink. A page changes no earlier than its first
 * note, so neither can be earlier than the real first use: the rule may wait longer than it
 * must, never shorter.
 */
export const RATE_KEY = 'rate';

/** Pages with ink before the line shows. */
export const RATE_PAGES = 5;
/** Days since the first use before the line shows. */
export const RATE_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

export interface RateState {
  /** Epoch ms when this browser first saw a page with ink. */
  first?: number;
  /** The reader chose "Rate PageInk" or "No thanks". The line never shows again. */
  done?: 'rated' | 'declined';
}

export interface RateInput {
  /** Pages with at least one note. */
  pages: number;
  /** Oldest last-change time, epoch ms, among the pages with ink. */
  oldest?: number;
  st: RateState;
  now: number;
}

const known = (t: number | undefined): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0;

/** The earliest time the extension can show it was in use, or undefined when none. */
export function firstUse(st: RateState, oldest?: number): number | undefined {
  const ts = [st.first, oldest].filter(known);
  return ts.length ? Math.min(...ts) : undefined;
}

/** True when the line may show. Pure. */
export function rateDue(i: RateInput): boolean {
  if (i.st.done) return false;
  if (i.pages < RATE_PAGES) return false;
  const first = firstUse(i.st, i.oldest);
  // A first use in the future means a clock moved. Wait until it makes sense again.
  if (first === undefined || first > i.now) return false;
  return i.now - first >= RATE_DAYS * DAY;
}

/** Pages with ink and the oldest last-change time among them, from the store's page list. */
export function usage(list: readonly { notes: number; updatedAt: number }[]): {
  pages: number;
  oldest?: number;
} {
  const inked = list.filter((p) => p.notes > 0);
  const times = inked.map((p) => p.updatedAt).filter(known);
  return { pages: inked.length, ...(times.length ? { oldest: Math.min(...times) } : {}) };
}

type Area = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export async function readRate(area: Area): Promise<RateState> {
  const v = (await area.get(RATE_KEY))[RATE_KEY] as Record<string, unknown> | undefined;
  if (!v || typeof v !== 'object') return {};
  const out: RateState = {};
  if (known(v.first as number)) out.first = v.first as number;
  if (v.done === 'rated' || v.done === 'declined') out.done = v.done;
  return out;
}

/** Start the clock the first time a page with ink is seen. Returns the state as stored. */
export async function noteFirst(area: Area, now = Date.now()): Promise<RateState> {
  const st = await readRate(area);
  if (st.first !== undefined) return st;
  const next = { ...st, first: now };
  await area.set({ [RATE_KEY]: next });
  return next;
}

/** Record the reader's answer. After this the line never shows again. */
export async function markRate(area: Area, done: 'rated' | 'declined'): Promise<void> {
  const st = await readRate(area);
  await area.set({ [RATE_KEY]: { ...st, done } });
}

/**
 * Quote search over the document text (DESIGN 7.4 steps 2 and 3). Pure string code.
 */
import approxSearch from 'approx-string-match';
import type { Quote } from '../types';

export interface Match {
  start: number;
  end: number;
  /** Combined score from 0 to 1. */
  score: number;
  /** Similarity of the quote itself, 0 to 1. */
  quote: number;
  /** Similarity of prefix and suffix, 0 to 1. 1 when there is no context to compare. */
  context: number;
  /** Similarity of the better kept side of the context. Set for the best match only. */
  side?: number;
}

/**
 * The similarity bar. A wrong place is worse than the tray, so a fuzzy match must
 * keep most of the quote and most of its surroundings.
 */
export const BAR = {
  /** Fewest characters of the quote that must survive, as a share of its length. */
  quote: 0.8,
  /** Lowest combined score: 0.6 quote plus 0.4 context. */
  combined: 0.78,
  /** Lowest context share for quotes too short to be unique by themselves. */
  shortContext: 0.6,
  /** Quotes shorter than this need context support. */
  shortLen: 24,
  /**
   * Repeats and near repeats (templated lists, feeds) must be told apart. Unless the context is
   * this close to intact, the best match must beat the runner-up elsewhere by the margin below.
   */
  intact: 0.9,
  /**
   * A side of the context counts as kept when at most about two characters in 32 changed
   * (a renumbered footnote, a changed dash). Swapping one word changes more than that.
   */
  kept: 0.93,
  /** Context lead the best exact repeat needs over the next one. */
  exactMargin: 0.1,
  /**
   * Between twins, the one nearest the old text position wins only when it is this many times
   * nearer than the next one. Text added or removed above shifts every position.
   */
  twinRatio: 0.25,
  /** Combined score lead the best fuzzy match needs over the best one at another place. */
  fuzzyMargin: 0.05,
};

/** Levenshtein distance, bounded work for the short strings used here. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Similarity of two strings from 0 to 1. */
export function similarity(a: string, b: string): number {
  const n = Math.max(a.length, b.length);
  return n === 0 ? 1 : 1 - editDistance(a, b) / n;
}

/**
 * Context similarity around [start, end). Compares the saved prefix with the text
 * just before and the saved suffix with the text just after.
 */
export function contextScore(text: string, start: number, end: number, q: Quote): number {
  // Weighted by length, so a one-character suffix at the end of the page cannot outvote a full prefix.
  let total = 0;
  let n = 0;
  if (q.prefix) {
    const before = text.slice(Math.max(0, start - q.prefix.length), start);
    total += (before === q.prefix ? 1 : similarity(before, q.prefix)) * q.prefix.length;
    n += q.prefix.length;
  }
  if (q.suffix) {
    const after = text.slice(end, end + q.suffix.length);
    total += (after === q.suffix ? 1 : similarity(after, q.suffix)) * q.suffix.length;
    n += q.suffix.length;
  }
  return n === 0 ? 1 : total / n;
}

/**
 * Similarity of the better kept side of the context: the prefix or the suffix, whichever
 * changed less. 1 when there is no context to compare.
 */
export function bestSide(text: string, start: number, end: number, q: Quote): number {
  let best = -1;
  if (q.prefix) {
    const before = text.slice(Math.max(0, start - q.prefix.length), start);
    best = Math.max(best, before === q.prefix ? 1 : similarity(before, q.prefix));
  }
  if (q.suffix && best < 1) {
    const after = text.slice(end, end + q.suffix.length);
    best = Math.max(best, after === q.suffix ? 1 : similarity(after, q.suffix));
  }
  return best < 0 ? 1 : best;
}

function posScore(start: number, hint: number | undefined, len: number): number {
  if (hint === undefined || len <= 0) return 0.5;
  return 1 - Math.min(1, Math.abs(start - hint) / len);
}

/**
 * Every exact occurrence of the quote between from and to, best first.
 * Context picks between repeats; the text position breaks ties.
 */
export function findExact(
  text: string,
  q: Quote,
  hint?: number,
  from = 0,
  to = text.length,
  limit = 1000,
): Match[] {
  const out: Match[] = [];
  if (!q.exact) return out;
  // indexOf has no end bound, so search a slice when the window is small.
  const whole = from === 0 && to >= text.length;
  const hay = whole ? text : text.slice(from, Math.min(text.length, to + q.exact.length - 1));
  const base = whole ? 0 : from;
  let i = hay.indexOf(q.exact);
  while (i !== -1 && out.length < limit) {
    const start = base + i;
    const end = start + q.exact.length;
    const context = contextScore(text, start, end, q);
    out.push({ start, end, quote: 1, context, score: 0.6 + 0.4 * context });
    i = hay.indexOf(q.exact, i + 1);
  }
  if (out.length >= limit) {
    // A very common quote (a single word) has more repeats than are scored. The one with
    // either side of its context intact must not be among those left out.
    const seen = new Set(out.map((m) => m.start));
    for (const [needle, lead] of [
      [q.prefix + q.exact, q.prefix.length],
      [q.exact + q.suffix, 0],
    ] as const) {
      if (needle.length === q.exact.length) continue;
      for (let k = hay.indexOf(needle); k !== -1; k = hay.indexOf(needle, k + 1)) {
        const start = base + k + lead;
        if (seen.has(start) || start + q.exact.length > to) continue;
        seen.add(start);
        const context = contextScore(text, start, start + q.exact.length, q);
        out.push({ start, end: start + q.exact.length, quote: 1, context, score: 0.6 + 0.4 * context });
      }
    }
  }
  const len = text.length;
  out.sort((a, b) => b.score - a.score || posScore(b.start, hint, len) - posScore(a.start, hint, len));
  for (const m of out.slice(0, 2)) m.side = bestSide(text, m.start, m.end, q);
  return out;
}

/**
 * True when an exact match is safe to use. `next` is the runner-up repeat, when there is one:
 * a repeat that agrees with the context about as well is a coin toss, and a coin toss goes to the tray.
 */
export function acceptExact(m: Match, q: Quote, count: number, next?: Match, hint?: number): boolean {
  const len = q.exact.length;
  const hasContext = !!(q.prefix || q.suffix);
  if (!hasContext) return len >= 8 && count === 1;
  // Twins: the same words with the same context. Only a clearly nearer old position tells them apart.
  if (next && m.context >= BAR.intact && next.context >= m.context - 0.02) {
    if (hint === undefined) return false;
    return Math.abs(m.start - hint) <= BAR.twinRatio * Math.abs(next.start - hint);
  }
  // A repeat that agrees about as well is a coin toss, unless only the best kept one side intact.
  const sideWins = (m.side ?? 1) >= BAR.kept && (next?.side ?? 1) < BAR.kept;
  if (next && m.context < BAR.intact && m.context - next.context < BAR.exactMargin && !sideWins) return false;
  // Real edits leave one side of the words alone. When both sides changed, a look-alike
  // passage (a templated list item, a reworded sentence) is more likely than the same place.
  // A long quote found only once is the same words, so loose agreement around it is enough.
  const longOnly = count === 1 && len >= 32 && m.context >= 0.3;
  if (m.context < BAR.intact && (m.side ?? 1) < BAR.kept && !longOnly) return false;
  if (m.context >= 0.5 || longOnly) return true;
  if (count === 1 && len >= BAR.shortLen && m.context >= 0.25) return true;
  return false;
}

/** True when a fuzzy match clears the bar. */
export function acceptFuzzy(m: Match, q: Quote): boolean {
  if (m.quote < BAR.quote) return false;
  if (m.score < BAR.combined) return false;
  // The words changed, so one side of their context must have stayed nearly as it was.
  if (m.context < BAR.intact && (m.side ?? 1) < BAR.kept) return false;
  const hasContext = !!(q.prefix || q.suffix);
  if (q.exact.length < BAR.shortLen && (!hasContext || m.context < BAR.shortContext)) return false;
  return true;
}

/** Allowed edits for a quote of this length. Short quotes get few, long ones are capped for speed. */
export function maxErrors(len: number): number {
  return Math.min(48, Math.floor(len * (1 - BAR.quote)));
}

/**
 * Approximate search. Tolerates edits inside and around the quote. Returns the
 * best match that clears the bar, or null. Searches near the hint first.
 */
export function findFuzzy(text: string, q: Quote, hint?: number): Match | null {
  const pattern = q.exact;
  if (pattern.length < 4) return null;
  const k = maxErrors(pattern.length);
  if (k < 1) return null;
  const score = (from: number, to: number): Match | null => {
    const hay = text.slice(from, to);
    const found = approxSearch(hay, pattern, k);
    let best: Match | null = null;
    const cands: Match[] = [];
    const seen = new Set<number>();
    for (const f of found) {
      const start = from + f.start;
      if (seen.has(start)) continue;
      seen.add(start);
      const end = from + f.end;
      const qs = 1 - f.errors / pattern.length;
      const context = contextScore(text, start, end, q);
      const s = 0.6 * qs + 0.4 * context;
      const m: Match = { start, end, quote: qs, context, score: s };
      cands.push(m);
      if (
        !best ||
        m.score > best.score + 1e-9 ||
        (Math.abs(m.score - best.score) <= 1e-9 &&
          posScore(m.start, hint, text.length) > posScore(best.start, hint, text.length))
      ) {
        best = m;
      }
    }
    if (!best) return null;
    // A near repeat at another place that scores about as well makes the match a guess.
    const b = best;
    const away = Math.max(4, pattern.length / 2);
    for (const o of cands) {
      if (Math.abs(o.start - b.start) >= away && o.score > b.score - BAR.fuzzyMargin) return null;
    }
    best.side = bestSide(text, best.start, best.end, q);
    return best;
  };
  if (hint !== undefined && text.length > 8000) {
    const w = 4000 + pattern.length;
    const near = score(Math.max(0, hint - w), Math.min(text.length, hint + w));
    if (near && acceptFuzzy(near, q) && near.score >= 0.9) return near;
  }
  const all = score(0, text.length);
  return all && acceptFuzzy(all, q) ? all : null;
}

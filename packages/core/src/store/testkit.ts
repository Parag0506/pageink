/**
 * Builders and a seeded random source for tests. Not exported from the folder index.
 */
import type { Anchor, Note, PageIdentity, PageRecord, Stroke, Tombstone } from '../types';

/** mulberry32: small, fast, good enough for test data. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;

let seq = 0;
export const uid = (p = 'x') => `${p}${(++seq).toString(36).padStart(5, '0')}`;

export function stroke(over: Partial<Stroke> = {}): Stroke {
  const id = over.id ?? uid('s');
  return {
    id,
    t: 1000,
    tool: 'pen',
    color: 'ink-1',
    w: 2,
    pts: [0, 0, 50, 10, 10, 0],
    d: `M0 0L1 ${++seq}`,
    ...over,
  };
}

export function anchor(over: Partial<Anchor> = {}): Anchor {
  return {
    type: 'text',
    quote: { exact: 'quoted words', prefix: 'before ', suffix: ' after' },
    path: { css: 'p:nth-of-type(1)', xpath: '/html/body/p[1]' },
    pos: { start: 0, end: 12 },
    hash: 'h',
    place: 'on',
    ...over,
  };
}

export function note(over: Partial<Note> = {}): Note {
  return {
    id: over.id ?? uid('n'),
    createdAt: 1000,
    updatedAt: 1000,
    device: 'dev',
    kind: 'ink',
    anchor: anchor(),
    frame: { w: 100, h: 20, fontPx: 16, viewportW: 1200 },
    strokes: over.kind === 'textmark' ? [] : [stroke()],
    ...over,
  };
}

export function record(over: Partial<PageRecord> = {}): PageRecord {
  return {
    v: 1,
    key: 'https://example.com/a',
    urls: ['https://example.com/a'],
    title: 'A page',
    updatedAt: 1000,
    notes: [],
    deleted: [],
    ...over,
  };
}

export function identity(over: Partial<PageIdentity> = {}): PageIdentity {
  return {
    key: 'https://example.com/a',
    aliases: [],
    host: 'example.com',
    hosts: ['example.com'],
    url: 'https://example.com/a?utm_source=x',
    ...over,
  };
}

/**
 * Random copies of one page, drawing from a shared pool of ids so that copies overlap,
 * disagree on fields and delete each other's content.
 */
export function randomRecord(r: Rng, pool = 6): PageRecord {
  const notes: Note[] = [];
  const deleted: Tombstone[] = [];
  for (let i = 0; i < pool; i++) {
    if (!r.chance(0.6)) continue;
    const strokes: Stroke[] = [];
    for (let j = 0; j < 4; j++) {
      if (r.chance(0.5)) strokes.push(stroke({ id: `s${i}_${j}`, t: 100 + j * 10 + i, d: `M${i} ${j}L1 1` }));
    }
    // Some copies already hold what was left after a deletion at `cut`, with its tombstone.
    const cut = r.chance(0.2) ? 100 + r.int(40) : undefined;
    if (cut !== undefined) deleted.push({ id: `n${i}`, t: cut });
    notes.push(
      note({
        id: cut === undefined ? `n${i}` : `n${i}~${cut.toString(36)}`,
        createdAt: 10 + i,
        // Usually older than the strokes; sometimes an edit made later.
        updatedAt: r.chance(0.7) ? 10 + r.int(5) : 100 + r.int(50),
        device: r.pick(['a', 'b', 'c']),
        anchor: anchor({ place: r.pick(['on', 'left', 'right'] as const) }),
        strokes: cut === undefined ? strokes : strokes.filter((s) => s.t > cut),
      }),
    );
  }
  for (let k = 0; k < 4; k++) {
    if (!r.chance(0.4)) continue;
    const i = r.int(pool);
    const id = r.pick([`n${i}`, `n${i}`, `n${i}~${(100 + r.int(40)).toString(36)}`, `s${i}_${r.int(4)}`]);
    // Deletions before every stroke, and deletions in the middle of the strokes.
    deleted.push({ id, t: r.chance(0.3) ? 50 + r.int(5) : 95 + r.int(45) });
  }
  const rec = record({
    urls: [r.pick(['https://example.com/a', 'https://example.com/a?x=1', 'https://m.example.com/a'])],
    title: r.pick(['One', 'Two', 'Three']),
    updatedAt: 10 + r.int(5),
    notes,
    deleted,
  });
  if (r.chance(0.3)) rec.snapshot = { ref: r.pick(['r1', 'r2']), t: r.int(3) };
  return rec;
}

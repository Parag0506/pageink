/** Record builders for tests. Not shipped: nothing in entrypoints imports this. */
import { hashKey, idxKey, pageKeyOf } from 'pageink-core/hash';
import type { Note, PageIdentity, PageRecord } from 'pageink-core/types';

export function note(id: string, quote = 'some words', t = 1000): Note {
  return {
    id,
    createdAt: t,
    updatedAt: t,
    device: 'test',
    kind: 'ink',
    anchor: {
      type: 'text',
      quote: { exact: quote, prefix: '', suffix: '' },
      path: { css: 'p', xpath: '/html/body/p' },
      pos: { start: 0, end: quote.length },
      hash: 'h',
      place: 'on',
    },
    frame: { w: 100, h: 20, fontPx: 16, viewportW: 1000 },
    strokes: [
      { id: `${id}s`, t, tool: 'pen', color: 'ink-1', w: 2, pts: [0, 0, 50, 10, 10, 0], d: 'M0 0L1 1Z' },
    ],
  };
}

export function record(url: string, notes: Note[], title = 'A page', updatedAt = 2000): PageRecord {
  return { v: 1, key: url, urls: [url], title, updatedAt, notes, deleted: [] };
}

export function identity(url: string): PageIdentity {
  const host = new URL(url).hostname;
  return { key: url, aliases: [], host, hosts: [host], url };
}

/** Storage items for a page with ink: the record and its host index entry. */
export function seed(rec: PageRecord): Record<string, unknown> {
  const host = new URL(rec.key).hostname;
  return {
    [pageKeyOf(rec.key)]: rec,
    [idxKey(host)]: { v: 1, m: { [hashKey(rec.key)]: hashKey(rec.key) } },
  };
}

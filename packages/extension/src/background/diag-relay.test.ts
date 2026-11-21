/**
 * Diagnostics builds only: the PDF viewer's stroke records reach the device check page through
 * the background (diag-relay.ts). The function is given the origin here; a release build never
 * calls it, and test/diag.test.ts checks that none of it is in the builds that ship.
 */
import { describe, expect, test } from 'vitest';
import type { Api } from '../api';
import { DIAG_KEY } from '../content/diag';
import { relayDiag } from './diag-relay';

const ORIGIN = 'http://192.168.1.20:8790';
const OWN = 'safari-web-extension://abc/';

function fake() {
  const store: Record<string, unknown> = {};
  const listeners: ((m: unknown, s: unknown, reply: (r: unknown) => void) => unknown)[] = [];
  const sent: { tab: number; m: unknown }[] = [];
  const api = {
    runtime: {
      getURL: (p: string) => OWN + p,
      onMessage: { addListener: (f: (typeof listeners)[number]) => listeners.push(f) },
    },
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => Object.assign(store, o),
      },
    },
    tabs: {
      query: async () => [
        { id: 1, url: `${ORIGIN}/s/pdf` },
        { id: 2, url: 'https://example.test/' },
        { id: 3, url: `${ORIGIN}.evil.test/` },
        { id: 4 },
      ],
      sendMessage: async (tab: number, m: unknown) => {
        sent.push({ tab, m });
      },
    },
  } as unknown as Api;
  const send = (m: unknown, s: unknown) =>
    new Promise((ok) => {
      const r = listeners.map((l) => l(m, s, ok)).find((x) => x === true);
      if (!r) ok('none');
    });
  return { api, store, sent, send, listeners };
}

const rec = (id: string) => ({ id, where: 'pdf', page: 'pdf viewer', at: 1 });
const viewer = { url: `${OWN}pdf.html?file=x`, id: 'abc' };

describe('the diagnostics relay', () => {
  test("keeps the viewer's record and hands it to the check page's tabs only", async () => {
    const f = fake();
    relayDiag(f.api, ORIGIN);
    expect(await f.send({ ink: 'diag', record: rec('a') }, viewer)).toBe(true);
    expect(f.sent).toEqual([{ tab: 1, m: { ink: 'diag', record: rec('a') } }]);
    expect(f.store[DIAG_KEY]).toEqual([rec('a')]);
    // The same record twice is kept once.
    await f.send({ ink: 'diag', record: rec('a') }, viewer);
    expect(f.store[DIAG_KEY]).toEqual([rec('a')]);
  });

  test('takes nothing from web pages, and nothing that is not a viewer record', async () => {
    const f = fake();
    relayDiag(f.api, ORIGIN);
    const page = { url: 'https://example.test/', tab: { id: 2 }, id: 'abc' };
    expect(await f.send({ ink: 'diag', record: rec('b') }, page)).toBe('none');
    expect(await f.send({ ink: 'diag', record: { ...rec('c'), where: 'page' } }, viewer)).toBe('none');
    expect(await f.send({ ink: 'diag', record: 'x' }, viewer)).toBe('none');
    expect(await f.send({ ink: 'other' }, viewer)).toBe('none');
    expect(f.sent).toEqual([]);
    expect(f.store[DIAG_KEY]).toBeUndefined();
  });

  test('tells the check page, and only it, whether every website is allowed', async () => {
    for (const all of [true, false]) {
      const f = fake();
      (f.api as unknown as { permissions: unknown }).permissions = { contains: async () => all };
      relayDiag(f.api, ORIGIN);
      const check = { url: `${ORIGIN}/s/extension`, tab: { id: 1 } };
      expect(await f.send({ ink: 'diag', ask: 'access' }, check)).toBe(all);
      const other = { url: 'https://example.test/', tab: { id: 2 } };
      expect(await f.send({ ink: 'diag', ask: 'access' }, other)).toBe('none');
    }
  });

  test('without an origin, which is every release build, it does nothing', () => {
    const f = fake();
    relayDiag(f.api, '');
    expect(f.listeners).toHaveLength(0);
  });
});

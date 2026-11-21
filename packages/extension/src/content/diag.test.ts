/**
 * Diagnostics builds only: the PDF viewer's probe (diag.ts). The device check counts a PDF
 * stroke only when its record is in the extension's log when the person comes back, so the
 * viewer must keep it whatever the background does.
 */

import type { Probe } from 'pageink-core/types';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Api } from '../api';
import { DIAG_KEY, probeFor, RELAY } from './diag';

function fake(send: (m: unknown) => Promise<unknown>) {
  const store: Record<string, unknown> = {};
  const sent: unknown[] = [];
  const api = {
    runtime: {
      sendMessage: (m: unknown) => {
        // What was in the log when the message went.
        sent.push({ m, kept: (store[DIAG_KEY] as unknown[] | undefined)?.length ?? 0 });
        return send(m);
      },
    },
    storage: {
      local: {
        get: async (k: string) => ({ [k]: store[k] }),
        set: async (o: Record<string, unknown>) => Object.assign(store, o),
      },
    },
  } as unknown as Api;
  return { api, store, sent };
}

/** One Pencil stroke through the probe, as capture reports it. */
function stroke(p: Probe): void {
  p.start('pen', 'pen', 1, false, false);
  p.move(3);
  p.end('ink', 20, [{ t: 1 }, { t: 10 }, { t: 20 }]);
}

const settle = () => new Promise((ok) => setTimeout(ok, 0));

describe("the PDF viewer's probe", () => {
  beforeEach(() => {
    vi.stubGlobal('window', { scrollX: 0, scrollY: 0, requestAnimationFrame: (f: () => void) => f() });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('keeps the record itself, then sends it to the background to pass on', async () => {
    const f = fake(async () => true);
    stroke(probeFor(f.api, 'pdf'));
    await settle();
    const log = f.store[DIAG_KEY] as { where: string; outcome: string; pointerType: string; page: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ where: 'pdf', outcome: 'ink', pointerType: 'pen', page: 'pdf viewer' });
    expect(f.sent).toEqual([{ m: { ink: RELAY, record: log[0] }, kept: 1 }]);
  });

  test('keeps the record when the background never answers', async () => {
    // Safari stops its background often, and a message to it may never be answered.
    const f = fake(() => new Promise(() => {}));
    const p = probeFor(f.api, 'pdf');
    stroke(p);
    stroke(p);
    await settle();
    expect(f.store[DIAG_KEY]).toHaveLength(2);
  });

  test('keeps the record when the background is not there', async () => {
    const f = fake(() => Promise.reject(new Error('Could not establish connection')));
    stroke(probeFor(f.api, 'pdf'));
    await settle();
    expect(f.store[DIAG_KEY]).toHaveLength(1);
  });
});

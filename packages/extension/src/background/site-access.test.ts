/** Safari tells its app whether every website is allowed (site-access.ts). */
import { describe, expect, test, vi } from 'vitest';
import type { NativeRequest } from '../adapters/folder-native';
import type { Api } from '../api';
import { keepAccessReported } from './site-access';

function fake(all: { v: boolean }, reply: { ok: boolean } = { ok: true }) {
  const on = () => {
    const ls: (() => void)[] = [];
    return { ls, addListener: (f: () => void) => ls.push(f) };
  };
  const ev = { added: on(), removed: on(), startup: on() };
  const api = {
    permissions: {
      contains: async () => all.v,
      onAdded: ev.added,
      onRemoved: ev.removed,
    },
    runtime: { onStartup: ev.startup },
  } as unknown as Api;
  const sent: NativeRequest[] = [];
  const send = vi.fn(async (_app: string, m: NativeRequest) => {
    sent.push(m);
    return reply.ok ? { ok: true as const } : { ok: false as const, error: 'unknown-op' };
  });
  return { api, ev, sent, send };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('site access for the app', () => {
  test('sent at start, then only when it changes', async () => {
    const all = { v: false };
    const f = fake(all);
    const report = keepAccessReported(f.api, f.send);
    await settle();
    expect(f.sent).toEqual([{ v: 1, op: 'access', all: false }]);
    await report();
    expect(f.sent).toHaveLength(1);
    all.v = true;
    for (const l of f.ev.added.ls) l();
    await settle();
    expect(f.sent.at(-1)).toEqual({ v: 1, op: 'access', all: true });
    all.v = false;
    for (const l of f.ev.startup.ls) l();
    await settle();
    expect(f.sent.at(-1)).toEqual({ v: 1, op: 'access', all: false });
    expect(f.sent).toHaveLength(3);
  });

  test('an app that does not know the message is asked again next time', async () => {
    const reply = { ok: false };
    const f = fake({ v: true }, reply);
    const report = keepAccessReported(f.api, f.send);
    await settle();
    reply.ok = true;
    await report();
    await report();
    expect(f.sent).toHaveLength(2);
  });

  test('no permissions API: nothing is sent and nothing throws', async () => {
    const send = vi.fn();
    const api = { runtime: { onStartup: { addListener: () => {} } } } as unknown as Api;
    await keepAccessReported(api, send)();
    expect(send).not.toHaveBeenCalled();
  });
});

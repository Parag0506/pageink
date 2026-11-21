import { describe, expect, test } from 'vitest';
import { backgroundSecrets, isSecretKey, memorySecrets, moveSecrets } from './secrets';

/** storage.local or storage.session as the extension sees it. */
function area(seed: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(seed));
  let level: string | undefined;
  return {
    data,
    level: () => level,
    async get(keys?: string | string[] | null) {
      const ks = keys == null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const k of ks) if (data.has(k)) out[k] = structuredClone(data.get(k));
      return out;
    },
    async set(items: Record<string, unknown>) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
    async remove(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
    async setAccessLevel(o: { accessLevel: string }) {
      level = o.accessLevel;
    },
  };
}

describe('secrets', () => {
  test('tokens and the lock key are secrets; notes, settings and name lists are not', () => {
    for (const k of ['tok:google', 'tok:onedrive', 'lockKey']) expect(isSecretKey(k)).toBe(true);
    for (const k of ['p:abc', 'cfg', 'names:google', 'seen:google', 'dest', 'sync'])
      expect(isSecretKey(k)).toBe(false);
  });

  test('values left in storage.local by an older version move once and are removed there', async () => {
    const local = area({
      'tok:google': { access: 'a', exp: 1 },
      lockKey: { key: 'k', check: 'c' },
      cfg: { x: 1 },
    });
    const store = memorySecrets({ 'tok:onedrive': { access: 'newer', exp: 2 } });
    local.data.set('tok:onedrive', { access: 'older', exp: 1 });
    expect((await moveSecrets(local as never, store)).sort()).toEqual([
      'lockKey',
      'tok:google',
      'tok:onedrive',
    ]);
    expect([...local.data.keys()]).toEqual(['cfg']);
    expect(store.all.get('tok:google')).toEqual({ access: 'a', exp: 1 });
    expect(store.all.get('tok:onedrive')).toEqual({ access: 'newer', exp: 2 });
    expect(await moveSecrets(local as never, store)).toEqual([]);
  });

  test('an account name an older build kept in the place is removed from storage.local', async () => {
    const local = area({ dest: { kind: 'cloud', provider: 'google', account: 'a@b.c', since: 5 } });
    await moveSecrets(local as never, memorySecrets());
    expect(local.data.get('dest')).toEqual({ kind: 'cloud', provider: 'google', since: 5 });
    const plain = area({ dest: { kind: 'folder' } });
    await moveSecrets(plain as never, memorySecrets());
    expect(plain.data.get('dest')).toEqual({ kind: 'folder' });
  });

  test('the background store moves old values before its first answer, and keeps nothing in storage.local', async () => {
    const local = area({ 'tok:google': { access: 'a', exp: 1 } });
    const session = area();
    const store = memorySecrets();
    const s = backgroundSecrets({ local: local as never, session: session as never, store });
    expect(await s.get('tok:google')).toEqual({ access: 'a', exp: 1 });
    expect(local.data.has('tok:google')).toBe(false);
    // The session copy is kept only where it can be closed to content scripts.
    expect(session.level()).toBe('TRUSTED_CONTEXTS');
    await s.set('lockKey', { key: 'k', check: 'c' });
    expect(store.all.get('lockKey')).toEqual({ key: 'k', check: 'c' });
    expect(local.data.size).toBe(0);
    await s.remove('lockKey');
    expect(await s.get('lockKey')).toBeUndefined();
    expect(session.data.has('lockKey')).toBe(false);
  });

  test('a session area that cannot be closed to content scripts is not used', async () => {
    const session = area();
    const open = { get: session.get, set: session.set, remove: session.remove };
    const s = backgroundSecrets({ local: area() as never, session: open as never, store: memorySecrets() });
    await s.set('tok:google', { access: 'a', exp: 1 });
    expect(session.data.size).toBe(0);
  });
});

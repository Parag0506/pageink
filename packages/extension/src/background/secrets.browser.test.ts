import { expect, test } from 'vitest';
import { idbSecrets } from './secrets';

test('IndexedDB keeps, returns and removes secrets', async () => {
  const name = `pageink-secrets-test-${Math.random().toString(36).slice(2)}`;
  const s = idbSecrets(indexedDB, name);
  expect(await s.get('tok:google')).toBeUndefined();
  await s.set('tok:google', { access: 'a', exp: 1 });
  await s.set('lockKey', { key: 'k', check: 'c' });
  expect(await s.get('tok:google')).toEqual({ access: 'a', exp: 1 });
  // A second handle on the same database sees the same values.
  expect(await idbSecrets(indexedDB, name).get('lockKey')).toEqual({ key: 'k', check: 'c' });
  await s.remove(['tok:google', 'lockKey']);
  expect(await s.get('tok:google')).toBeUndefined();
  expect(await s.get('lockKey')).toBeUndefined();
  await new Promise<void>((ok) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = r.onerror = r.onblocked = () => ok();
  });
});

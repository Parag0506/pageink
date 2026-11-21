import { expect, test } from 'vitest';
import { type DirHandle, loadHandle, saveHandle } from './folder-fs';

test('the folder handle survives in IndexedDB and can be cleared', async () => {
  // A real handle needs a picker. Any cloneable value takes the same path.
  const fake = { kind: 'directory', name: 'PageInk Notes' } as unknown as DirHandle;
  await saveHandle(null);
  expect(await loadHandle()).toBeNull();
  await saveHandle(fake);
  expect(await loadHandle()).toEqual(fake);
  await saveHandle(null);
  expect(await loadHandle()).toBeNull();
});

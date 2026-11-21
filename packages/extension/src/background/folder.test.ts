import { memoryFolder } from 'pageink-core/store';
import { expect, test, vi } from 'vitest';
import { folderKind, folderOpener } from './folder';

test('folder kind per target', () => {
  expect(folderKind('chrome')).toBe('fs');
  expect(folderKind('edge')).toBe('fs');
  expect(folderKind('firefox')).toBe('archive');
  expect(folderKind('safari')).toBe('native');
});

test('a test folder wins, archive builds have none', async () => {
  const io = memoryFolder();
  expect(await folderOpener({} as never, 'fs', io)()).toBe(io);
  expect(await folderOpener({} as never, 'archive')()).toBe('none');
});

test('native opens the app folder only when one is chosen', async () => {
  const api = (folder: string | null) =>
    ({ runtime: { sendNativeMessage: vi.fn(async () => ({ ok: true, folder })) } }) as never;
  expect(typeof (await folderOpener(api('Notes'), 'native')()) === 'object').toBe(true);
  expect(await folderOpener(api(null), 'native')()).toBe('none');
  const broken = {
    runtime: { sendNativeMessage: vi.fn(async () => Promise.reject(new Error('no app'))) },
  } as never;
  expect(await folderOpener(broken, 'native')()).toBe('none');
});

test('fs without IndexedDB or a handle is none', async () => {
  expect(await folderOpener({} as never, 'fs')()).toBe('none');
});

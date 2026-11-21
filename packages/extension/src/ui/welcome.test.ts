import { expect, test } from 'vitest';
import type { Api } from '../api';
import { drawShortcut, drawStep } from './welcome';

const api = (all: unknown) => ({ commands: { getAll: async () => all } }) as unknown as Api;

test('drawShortcut shows the key the browser assigned', async () => {
  expect(await drawShortcut(api([{ name: 'toggle-draw', shortcut: 'Ctrl+Shift+Y' }]))).toBe('Ctrl+Shift+Y');
});

test('drawShortcut is null with no commands API, no shortcut assigned, or a failing call', async () => {
  // Safari on iPad: no commands API at all.
  expect(await drawShortcut({} as Api)).toBeNull();
  expect(await drawShortcut({ commands: {} } as unknown as Api)).toBeNull();
  expect(await drawShortcut(api([{ name: 'toggle-draw', shortcut: '' }]))).toBeNull();
  expect(await drawShortcut(api([{ name: 'other', shortcut: 'Alt+Shift+D' }]))).toBeNull();
  expect(await drawShortcut(api(undefined))).toBeNull();
  const broken = {
    commands: {
      getAll: async () => {
        throw new Error('no commands here');
      },
    },
  } as unknown as Api;
  expect(await drawShortcut(broken)).toBeNull();
});

test('drawStep names the shortcut only when there is one', () => {
  const withKey = drawStep('Alt+Shift+D');
  expect(withKey.key).toBe('Alt+Shift+D');
  expect(withKey.text).toMatch(/choose Draw, or press $/);
  const none = drawStep(null);
  expect(none.key).toBeUndefined();
  expect(none.text).toMatch(/toolbar and choose Draw\.$/);
  expect(none.text).not.toMatch(/Shift|press/);
});

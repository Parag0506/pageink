import { describe, expect, test, vi } from 'vitest';
import {
  NATIVE_APP,
  NativeError,
  type NativeReply,
  type NativeRequest,
  nativeConnect,
  nativeDisconnect,
  nativeFolder,
  nativePlace,
  nativeStatus,
  sendNativeOf,
} from './folder-native';

/** A fake wrapper app that keeps files in memory and speaks protocol v1. */
function fakeApp(folder: string | null = 'PageInk Notes') {
  const files = new Map<string, string>();
  const send = vi.fn(async (app: string, m: NativeRequest): Promise<NativeReply | undefined> => {
    expect(app).toBe(NATIVE_APP);
    expect(m.v).toBe(1);
    if (m.op === 'status') return { ok: true, folder };
    if (!folder) return { ok: false, error: 'no-folder' };
    if (m.op === 'list')
      return {
        ok: true,
        files: [...files]
          .filter(([n]) => n.startsWith(`${m.dir}/`))
          .map(([name, t]) => ({ name, mtime: 1, size: t.length })),
      };
    if (m.op === 'read')
      return files.has(m.name) ? { ok: true, text: files.get(m.name)! } : { ok: false, error: 'not-found' };
    if (m.op === 'write') files.set(m.name, m.text);
    if (m.op === 'remove') files.delete(m.name);
    return { ok: true };
  });
  return { send, files };
}

describe('native folder', () => {
  test('status names the folder or null', async () => {
    expect(await nativeStatus(fakeApp().send)).toBe('PageInk Notes');
    expect(await nativeStatus(fakeApp(null).send)).toBeNull();
  });

  test('write, list, read and remove follow the protocol', async () => {
    const app = fakeApp();
    const io = nativeFolder(app.send);
    await io.write('pages/a.ink.json', '{"v":1}');
    expect(app.send).toHaveBeenLastCalledWith(NATIVE_APP, {
      v: 1,
      op: 'write',
      name: 'pages/a.ink.json',
      text: '{"v":1}',
    });
    expect(await io.list('pages')).toEqual([{ name: 'pages/a.ink.json', mtime: 1, size: 7 }]);
    expect(await io.read('pages/a.ink.json')).toBe('{"v":1}');
    await io.remove!('pages/a.ink.json');
    expect(await io.list('pages')).toEqual([]);
  });

  test('errors from the app become NativeError with its code', async () => {
    const io = nativeFolder(fakeApp().send);
    await expect(io.read('pages/none.ink.json')).rejects.toMatchObject({ code: 'not-found' });
    await expect(nativeFolder(fakeApp(null).send).list('pages')).rejects.toBeInstanceOf(NativeError);
    await expect(nativeFolder(async () => undefined).list('pages')).rejects.toMatchObject({
      code: 'no-reply',
    });
    await expect(nativeFolder(async () => ({ ok: true })).read('pages/a')).rejects.toMatchObject({
      code: 'no-text',
    });
  });

  test('refuses names that leave the folder', async () => {
    const app = fakeApp();
    const io = nativeFolder(app.send);
    await expect(io.read('/etc/passwd')).rejects.toMatchObject({ code: 'bad-name' });
    await expect(io.write('pages/../../x', '')).rejects.toMatchObject({ code: 'bad-name' });
    expect(app.send).not.toHaveBeenCalled();
  });

  test('a cloud is chosen, reported and left through the app', async () => {
    let place: 'google' | null = null;
    const send = vi.fn(async (_app: string, m: NativeRequest): Promise<NativeReply> => {
      if (m.op === 'connect') {
        place = 'google';
        return { ok: true, account: 'a@b.test' };
      }
      if (m.op === 'disconnect') {
        place = null;
        return { ok: true };
      }
      if (m.op === 'status') {
        return place
          ? { ok: true, folder: 'Google Drive', place, account: 'a@b.test' }
          : { ok: true, folder: null };
      }
      return { ok: false, error: 'no-folder' };
    });
    expect(await nativePlace(send)).toEqual({ folder: null, place: null });
    expect(await nativeConnect(send, 'google')).toEqual({ account: 'a@b.test', pending: false });
    expect(await nativePlace(send)).toEqual({ folder: 'Google Drive', place: 'google', account: 'a@b.test' });
    await nativeDisconnect(send, false);
    expect(send).toHaveBeenLastCalledWith(NATIVE_APP, { v: 1, op: 'disconnect', removeFiles: false });
    // Pending: the app's own link is passed on, anything else is dropped.
    const pending = (open: string) => async () => ({ ok: true as const, pending: true, open });
    expect(
      await nativeConnect(
        pending('org.example.app://connect?place=google&request=0123456789abcdef0123456789abcdef'),
        'google',
      ),
    ).toEqual({
      pending: true,
      open: 'org.example.app://connect?place=google&request=0123456789abcdef0123456789abcdef',
    });
    for (const bad of [
      'org.example.app://connect?place=google',
      'org.example.app://connect?place=google&request=nothex',
      'https://connect?place=google',
      'javascript://connect?place=google',
      'x://evil',
    ]) {
      expect((await nativeConnect(pending(bad), 'google')).open).toBeUndefined();
    }
    // An older app knows only folders.
    expect(await nativePlace(async () => ({ ok: true, folder: 'Notes' }))).toEqual({
      folder: 'Notes',
      place: 'folder',
    });
    await expect(
      nativeConnect(async () => ({ ok: false, error: 'cancelled' }), 'onedrive'),
    ).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  test('sendNativeOf calls runtime.sendNativeMessage', async () => {
    const sendNativeMessage = vi.fn(async () => ({ ok: true, folder: 'F' }));
    const send = sendNativeOf({ runtime: { sendNativeMessage } } as never);
    expect(await nativeStatus(send)).toBe('F');
    expect(sendNativeMessage).toHaveBeenCalledWith(NATIVE_APP, { v: 1, op: 'status' });
  });
});

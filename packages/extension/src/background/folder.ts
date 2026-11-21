/**
 * Which folder the background syncs with, per build target.
 * Chromium: the picked directory handle. Safari: the wrapper app.
 * Firefox: none; it uses archive export and import instead (CONTRACT 6).
 */
import type { FolderIO } from 'pageink-core/types';
import { folderAccess, fsFolder, loadHandle } from '../adapters/folder-fs';
import { nativeFolder, nativeStatus, sendNativeOf } from '../adapters/folder-native';
import type { OpenFolder } from './syncer';

export type FolderKind = 'fs' | 'native' | 'archive';

export const folderKind = (t: typeof __INK_TARGET__): FolderKind =>
  t === 'safari' ? 'native' : t === 'firefox' ? 'archive' : 'fs';

export function folderOpener(api: typeof chrome, kind: FolderKind, test?: FolderIO): OpenFolder {
  return async () => {
    if (test) return test;
    if (kind === 'archive') return 'none';
    if (kind === 'native') {
      const send = sendNativeOf(api);
      try {
        return (await nativeStatus(send)) ? nativeFolder(send) : 'none';
      } catch {
        return 'none';
      }
    }
    const h = await loadHandle().catch(() => null);
    if (!h) return 'none';
    if ((await folderAccess(h).catch(() => 'prompt')) !== 'granted') return 'permission';
    return fsFolder(h);
  };
}

/** Whether a folder is chosen and usable, without opening it. */
export async function folderState(open: OpenFolder): Promise<'none' | 'permission' | 'ok'> {
  const io = await open();
  if (typeof io !== 'string') return 'ok';
  return io === 'none' || io === 'permission' ? io : 'ok';
}

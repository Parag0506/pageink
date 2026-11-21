/**
 * The one line the popup shows when the action needs the reader: folder access that
 * lapsed, with a Reconnect button that fixes it in one click; a problem with the cloud,
 * with its one next step; or the backup prompt.
 */

import { folderAccess, loadHandle } from '../adapters/folder-fs';
import type { Api } from '../api';
import type { Attention } from '../background/attention';
import type { FolderKind } from '../background/folder';
import { problemText } from '../connect/dest';
import type { SyncReply, ToBackground } from '../messages';
import { NUDGE_TEXT } from '../nudge';

export interface AttentionView {
  root: HTMLElement;
  text: HTMLElement;
  go: HTMLButtonElement;
  later: HTMLButtonElement;
}

export interface AttentionDeps {
  api: Api;
  kind: FolderKind;
  /** Open a tab of the options page and close the popup. */
  openOptions: (hash: string) => void;
  /** Ask for folder access from this click. Default: the stored handle's requestPermission. */
  regrant?: () => Promise<boolean>;
}

const send = <T>(api: Api, m: ToBackground) => api.runtime.sendMessage(m) as Promise<T>;

async function regrant(): Promise<boolean> {
  const h = await loadHandle().catch(() => null);
  return !!h && (await folderAccess(h, true).catch(() => 'denied')) === 'granted';
}

/** Show what the background reports, and wire the buttons. */
export function showAttention(v: AttentionView, a: Attention | undefined, d: AttentionDeps): void {
  v.root.hidden = !a?.lapsed && !a?.nudge && !a?.problem;
  if (!a || v.root.hidden) return;
  if (a.problem) {
    const where = a.place ?? 'your notes place';
    const t = problemText(a.problem, where);
    v.text.textContent = t.text;
    v.go.textContent = t.next;
    v.go.hidden = false;
    v.later.hidden = true;
    const provider = a.provider;
    v.go.onclick = async () => {
      if (a.problem !== 'expired' || !provider) return d.openOptions('settings');
      v.go.disabled = true;
      // The sign-in window opens from the background; the popup may close meanwhile.
      const r = await send<{ ok?: boolean }>(d.api, { ink: 'connect', provider }).catch(() => undefined);
      v.text.textContent = r?.ok ? 'Signed in again. Notes are in sync.' : t.text;
      v.go.hidden = !!r?.ok;
      v.go.disabled = false;
    };
    return;
  }
  if (a.lapsed) {
    v.text.textContent = 'The backup folder needs access again.';
    v.go.textContent = 'Reconnect';
    v.later.hidden = true;
    v.go.onclick = async () => {
      v.go.disabled = true;
      if (await (d.regrant ?? regrant)()) {
        // Sync now, so what waited while access was lapsed reaches the folder.
        const r = await send<SyncReply>(d.api, { ink: 'reconnected' }).catch(() => undefined);
        v.text.textContent = r?.report ? 'Reconnected. Notes are in sync.' : 'Reconnected.';
        v.go.hidden = true;
      } else {
        // The browser did not ask here. The settings page can, from its own click.
        d.openOptions('settings');
      }
      v.go.disabled = false;
    };
    return;
  }
  const kind = a.nudge!;
  v.text.textContent = NUDGE_TEXT[kind];
  v.go.hidden = false;
  v.go.textContent = kind === 'archive' ? 'Export archive' : 'Choose where';
  v.go.onclick = () => d.openOptions('settings');
  v.later.hidden = false;
  v.later.onclick = async () => {
    v.root.hidden = true;
    await send(d.api, { ink: 'nudge', act: 'dismiss' }).catch(() => {});
  };
}

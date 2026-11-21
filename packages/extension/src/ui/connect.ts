/**
 * The connect screen: where this device keeps a copy of the notes. Three large choices,
 * each one click and then the provider's own sign-in window: Google Drive, OneDrive, or a
 * folder on this device. Once connected: the account or folder, the last sync, Sync now,
 * Disconnect, and the password lock. One place at a time. No network code here: the
 * background does the work (background/place.ts).
 */
import {
  canPickFolder,
  type DirHandle,
  folderAccess,
  loadHandle,
  pickFolder,
  saveHandle,
} from '../adapters/folder-fs';
import type { Api } from '../api';
import type { FolderKind } from '../background/folder';
import { NAME } from '../brand';
import { type Dest, PROVIDER_NAME, type Problem, type ProviderId, problemText } from '../connect/dest';
import { CLIENT_IDS, type ClientIds, isSetUp } from '../connect/ids';
import type { PlaceReply, PlaceState, SyncReply, ToBackground, ToPlace } from '../messages';
import { h, saveFile, say, when } from './dom';
import { consentNote, returnAddress, signInProblem } from './sign-in-help';

export interface ConnectDeps {
  api: Api;
  kind: FolderKind;
  store: { setConfig(p: { folder?: string }): Promise<unknown> };
  /** Called after a place is chosen, so the backup prompt ends. */
  connected?: () => void;
  /** The archive buttons, for browsers with no folder, and as a way to move notes by hand. */
  archive?: () => HTMLElement;
  ids?: ClientIds;
  /** Firefox for Android has no sign-in window: only the archive there. */
  platform?: () => Promise<string>;
}

const send = <T>(api: Api, m: ToBackground) => api.runtime.sendMessage(m) as Promise<T>;

/**
 * One plain line on taking the extension's access away in the provider's own account page.
 * The addresses are text for the reader to open, not links this code follows.
 */
export function revokeLine(p: ProviderId): string {
  return p === 'google'
    ? `To remove ${NAME}'s access in your Google account too, open myaccount.google.com/connections.`
    : `Microsoft does not let ${NAME} give its access back. To remove it, open account.live.com/consent/Manage (for a work or school account: myapps.microsoft.com).`;
}
const ask = (api: Api, m: ToPlace) =>
  send<PlaceReply>(api, m).catch(() => ({ error: 'no reply' }) as PlaceReply);

/** The words for a place, as the reader sees them. */
export function placeName(dest: Dest | null, folder?: string): string {
  if (dest?.kind === 'cloud') return PROVIDER_NAME[dest.provider];
  return folder ? `“${folder}”` : 'the folder';
}

/** Which choices a browser offers. Clouds need a sign-in window: Chrome, Edge, Firefox on a computer, or the Safari app. */
export function choicesFor(
  kind: FolderKind,
  os: string,
): { clouds: boolean; folder: boolean; archive: boolean } {
  if (kind === 'archive') return { clouds: os !== 'android', folder: false, archive: true };
  return { clouds: true, folder: true, archive: false };
}

export function mountConnect(root: HTMLElement, d: ConnectDeps): () => Promise<void> {
  const { api } = d;
  const ids = d.ids ?? CLIENT_IDS;
  const chromium = __INK_TARGET__ === 'chrome' || __INK_TARGET__ === 'edge';
  let showChoices = false;
  let recovery: string | null = null;

  const problemLine = (p: Problem, where: string, act?: () => void) => {
    const t = problemText(p, where);
    return h(
      'div',
      { class: 'problem', id: 'place-problem', role: 'alert' },
      h('span', {}, `${t.text} `),
      act
        ? h('button', { type: 'button', id: 'place-fix', onclick: act }, t.next)
        : h('span', {}, `${t.next}.`),
    );
  };

  /**
   * Ask from this click for what connecting a cloud needs. Chrome and Edge: the sign-in
   * permission, which shows no prompt. Firefox: the reader's yes to page addresses and the
   * words notes sit on going to their own cloud (data_collection_permissions in the manifest).
   */
  async function mayOpenSignIn(): Promise<boolean> {
    if (__INK_TARGET__ === 'firefox') {
      const req = api.permissions.request as unknown as (p: {
        data_collection: string[];
      }) => Promise<boolean>;
      try {
        return await req({ data_collection: ['browsingActivity', 'websiteContent'] });
      } catch {
        return false;
      }
    }
    if (!chromium) return true;
    try {
      return await api.permissions.request({ permissions: ['identity'] });
    } catch {
      return false;
    }
  }

  async function connectCloud(p: ProviderId, st: PlaceState, handle: DirHandle | null, out: HTMLElement) {
    if (!(await mayOpenSignIn())) {
      out.replaceChildren(problemLine('denied', 'The browser'));
      return;
    }
    out.replaceChildren(
      h(
        'p',
        { class: 'muted', id: 'place-wait' },
        `Finish signing in to ${PROVIDER_NAME[p]} in the window that opened.`,
      ),
    );
    const same = st.dest?.kind === 'cloud' && st.dest.provider === p;
    const r = await ask(api, { ink: 'connect', provider: p, switching: !same && !!(st.dest || handle) });
    if (r.pending) {
      const open = r.open;
      out.replaceChildren(
        h('p', { id: 'place-wait' }, `Finish connecting in the ${NAME} app.`),
        ...(open
          ? [
              h(
                'button',
                {
                  type: 'button',
                  id: 'open-app',
                  class: 'primary',
                  // Safari asks the reader to open the app, which then shows the sign-in.
                  onclick: () => void api.tabs.create({ url: open }).catch(() => window.open(open)),
                },
                `Open ${NAME}`,
              ),
            ]
          : []),
      );
      return;
    }
    if (!r.ok) {
      const again = () => void connectCloud(p, st, handle, out);
      out.replaceChildren(
        r.detail
          ? signInProblem({ provider: p, ...r.detail }, PROVIDER_NAME[p], returnAddress(api), again)
          : problemLine(r.problem ?? 'server', PROVIDER_NAME[p], again),
      );
      return;
    }
    // One place at a time: the folder is no longer used. Its files stay where they are.
    if (handle) {
      await saveHandle(null).catch(() => {});
      await d.store.setConfig({ folder: undefined });
    }
    d.connected?.();
    showChoices = false;
    say(`Connected to ${PROVIDER_NAME[p]}`);
    await refresh();
  }

  async function connectFolder(st: PlaceState, handle: DirHandle | null) {
    try {
      const h2 = await pickFolder();
      await d.store.setConfig({ folder: h2.name });
      const r = await ask(api, {
        ink: 'useFolder',
        switching: !!(st.dest?.kind === 'cloud' || (handle && handle.name !== h2.name)),
      });
      if (r.error) say(`Could not connect: ${r.error}`);
      const s = await send<SyncReply>(api, { ink: 'reconnected' }).catch(() => undefined);
      say(s?.report ? 'Connected. Notes are in sync.' : 'Connected.');
      d.connected?.();
      showChoices = false;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') say(`Could not connect: ${String(e)}`);
    }
    await refresh();
  }

  function choices(st: PlaceState, handle: DirHandle | null, os: string): HTMLElement {
    const c = choicesFor(d.kind, os);
    const out = h('div', { id: 'place-out' });
    const big = (id: string, title: string, line: string, enabled: boolean, onclick: () => void) =>
      h(
        'button',
        { type: 'button', id, class: 'choice', disabled: !enabled, onclick },
        h('strong', {}, title),
        h('span', { class: 'muted' }, line),
      );
    const cloud = (p: ProviderId) => {
      const ready = d.kind === 'native' || isSetUp(p, ids);
      return big(
        `connect-${p}`,
        PROVIDER_NAME[p],
        ready
          ? `Sign in with your ${p === 'google' ? 'Google' : 'Microsoft'} account.`
          : 'Not set up in this build.',
        ready,
        () => void connectCloud(p, st, handle, out),
      );
    };
    const list = h('div', { class: 'choices' });
    if (c.clouds) list.append(cloud('google'), cloud('onedrive'));
    // The Safari app shows its own sign-in; the note and the address are for the browser's.
    const note =
      c.clouds && d.kind !== 'native'
        ? consentNote(returnAddress(api), async () =>
            (await mayOpenSignIn()) ? returnAddress(api) : undefined,
          )
        : null;
    if (c.folder && d.kind === 'fs') {
      list.append(
        big(
          'connect',
          'A folder on this device',
          'Works with iCloud Drive, Dropbox and any synced folder.',
          canPickFolder(),
          () => void connectFolder(st, handle),
        ),
      );
    } else if (c.folder && d.kind === 'native') {
      list.append(
        big(
          'connect',
          'A folder on this device',
          `Choose it in the ${NAME} app. Works with iCloud Drive.`,
          false,
          () => {},
        ),
      );
    }
    const box = h('div', {}, list, note, out);
    if (c.archive) {
      box.append(
        h(
          'p',
          { class: 'muted' },
          c.clouds
            ? 'Or keep an archive file: export it into a synced folder, and import it on your other devices.'
            : 'This browser cannot sign in to a cloud. Export an archive into a synced folder, and import it on your other devices.',
        ),
      );
      const a = d.archive?.();
      if (a) box.append(a);
    }
    return box;
  }

  function disconnectAsk(st: PlaceState, where: string, box: HTMLElement, back: () => void) {
    const cloud = st.dest?.kind === 'cloud';
    const done = async (removeFiles: boolean) => {
      const r = await ask(api, { ink: 'disconnect', removeFiles });
      if (!r.ok) {
        box.replaceChildren(problemLine(r.problem ?? 'server', where, () => void done(removeFiles)));
        return;
      }
      if (st.dest?.kind !== 'cloud') {
        await saveHandle(null).catch(() => {});
        await d.store.setConfig({ folder: undefined });
      }
      say(
        removeFiles
          ? `Disconnected. The files are in the ${where} bin.`
          : 'Disconnected. The files are kept.',
      );
      await refresh();
    };
    if (!cloud) {
      // A folder on this device: its files always stay.
      void done(false);
      return;
    }
    const sure = () =>
      box.replaceChildren(
        h('p', {}, `Delete your notes from ${where}? They go to its bin. The notes on this device stay.`),
        h(
          'div',
          { class: 'bar' },
          h(
            'button',
            { type: 'button', id: 'disconnect-delete-yes', class: 'danger', onclick: () => void done(true) },
            'Yes, delete them',
          ),
          h('button', { type: 'button', id: 'disconnect-cancel', onclick: back }, 'Cancel'),
        ),
      );
    box.replaceChildren(
      h('p', { id: 'disconnect-ask' }, `Stop syncing with ${where}?`),
      ...(st.dest?.kind === 'cloud'
        ? [h('p', { id: 'disconnect-revoke', class: 'muted' }, revokeLine(st.dest.provider))]
        : []),
      h(
        'div',
        { class: 'bar' },
        h(
          'button',
          { type: 'button', id: 'disconnect-keep', class: 'primary', onclick: () => void done(false) },
          `Disconnect and keep the files in ${where}`,
        ),
        h(
          'button',
          { type: 'button', id: 'disconnect-delete', class: 'danger', onclick: sure },
          `Disconnect and delete them from ${where}`,
        ),
        h('button', { type: 'button', id: 'disconnect-cancel', onclick: back }, 'Cancel'),
      ),
    );
  }

  function lockSection(st: PlaceState, where: string): HTMLElement {
    const box = h('div', { id: 'lock', class: 'lock' });
    const msg = h('p', { id: 'lock-msg', role: 'status', class: 'muted' });
    const wrongText: Record<string, string> = {
      wrong: 'That password does not open the lock.',
      short: 'Use at least 8 characters.',
      'some-locked': 'Some files are locked with another password. They were left as they are.',
      changed:
        'The lock file was changed by someone who does not have the password. Ask whoever can write there, or put the lock back from a device that has your notes.',
      'no-restore': 'This device does not know the lock settings. Turn the lock off here instead.',
    };
    const fail = (r: PlaceReply) => {
      msg.textContent = r.problem
        ? problemText(r.problem, where).text
        : (wrongText[r.error ?? ''] ?? `That did not work: ${r.error ?? 'no reply'}`);
    };

    if (st.lock === 'needs-password') {
      const pass = h('input', { type: 'password', id: 'unlock-pass', autocomplete: 'current-password' });
      const code = h('input', {
        type: 'text',
        id: 'unlock-code',
        placeholder: 'XXXX-XXXX-...',
        hidden: true,
      });
      const unlock = h(
        'button',
        {
          type: 'button',
          id: 'unlock',
          class: 'primary',
          onclick: async () => {
            unlock.disabled = true;
            msg.textContent = 'Checking…';
            const r = await ask(
              api,
              code.hidden
                ? { ink: 'lock', op: 'unlock', password: pass.value }
                : { ink: 'lock', op: 'unlock', code: code.value },
            );
            unlock.disabled = false;
            if (!r.ok) return fail(r);
            await send(api, { ink: 'sync' }).catch(() => {});
            say('Unlocked on this device');
            await refresh();
          },
        },
        'Unlock',
      );
      box.append(
        h(
          'p',
          {},
          `Your notes in ${where} are locked with a password. Enter it once on this device to sync.`,
        ),
        h('div', { class: 'bar' }, h('label', { for: 'unlock-pass' }, 'Password'), pass, code, unlock),
        h(
          'button',
          {
            type: 'button',
            class: 'link',
            id: 'use-recovery',
            onclick: () => {
              code.hidden = !code.hidden;
              pass.hidden = !code.hidden;
            },
          },
          'Use a recovery key instead',
        ),
        msg,
      );
      return box;
    }

    if (st.lock === 'changed') {
      const act = (op: 'restore' | 'off', id: string, label: string, done: string) => {
        const b = h(
          'button',
          {
            type: 'button',
            id,
            class: op === 'restore' ? 'primary' : '',
            onclick: async () => {
              b.disabled = true;
              msg.textContent = 'Working…';
              const r = await ask(api, { ink: 'lock', op });
              b.disabled = false;
              if (!r.ok) return fail(r);
              await send(api, { ink: 'sync' }).catch(() => {});
              say(done);
              await refresh();
            },
          },
          label,
        );
        return b;
      };
      box.append(
        h(
          'p',
          { class: 'warn', id: 'lock-changed' },
          st.trouble === 'missing'
            ? `The lock file in ${where} is gone, but not because of this device. Syncing has stopped. Your notes are safe on this device.`
            : `The lock file in ${where} was changed, but not by this device. Syncing has stopped. Your notes are safe on this device.`,
        ),
        h(
          'p',
          {},
          'If you did not do this, put the lock back. If you turned the lock off on another device, turn it off here too.',
        ),
        h(
          'div',
          { class: 'bar' },
          ...(st.canRestore
            ? [act('restore', 'lock-restore', 'Put the lock back from this device', 'The lock is back on')]
            : []),
          act('off', 'lock-off-here', 'Turn the lock off here', 'The lock is off'),
        ),
        msg,
      );
      return box;
    }

    const on = st.lock === 'on' || st.lock === 'turning-on';
    const sw = h('input', { type: 'checkbox', id: 'lock-switch', role: 'switch', checked: on });
    const form = h('div', { id: 'lock-form' });
    const help = on
      ? `On: your notes are scrambled on this device before they go to ${where}. Only your password opens them.`
      : `Off: ${where} can read your notes. On: they are scrambled on this device before they leave, so only you can read them.`;
    sw.onchange = () => {
      form.replaceChildren();
      msg.textContent = '';
      if (sw.checked && !on) {
        const p1 = h('input', { type: 'password', id: 'lock-pass', autocomplete: 'new-password' });
        const p2 = h('input', { type: 'password', id: 'lock-pass2', autocomplete: 'new-password' });
        const go = h(
          'button',
          {
            type: 'button',
            id: 'lock-on',
            class: 'primary',
            onclick: async () => {
              if (p1.value !== p2.value) {
                msg.textContent = 'The two passwords are not the same.';
                return;
              }
              go.disabled = true;
              msg.textContent = 'Locking your notes. This can take a moment…';
              const r = await ask(api, { ink: 'lock', op: 'on', password: p1.value });
              go.disabled = false;
              if (!r.ok) return fail(r);
              say('Your notes are locked');
              await refresh();
            },
          },
          'Lock my notes',
        );
        form.append(
          h(
            'p',
            { class: 'warn' },
            `If you forget this password, the copy in ${where} cannot be read by anyone, you included. The notes on each of your devices stay readable. After locking, save a recovery key.`,
          ),
          h('div', { class: 'field' }, h('label', { for: 'lock-pass' }, 'Password'), p1),
          h('div', { class: 'field' }, h('label', { for: 'lock-pass2' }, 'Password again'), p2),
          h(
            'div',
            { class: 'bar' },
            go,
            h(
              'button',
              {
                type: 'button',
                onclick: () => {
                  sw.checked = false;
                  form.replaceChildren();
                },
              },
              'Cancel',
            ),
          ),
        );
      } else if (!sw.checked && on) {
        const off = h(
          'button',
          {
            type: 'button',
            id: 'lock-off',
            onclick: async () => {
              off.disabled = true;
              msg.textContent = 'Unlocking your notes…';
              const r = await ask(api, { ink: 'lock', op: 'off' });
              off.disabled = false;
              if (!r.ok) return fail(r);
              say('The lock is off');
              await refresh();
            },
          },
          'Turn the lock off',
        );
        form.append(
          h('p', {}, `${where} will be able to read your notes again.`),
          h(
            'div',
            { class: 'bar' },
            off,
            h(
              'button',
              {
                type: 'button',
                onclick: () => {
                  sw.checked = true;
                  form.replaceChildren();
                },
              },
              'Cancel',
            ),
          ),
        );
      }
    };
    box.append(
      h('div', { class: 'bar' }, sw, h('label', { for: 'lock-switch' }, 'Lock my notes with a password')),
      h('p', { class: 'help muted', id: 'lock-help' }, help),
      form,
    );
    if (on && st.recovery) {
      const show = h('div', { id: 'recovery' });
      const draw = (code: string) =>
        show.replaceChildren(
          h(
            'p',
            {},
            'Your recovery key. Keep it somewhere safe. It opens your notes if you forget the password.',
          ),
          h('pre', { id: 'recovery-code', class: 'code' }, code),
          h(
            'div',
            { class: 'bar' },
            h('button', { type: 'button', onclick: () => window.print() }, 'Print'),
            h(
              'button',
              {
                type: 'button',
                id: 'recovery-save',
                onclick: () =>
                  saveFile(
                    `${NAME} recovery key.txt`,
                    new Blob([`${NAME} recovery key\n\n${code}\n`], { type: 'text/plain' }),
                  ),
              },
              'Save as a file',
            ),
          ),
        );
      if (recovery) draw(recovery);
      box.append(
        h(
          'button',
          {
            type: 'button',
            id: 'lock-recovery',
            onclick: async () => {
              const r = await ask(api, { ink: 'lock', op: 'recovery' });
              if (!r.code) return fail(r);
              recovery = r.code;
              draw(r.code);
            },
          },
          'Save a recovery key',
        ),
        show,
      );
    }
    if (st.locked) {
      box.append(
        h(
          'p',
          { class: 'warn', id: 'locked-files' },
          `${st.locked} file${st.locked === 1 ? ' is' : 's are'} locked with another password. They are kept as they are.`,
        ),
      );
    }
    if (st.refused) {
      box.append(
        h(
          'p',
          { class: 'warn', id: 'refused-files' },
          `${st.refused} file${st.refused === 1 ? ' was' : 's were'} not written by your devices, so ${st.refused === 1 ? 'it was' : 'they were'} left alone and not added to your notes.`,
        ),
      );
    }
    box.append(msg);
    return box;
  }

  async function refresh(): Promise<void> {
    const st = (await ask(api, { ink: 'place' })).state ?? { dest: null, lock: 'unknown' as const };
    const os = await (d.platform?.() ?? Promise.resolve('')).catch(() => '');
    const handle = d.kind === 'fs' ? await loadHandle().catch(() => null) : null;
    const access = handle ? await folderAccess(handle).catch(() => 'prompt' as const) : null;
    // A folder chosen before clouds existed has no stored place: it is still the folder.
    const dest: Dest | null = st.dest ?? (handle || st.folder ? { kind: 'folder' } : null);
    const where =
      dest?.kind === 'cloud' ? PROVIDER_NAME[dest.provider] : placeName(dest, handle?.name ?? st.folder);
    const box = h('div', { id: 'place' });

    if (!dest || showChoices) {
      box.append(
        h(
          'p',
          { id: 'folder-state' },
          dest
            ? `Now: ${where}. Pick a new place. Nothing is copied or removed by itself.`
            : `Your notes are only in this browser. Keep a copy in a place you own. ${NAME} has no server, so nobody else keeps them.`,
        ),
        choices(st, handle, os),
      );
      const cancel = () => {
        showChoices = false;
        void refresh();
      };
      if (dest) box.append(h('button', { type: 'button', id: 'change-cancel', onclick: cancel }, 'Cancel'));
      root.replaceChildren(box);
      return;
    }

    const account = dest.kind === 'cloud' ? st.account : undefined;
    const lapsed = dest.kind === 'folder' && handle && access !== 'granted';
    const state = h(
      'p',
      { id: 'folder-state' },
      lapsed
        ? `${where} needs access again.`
        : account
          ? `Connected to ${where} as ${account}.`
          : `Connected to ${where}.`,
    );
    const last = h('p', { class: 'muted', id: 'last-sync' }, `Last sync: ${when(st.lastSync)}.`);
    const actions = h('div', { class: 'bar' });
    const ask2 = h('div', { id: 'place-ask' });
    const syncNow = h(
      'button',
      {
        type: 'button',
        id: 'sync-now',
        onclick: async () => {
          syncNow.disabled = true;
          if (
            handle &&
            dest.kind === 'folder' &&
            (await folderAccess(handle, true).catch(() => 'denied')) !== 'granted'
          ) {
            say('The folder needs access again');
            syncNow.disabled = false;
            return;
          }
          const r = await send<SyncReply>(api, { ink: 'sync' }).catch(
            () => ({ error: 'no reply' }) as SyncReply,
          );
          say(
            r.report
              ? `Synced: ${r.report.pulled} in, ${r.report.pushed} out, ${r.report.merged} merged`
              : `Not synced: ${r.error}`,
          );
          await refresh();
        },
      },
      'Sync now',
    );
    const reconnect = lapsed
      ? h(
          'button',
          {
            type: 'button',
            id: 'reconnect',
            class: 'primary',
            onclick: async () => {
              if ((await folderAccess(handle!, true)) === 'granted') {
                await send(api, { ink: 'reconnected' }).catch(() => {});
                d.connected?.();
              }
              await refresh();
            },
          },
          'Reconnect',
        )
      : null;
    const disconnect = h(
      'button',
      {
        type: 'button',
        id: 'disconnect',
        onclick: () => disconnectAsk(st, where, ask2, () => ask2.replaceChildren()),
      },
      'Disconnect',
    );
    const change = h(
      'button',
      {
        type: 'button',
        id: 'change-place',
        onclick: () => {
          showChoices = true;
          void refresh();
        },
      },
      'Use another place',
    );
    actions.append(...[reconnect, syncNow, disconnect, change].filter((x): x is HTMLButtonElement => !!x));
    box.append(state, actions, last, ask2);

    const p = st.problem;
    if (p && p !== 'locked') {
      const fix =
        p === 'expired' && dest.kind === 'cloud'
          ? () => void connectCloud(dest.provider, st, handle, ask2)
          : p === 'offline' || p === 'throttled' || p === 'server'
            ? () => syncNow.click()
            : undefined;
      box.append(problemLine(p, where, fix));
    }
    if (dest.since) {
      box.append(
        h(
          'div',
          { class: 'bar', id: 'copy-offer' },
          h('span', {}, `Notes from before the switch are still on this device. `),
          h(
            'button',
            {
              type: 'button',
              id: 'copy-all',
              onclick: async () => {
                const r = await ask(api, { ink: 'copyAll' });
                say(r.ok ? `Copied to ${where}` : `Not copied: ${r.problem ?? r.error}`);
                await refresh();
              },
            },
            'Copy my notes to the new place',
          ),
        ),
      );
    }
    if (st.lock !== 'unknown' || dest.kind === 'cloud') box.append(lockSection(st, where));
    if (d.kind === 'archive' || d.kind === 'native') {
      // Firefox and Safari keep the archive as a way to move notes by hand.
      const a = d.archive?.();
      if (a) box.append(h('p', { class: 'muted' }, 'Or move notes by hand with an archive file.'), a);
    }
    root.replaceChildren(box);
  }

  return refresh;
}

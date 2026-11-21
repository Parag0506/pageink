/**
 * First-run guide at the top of the options page. Opened once on install and
 * again from the Guide link. Short on purpose.
 */
import type { Api } from '../api';
import type { FolderKind } from '../background/folder';
import { NAME } from '../brand';
import { h } from './dom';

export interface WelcomeDeps {
  api: Api;
  kind: FolderKind;
  /** Close the guide. */
  done: () => void;
}

/**
 * The shortcut the browser assigned to the draw toggle, or null. Safari on
 * iPad has no commands API, and a reader can clear the shortcut, so there is
 * no default to fall back on.
 */
export async function drawShortcut(api: Api): Promise<string | null> {
  try {
    if (typeof api.commands?.getAll !== 'function') return null;
    const all = (await api.commands.getAll()) ?? [];
    return all.find((c) => c.name === 'toggle-draw')?.shortcut || null;
  } catch {
    // Some browsers do not list commands to extension pages.
    return null;
  }
}

/** The Draw step: the toolbar button, and the shortcut only when there is one. */
export function drawStep(key: string | null): { text: string; key?: string } {
  const text = `Click the ${NAME} button in the toolbar and choose Draw`;
  return key ? { text: `${text}, or press `, key } : { text: `${text}.` };
}

const item = (title: string, ...body: (string | Node)[]) =>
  h('li', {}, h('h3', {}, title), ...body.map((b) => (typeof b === 'string' ? h('p', {}, b) : b)));

export async function mountWelcome(root: HTMLElement, d: WelcomeDeps): Promise<void> {
  const step = drawStep(await drawShortcut(d.api));
  const backup =
    'Keep a copy in your own Google Drive or OneDrive, or in a folder on this device. One click, then sign in. Each page becomes one small file there, kept in sync by itself, on every device you connect.';
  root.replaceChildren(
    h(
      'div',
      { class: 'welcome' },
      h('img', { class: 'mark', src: '/icons/mark.svg', alt: '', width: 56, height: 56 }),
      h('h2', {}, `Welcome to ${NAME}`),
      h(
        'p',
        { class: 'lead' },
        'Write on any web page. Your notes come back when you return, on the same words.',
      ),
      h(
        'ol',
        { class: 'steps' },
        item(
          'Write with a pen',
          'Touch the page with a pen and write. No switch is needed. A finger still scrolls.',
        ),
        item(
          'No pen? Use Draw',
          step.key
            ? h('p', {}, step.text, h('kbd', { id: 'welcome-key' }, step.key), '.')
            : h('p', {}, step.text),
          'Then the mouse or one finger draws, and two fingers scroll. Press it again to stop.',
        ),
        item(
          'Moved notes',
          'If a page changes and a note loses its words, it waits in the moved notes tray on that page. Open the tray, choose Place, then tap where it belongs.',
        ),
        item(
          'Where notes live',
          'Notes stay in this browser on this device. Clearing a site’s data does not remove them. The Library lists every page you wrote on.',
        ),
        item('Back up and sync', backup),
        item(
          'Private by design',
          `${NAME} talks to nobody unless you connect a cloud. Then it talks only to that service. There is no account with us and no server of ours.`,
        ),
      ),
      h(
        'div',
        { class: 'bar' },
        h('button', { type: 'button', id: 'welcome-done', class: 'primary', onclick: d.done }, 'Got it'),
        h('a', { href: '#settings', class: 'button', id: 'welcome-settings' }, 'Choose where to keep a copy'),
      ),
    ),
  );
}

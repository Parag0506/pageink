/**
 * The parts of the connect screen that explain a sign-in: the note before the provider's
 * permission screen, the return address, and what went wrong with a Details block the
 * reader can copy. No network code here.
 */
import type { Api } from '../api';
import { NAME } from '../brand';
import { type AuthDetail, closedByReader, detailLines, detailText, explain } from '../connect/explain';
import { h, say } from './dom';

/**
 * The return address this build sends to the provider, from the browser itself. Undefined
 * until the sign-in permission is granted on Chrome and Edge. The address is never written
 * here by hand: the browser makes it, and no remote address lives outside the cloud code.
 */
export function returnAddress(api: Api): string | undefined {
  try {
    return api.identity?.getRedirectURL?.() || undefined;
  } catch {
    return undefined;
  }
}

const addressLine = (redirect: string) =>
  h(
    'p',
    { id: 'return-address-help' },
    'Return address used by this build: ',
    h('code', { class: 'return-address' }, redirect),
  );

/**
 * Shown under the cloud choices before any click, so the provider's screen is no surprise.
 * With no address yet, a button asks the browser for it (on Chrome and Edge this grants the
 * sign-in permission, which shows no prompt).
 */
export function consentNote(redirect?: string, reveal?: () => Promise<string | undefined>): HTMLElement {
  const box = h(
    'div',
    { class: 'help muted', id: 'consent-note' },
    h(
      'p',
      {},
      `Next you will see a screen from Google or Microsoft. It says ${NAME} can use files in its own folder. ${NAME} there means this extension on your device. Your notes go straight from your device to your own Drive or OneDrive. We have no servers and receive nothing.`,
    ),
    h('p', {}, 'It cannot see anything else in your Drive or OneDrive.'),
  );
  if (redirect) box.append(addressLine(redirect));
  else if (reveal) {
    const btn: HTMLButtonElement = h(
      'button',
      {
        type: 'button',
        class: 'link',
        id: 'show-return-address',
        onclick: async () => {
          const r = await reveal().catch(() => undefined);
          if (r) btn.replaceWith(addressLine(r));
          else say('The browser did not give the return address');
        },
      },
      'Show the return address to register',
    );
    box.append(btn);
  }
  return box;
}

/** A failed sign-in: one plain line, one next step, and the details to compare or copy. */
export function signInProblem(
  d: AuthDetail,
  place: string,
  redirect?: string,
  retry?: () => void,
): HTMLElement {
  const t = explain(d, place);
  const lines = detailLines(d, redirect);
  const text = detailText(d, redirect);
  const copy = h(
    'button',
    {
      type: 'button',
      id: 'copy-details',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          say('Details copied');
        } catch {
          say('Could not copy. Select the details and copy them by hand');
        }
      },
    },
    'Copy details',
  );
  const list = h('dl', { id: 'sign-in-details' });
  for (const [k, v] of lines) list.append(h('dt', {}, k), h('dd', {}, v));
  const addr = d.redirect ?? redirect;
  return h(
    'div',
    { class: 'problem', id: 'place-problem', role: 'alert' },
    h('span', { id: 'place-problem-text' }, `${t.text} `),
    retry
      ? h('button', { type: 'button', id: 'place-fix', onclick: retry }, t.next)
      : h('span', {}, `${t.next}.`),
    t.hint ? h('p', { id: 'place-hint' }, t.hint) : null,
    h(
      'details',
      { id: 'place-details' },
      h('summary', {}, 'Details'),
      list,
      closedByReader(d)
        ? h(
            'p',
            { class: 'muted' },
            'If the window showed an error instead of a sign-in page, compare the return address below with the one you registered.',
          )
        : null,
      addr
        ? h('p', {}, 'Return address used by this build: ', h('code', { class: 'return-address' }, addr))
        : null,
      copy,
    ),
  );
}

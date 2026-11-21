/**
 * Background message handling. The background only wakes for pages with ink,
 * for frames, for the popup and for the options page.
 */
import type { Api } from '../api';
import type { PlaceReply, ToBackground, ToContent, ToPlace, TopReply } from '../messages';
import { type Attention, BADGE } from './attention';
import type { Syncer } from './syncer';

export interface RouterDeps {
  api: Api;
  syncer: Syncer;
  /** Work out what the action should ask for, show it, and return it. */
  attention?: () => Promise<Attention>;
  /** Record what the reader did with the backup prompt. */
  nudge?: (act: 'dismiss' | 'export' | 'chosen') => Promise<void>;
  /** A page with ink reported in, from this address. */
  onPage?: (url: string) => void;
  /** The connect screen's messages. */
  place?: (m: ToPlace) => Promise<PlaceReply>;
  /** Extra handlers, used by the e2e build. */
  extra?: (m: { ink: string }) => Promise<unknown> | undefined;
}

type Sender = chrome.runtime.MessageSender;

const toTab = (api: Api, tabId: number, m: ToContent, frameId?: number) =>
  (frameId === undefined
    ? api.tabs.sendMessage(tabId, m)
    : api.tabs.sendMessage(tabId, m, { frameId })) as Promise<unknown>;

/** Set draw in the top frame of a tab. Missing stubs (browser pages) are ignored. */
export const drawIn = (api: Api, tabId: number, on?: boolean) =>
  toTab(api, tabId, on === undefined ? { ink: 'draw' } : { ink: 'draw', on }, 0).catch(() => undefined);

/** Number of notes on the action button for one tab. Zero clears it. */
export async function setBadge(api: Api, tabId: number, n: number): Promise<void> {
  const action = api.action;
  if (!action?.setBadgeText) return;
  const text = n > 0 ? (n > 99 ? '99+' : String(n)) : '';
  try {
    await action.setBadgeText({ tabId, text });
    if (text) {
      await action.setBadgeBackgroundColor?.({ tabId, color: BADGE.note });
      await action.setBadgeTextColor?.({ tabId, color: BADGE.text });
    }
  } catch {
    // The tab closed meanwhile.
  }
}

/** The extension's own pages that may change the place, the lock and the settings. */
const OWN_PAGES = ['popup.html', 'options.html'];

/** The path of an extension address, without query or fragment, or null when it is not one. */
function extensionPath(api: Api, url: string | undefined): string | null {
  if (!url) return null;
  let base: string;
  try {
    base = api.runtime.getURL('/');
  } catch {
    return null;
  }
  if (!url.startsWith(base)) return null;
  return url.slice(base.length).split(/[?#]/)[0]!;
}

/**
 * True only for the popup or the options page itself, at the top of its window or tab. Not a
 * content script, and not another extension page such as pdf.html, which any site may show in
 * a frame.
 */
export function ownPage(api: Api, s: Sender): boolean {
  const path = extensionPath(api, s.url);
  if (path === null || !OWN_PAGES.includes(path)) return false;
  if (s.tab) {
    // Inside a tab: the tab's own top frame, showing that page.
    if ((s.frameId ?? 0) !== 0) return false;
    const top = extensionPath(api, s.tab.url);
    if (s.tab.url !== undefined && (top === null || !OWN_PAGES.includes(top))) return false;
  }
  return true;
}

/** True when the sender is another extension page, such as pdf.html. */
const otherExtensionPage = (api: Api, s: Sender): boolean => {
  const path = extensionPath(api, s.url);
  return path !== null && !OWN_PAGES.includes(path);
};

/** True when the sender is the top frame of the active tab of its window. */
async function activeTop(api: Api, s: Sender): Promise<boolean> {
  const tab = s.tab;
  if (!tab || tab.id === undefined || (s.frameId ?? 0) !== 0 || tab.active === false) return false;
  try {
    const [now] = await api.tabs.query({ active: true, windowId: tab.windowId });
    return now?.id === tab.id;
  } catch {
    return false;
  }
}

const NOT_ALLOWED = { error: 'not allowed' };

export function route(d: RouterDeps, m: ToBackground, s: Sender): Promise<unknown> | undefined {
  const { api } = d;
  const tabId = s.tab?.id;
  // pdf.html can be shown in a frame by any site. It needs the picture of its tab, nothing else.
  if (otherExtensionPage(api, s) && m.ink !== 'capture') return undefined;
  switch (m.ink) {
    case 'top': {
      const r: TopReply = { url: s.tab?.url ?? '', frameId: s.frameId ?? 0 };
      return Promise.resolve(r);
    }
    case 'framePath':
      if (tabId === undefined) return Promise.resolve(undefined);
      return toTab(api, tabId, { ink: 'framePath', frameId: m.frameId }).catch(() => undefined);
    case 'wakeFrames':
      if (tabId === undefined) return Promise.resolve(undefined);
      return toTab(api, tabId, { ink: 'wake' }).catch(() => undefined);
    case 'capture': {
      // Safari on iPad may have no captureVisibleTab. Then there is no picture, not an error.
      // Only for the top frame of the active tab that asks: a frame never gets a picture of
      // the page around it, and a tab in the background never gets one of another tab.
      const tab = s.tab;
      if (!tab || typeof api.tabs.captureVisibleTab !== 'function') return Promise.resolve(undefined);
      return activeTop(api, s)
        .then((ok) => (ok ? api.tabs.captureVisibleTab(tab.windowId, { format: 'png' }) : undefined))
        .catch(() => undefined);
    }
    case 'draw':
      // From the popup only: a page never switches draw on in another tab.
      if (!ownPage(api, s)) return Promise.resolve(NOT_ALLOWED);
      return drawIn(api, m.tabId, m.on);
    case 'badge':
      if (tabId === undefined) return Promise.resolve(undefined);
      if (m.n > 0 && s.tab?.url && (s.frameId ?? 0) === 0) d.onPage?.(s.tab.url);
      return setBadge(api, tabId, m.n);
    case 'sync':
      if (!ownPage(api, s)) return Promise.resolve(NOT_ALLOWED);
      return d.syncer.full();
    case 'attention':
      if (!ownPage(api, s)) return Promise.resolve(NOT_ALLOWED);
      return d.attention?.() ?? Promise.resolve(undefined);
    case 'reconnected':
      if (!ownPage(api, s)) return Promise.resolve(NOT_ALLOWED);
      return d.syncer.full().then(async (r) => {
        await d.attention?.();
        return r;
      });
    case 'nudge':
      if (!ownPage(api, s)) return Promise.resolve(NOT_ALLOWED);
      return (d.nudge?.(m.act) ?? Promise.resolve()).then(() => d.attention?.());
    case 'place':
    case 'connect':
    case 'useFolder':
    case 'disconnect':
    case 'copyAll':
    case 'lock':
      // Only the popup and the options page may, never a content script or a framed page.
      if (!ownPage(api, s)) return Promise.resolve(NOT_ALLOWED);
      return (d.place?.(m) ?? Promise.resolve({ error: 'none' })).then(async (r) => {
        if (m.ink !== 'place') await d.attention?.();
        return r;
      });
    default:
      return d.extra?.(m);
  }
}

export function listen(d: RouterDeps): void {
  d.api.runtime.onMessage.addListener((m: ToBackground, s: Sender, reply: (r?: unknown) => void) => {
    if (!m || typeof m.ink !== 'string') return;
    // A handler that throws must still answer, or the sender waits for a reply that never comes.
    let p: Promise<unknown> | undefined;
    try {
      p = route(d, m, s);
    } catch (e) {
      p = Promise.reject(e);
    }
    if (!p) return;
    p.then(reply, (e) => reply({ error: String(e) }));
    return true;
  });
  // Safari on iPad has no keyboard commands. The draw toggle is in the popup there.
  d.api.commands?.onCommand?.addListener(async (name: string, tab?: chrome.tabs.Tab) => {
    if (name !== 'toggle-draw') return;
    const id = tab?.id ?? (await d.api.tabs.query({ active: true, currentWindow: true }))[0]?.id;
    if (id !== undefined) await drawIn(d.api, id);
  });
}

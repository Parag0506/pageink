/**
 * Site access. The extension needs every website so ink comes back by itself. A reader may
 * leave Safari's "All Websites" on Ask, or limit a Chromium extension to some sites. Then the
 * stub never runs on the page, the pen does not write, and nothing says why. The popup checks
 * and shows one line that fixes it from a tap, with the permission request where the browser
 * has one.
 */
import type { Api } from '../api';
import { NAME } from '../brand';

// Every website. Safari keeps "All Websites: Allow" as the pattern below and answers false for
// <all_urls>, which also covers file addresses, so the check asks for web pages only.
export const ALL_SITES: chrome.permissions.Permissions = { origins: ['*://*/*'] };

export type Access = 'ok' | 'missing' | 'unknown';

/** The match pattern for a page's site, or null for pages no extension may run on. */
export function sitePattern(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Whether the extension may run on every website, and on the page in this tab. Missing when
 * either is not granted. Unknown when the browser has no way to tell.
 */
export async function siteAccess(api: Api, url: string | undefined): Promise<Access> {
  const p = api.permissions;
  if (!p?.contains) return 'unknown';
  try {
    const site = sitePattern(url);
    const [all, here] = await Promise.all([
      p.contains(ALL_SITES),
      site ? p.contains({ origins: [site] }) : Promise.resolve(true),
    ]);
    return all && here ? 'ok' : 'missing';
  } catch {
    return 'unknown';
  }
}

/** The line the popup shows, in the browser's own words for the choice. */
export function accessText(target: string): { ask: string; done: string; manual: string } {
  if (target === 'safari') {
    return {
      ask: `${NAME} needs permission for websites. Tap this, then choose Always Allow on Every Website.`,
      done: 'Thank you. Reload this page to write on it.',
      manual: `Open Settings, then Apps, Safari, Extensions, ${NAME}. Under Permissions, set All Websites to Allow.`,
    };
  }
  return {
    ask: `${NAME} needs permission for websites. Click this, then choose Allow.`,
    done: 'Thank you. Reload this page to write on it.',
    manual: `Open this browser's extension settings, choose ${NAME}, and let it read and change all sites.`,
  };
}

/** Asks for every website. Must run from the reader's tap or click. False when not granted. */
export async function askAccess(api: Api): Promise<boolean> {
  const p = api.permissions;
  if (!p?.request) return false;
  try {
    return !!(await p.request(ALL_SITES));
  } catch {
    return false;
  }
}

export interface AccessView {
  root: HTMLElement;
  button: HTMLButtonElement;
}

/**
 * Shows the line when access is missing. A tap asks for every website. When the browser does
 * not ask, or the reader says no, the line says where the switch is.
 */
export async function showAccess(
  v: AccessView,
  api: Api,
  url: string | undefined,
  target: string,
): Promise<Access> {
  const a = await siteAccess(api, url);
  v.root.hidden = a !== 'missing';
  if (a !== 'missing') return a;
  const t = accessText(target);
  v.button.textContent = t.ask;
  v.button.disabled = false;
  v.button.onclick = async () => {
    v.button.disabled = true;
    const ok = await askAccess(api);
    v.button.textContent = ok ? t.done : t.manual;
    v.button.disabled = ok;
  };
  return a;
}

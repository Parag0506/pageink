/**
 * The popup's site access line (access.ts): it shows when the extension may not run on every
 * website or on this page, asks from the tap, and says where the switch is when the browser
 * does not ask.
 */
import { describe, expect, test } from 'vitest';
import type { Api } from '../api';
import { NAME } from '../brand';
import { ALL_SITES, accessText, askAccess, showAccess, siteAccess, sitePattern } from './access';

type Perms = chrome.permissions.Permissions;

function fakeApi(
  o: { granted?: string[]; request?: boolean | 'throw' | 'none'; contains?: 'none' | 'throw' } = {},
) {
  const granted = new Set(o.granted ?? []);
  const asked: Perms[] = [];
  const permissions: Record<string, unknown> = {};
  if (o.contains !== 'none') {
    permissions.contains = async (p: Perms) => {
      if (o.contains === 'throw') throw new Error('no');
      return (p.origins ?? []).every((x) => granted.has('*://*/*') || granted.has(x));
    };
  }
  if (o.request !== 'none') {
    permissions.request = async (p: Perms) => {
      asked.push(p);
      if (o.request === 'throw') throw new Error('not from a gesture');
      if (o.request) for (const x of p.origins ?? []) granted.add(x);
      return !!o.request;
    };
  }
  return { api: { permissions } as unknown as Api, asked };
}

const view = () => ({
  root: { hidden: true } as HTMLElement,
  button: { textContent: '', disabled: false } as HTMLButtonElement,
});

describe('site pattern', () => {
  test('web pages have one; browser pages and bad addresses do not', () => {
    expect(sitePattern('https://a.test/x?y=1')).toBe('https://a.test/*');
    expect(sitePattern('http://127.0.0.1:8080/p')).toBe('http://127.0.0.1/*');
    expect(sitePattern('about:blank')).toBeNull();
    expect(sitePattern('safari-web-extension://abc/pdf.html')).toBeNull();
    expect(sitePattern(undefined)).toBeNull();
    expect(sitePattern('not an address')).toBeNull();
  });
});

describe('access', () => {
  test('ok with every website', async () => {
    expect(await siteAccess(fakeApi({ granted: ['*://*/*'] }).api, 'https://a.test/')).toBe('ok');
  });

  test('missing when websites are on Ask, even where this one site was allowed', async () => {
    expect(await siteAccess(fakeApi().api, 'https://a.test/')).toBe('missing');
    expect(await siteAccess(fakeApi({ granted: ['https://a.test/*'] }).api, 'https://a.test/')).toBe(
      'missing',
    );
    // The tab's address is hidden without access. The check for every website still tells.
    expect(await siteAccess(fakeApi().api, undefined)).toBe('missing');
  });

  test('unknown when the browser cannot tell', async () => {
    expect(await siteAccess(fakeApi({ contains: 'none' }).api, 'https://a.test/')).toBe('unknown');
    expect(await siteAccess(fakeApi({ contains: 'throw' }).api, 'https://a.test/')).toBe('unknown');
  });

  test('asks for every website, and is false when refused or not possible', async () => {
    const yes = fakeApi({ request: true });
    expect(await askAccess(yes.api)).toBe(true);
    expect(yes.asked).toEqual([ALL_SITES]);
    expect(await askAccess(fakeApi({ request: false }).api)).toBe(false);
    expect(await askAccess(fakeApi({ request: 'throw' }).api)).toBe(false);
    expect(await askAccess(fakeApi({ request: 'none' }).api)).toBe(false);
  });
});

describe('the popup line', () => {
  test('Safari: the words name the choice to tap', () => {
    expect(accessText('safari').ask).toBe(
      `${NAME} needs permission for websites. Tap this, then choose Always Allow on Every Website.`,
    );
    expect(accessText('safari').manual).toContain('All Websites to Allow');
    expect(accessText('chrome').ask).toContain('Click this');
    for (const t of ['safari', 'chrome', 'firefox']) {
      for (const s of Object.values(accessText(t))) expect(s).not.toMatch(/—/);
    }
  });

  test('hidden when access is there', async () => {
    const v = view();
    expect(await showAccess(v, fakeApi({ granted: ['*://*/*'] }).api, 'https://a.test/', 'safari')).toBe(
      'ok',
    );
    expect(v.root.hidden).toBe(true);
  });

  test('shown when missing; a tap that is granted thanks the reader', async () => {
    const v = view();
    const f = fakeApi({ request: true });
    await showAccess(v, f.api, 'https://a.test/', 'safari');
    expect(v.root.hidden).toBe(false);
    expect(v.button.textContent).toBe(accessText('safari').ask);
    await (v.button.onclick as () => Promise<void>)();
    expect(f.asked).toEqual([ALL_SITES]);
    expect(v.button.textContent).toBe(accessText('safari').done);
    expect(await siteAccess(f.api, 'https://a.test/')).toBe('ok');
  });

  test('a tap that is refused, or a browser that cannot ask, says where the switch is', async () => {
    for (const request of [false, 'none'] as const) {
      const v = view();
      await showAccess(v, fakeApi({ request }).api, 'https://a.test/', 'safari');
      await (v.button.onclick as () => Promise<void>)();
      expect(v.button.textContent).toBe(accessText('safari').manual);
      expect(v.button.disabled).toBe(false);
    }
  });
});

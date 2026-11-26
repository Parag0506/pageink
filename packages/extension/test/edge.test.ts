/**
 * Edge Add-ons takes Chromium MV3 packages, but its review rejects a few keys
 * that only make sense on the Chrome Web Store or on ChromeOS. These are the
 * checks that can be made offline against the built Edge manifest.
 */
import { describe, expect, test } from 'vitest';
import { NAME } from '../src/brand';
import { builds, manifest } from './builds';

const edge = builds().filter((b) => b.target === 'edge' && !b.test);

/** Every top-level key the Edge build may carry. Anything new is checked by hand first. */
const KEYS = [
  'manifest_version',
  'name',
  'short_name',
  'description',
  'version',
  'icons',
  'permissions',
  // identity, asked for when the reader connects a cloud.
  'optional_permissions',
  'host_permissions',
  'content_security_policy',
  'content_scripts',
  'web_accessible_resources',
  'commands',
  'action',
  'background',
  'options_ui',
];

/** Keys Edge refuses or ignores in a store upload. */
const REFUSED = [
  'update_url',
  'key',
  'oauth2',
  'minimum_chrome_version',
  'chrome_settings_overrides',
  'storage',
];

/** Permissions that exist only in Chrome or on ChromeOS. */
const CHROME_ONLY = [
  'enterprise.deviceAttributes',
  'enterprise.hardwarePlatform',
  'enterprise.networkingAttributes',
  'enterprise.platformKeys',
  'fileSystemProvider',
  'platformKeys',
  'printingMetrics',
  'wallpaper',
  'loginState',
  'certificateProvider',
  'documentScan',
  'vpnProvider',
  'gcm',
];

// identity is not here: Edge has launchWebAuthFlow, which is all the cloud sign-in uses.
// Edge lacks only getAuthToken, which needs a Google account in the browser.

test('there is an Edge build to check', () => {
  expect(edge.length).toBeGreaterThan(0);
});

describe.each(edge.map((b) => [b.name, b] as const))('%s manifest', (_n, b) => {
  const m = manifest(b);

  test('is MV3 with only the keys we expect', () => {
    expect(m.manifest_version).toBe(3);
    expect(Object.keys(m).sort()).toEqual([...KEYS].sort());
    for (const k of REFUSED) expect(m).not.toHaveProperty(k);
  });

  test('asks for no Chrome-only permission', () => {
    const perms = [...((m.permissions as string[]) ?? []), ...((m.optional_permissions as string[]) ?? [])];
    for (const p of perms) expect(CHROME_ONLY).not.toContain(p);
  });

  test('name, description and icons fit the store', () => {
    const name = m.name as string;
    const desc = m.description as string;
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(45);
    expect(desc.length).toBeLessThanOrEqual(132);
    expect(Object.keys(m.icons as object)).toEqual(expect.arrayContaining(['16', '48', '128']));
    // Placeholders from the pages never reach the manifest.
    expect(JSON.stringify(m)).not.toMatch(/%[A-Z]+%/);
    // The toolbar shows the short name, not the longer store name.
    expect(m.short_name).toBe(NAME);
    expect((m.action as { default_title: string }).default_title).toBe(NAME);
  });

  test('no address points at the Chrome Web Store or a Chrome page', () => {
    expect(JSON.stringify(m)).not.toMatch(/chrome\.google\.com|chromewebstore|chrome:\/\//);
  });
});

/**
 * Build settings per browser target. The manifest policy lives here so the
 * config and the bundle test read the same intent, while the test keeps its
 * own literal copy to catch drift.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESCRIPTION, FIREFOX_ID, NAME } from '../src/brand.ts';
import { toolbarIcons } from './icons.ts';

export type Target = 'chrome' | 'edge' | 'firefox' | 'safari';

const here = dirname(fileURLToPath(import.meta.url));
export const pkgDir = resolve(here, '..');

/**
 * The test build (INK_CLOUD_FAKE=1) talks to a local fake of each cloud. It goes to its own
 * folder (.output/test-<target>-mv3), says so in its name, and cannot be zipped, so it never
 * reaches a store. A test checks that the release builds hold no trace of it.
 */
export const isFake = (): boolean => process.env.INK_CLOUD_FAKE === '1';

/**
 * The cloud addresses the background may connect to: Google's token and file addresses,
 * Microsoft's token address and Graph, and the hosts Graph sends file downloads to. The
 * sign-in pages (accounts.google.com, login.microsoftonline.com/.../authorize) open in the
 * browser's sign-in window, which this policy does not govern. Checked in Chromium: a
 * connect-src in this policy does govern the service worker's fetch.
 */
export const CLOUD_CONNECT = [
  'https://oauth2.googleapis.com',
  'https://www.googleapis.com',
  'https://login.microsoftonline.com',
  'https://graph.microsoft.com',
  'https://*.files.1drv.com',
  'https://*.sharepoint.com',
  'https://my.microsoftpersonalcontent.com',
];

/** Where the test build's fake providers listen. */
export const FAKE_CONNECT = 'http://127.0.0.1:*';

/** Extension pages: no remote code; network only to the cloud addresses, and none on Safari. */
export function extensionCsp(t: Target, fake = isFake()): string {
  const connect = t === 'safari' ? ["'none'"] : [...CLOUD_CONNECT, ...(fake ? [FAKE_CONNECT] : [])];
  return (
    `default-src 'self'; script-src 'self'; object-src 'none'; connect-src ${connect.join(' ')}; ` +
    "img-src 'self' data: blob:; style-src 'self'; font-src 'self'; worker-src 'self'; " +
    "frame-src 'self'; base-uri 'none'; form-action 'none'"
  );
}

export const PERMISSIONS = ['storage', 'unlimitedStorage'];

/**
 * identity opens the providers' sign-in window. Chrome and Edge ask for it only when the
 * reader clicks a cloud (optional_permissions; it shows no prompt). Firefox does not allow
 * identity as an optional permission, so it is listed, and it shows no warning on install.
 * Safari has no identity API: its app signs in.
 *
 * Every build has `scripting`: the background registers the viewer as a content script on
 * hosts that have ink, and injects the viewer and the tools elsewhere when they are needed,
 * so no content script file has to be web accessible. Safari has had the API since 16.4
 * (registered scripts) and 15.4 (injection); its floor below is 17.
 */
export function permissionsFor(t: Target): { permissions: string[]; optional?: string[] } {
  const base = [...PERMISSIONS, 'scripting'];
  if (t === 'safari') return { permissions: [...base, 'nativeMessaging'] };
  if (t === 'firefox') return { permissions: [...base, 'identity'] };
  return { permissions: base, optional: ['identity'] };
}

/**
 * Builds for the tests (INK_NO_LOCAL_IDS=1, and every fake build) leave out the git-ignored
 * cloud-ids.local.json, so the tests see the same build on every machine.
 */
export const useLocalIds = (fake = isFake()): boolean => !fake && process.env.INK_NO_LOCAL_IDS !== '1';

/** Client ids: cloud-ids.json, overridden by the git-ignored cloud-ids.local.json. */
export function cloudIds(fake = isFake()): { google: string; microsoft: string } {
  const read = (f: string) => {
    const p = resolve(pkgDir, f);
    if (!existsSync(p)) return {};
    const v = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    return Object.fromEntries(
      ['google', 'microsoft'].filter((k) => typeof v[k] === 'string' && v[k]).map((k) => [k, String(v[k])]),
    );
  };
  const local = useLocalIds(fake) ? read('cloud-ids.local.json') : {};
  const ids = { google: '', microsoft: '', ...read('cloud-ids.json'), ...local };
  if (fake) {
    ids.google ||= 'fake-google-client';
    ids.microsoft ||= 'fake-microsoft-client';
  }
  return ids;
}

/**
 * The public half of the development key (scripts/dev-key.mjs), only with INK_DEV_KEY=1.
 * It keeps the extension id the same on every machine, so the sign-in addresses registered
 * with Google and Microsoft keep working in development. Never in a release build or a store
 * zip: the stores set the id.
 */
export function devKey(): string | undefined {
  const p = resolve(pkgDir, 'dev-key.pub');
  if (process.env.INK_DEV_KEY !== '1' || process.argv.includes('zip')) return undefined;
  if (!existsSync(p)) throw new Error('INK_DEV_KEY=1 needs dev-key.pub. Run node scripts/dev-key.mjs first.');
  return readFileSync(p, 'utf8').trim() || undefined;
}

/** The iPad build blocks the first Pencil touch from scrolling before tools load. */
export const penReadyDefault = (t: Target): boolean => t === 'safari';

export const chromium = (t: Target): boolean => t === 'chrome' || t === 'edge';

/**
 * The oldest browser each target supports. Firefox's is in the manifest below.
 * Safari's follows the app's deployment target (iOS 17, macOS 14): Safari 17 has every
 * scripting call the extension makes (docs/CONTRACT.md 4.2). Chrome 119
 * is the first with Promise.withResolvers, which the legacy PDF.js build uses
 * without a polyfill. The Edge store refuses minimum_chrome_version, so Edge
 * states no floor in its manifest; the same number is the policy for it.
 */
export const MIN_VERSION: Record<Target, number> = { chrome: 119, edge: 119, firefox: 140, safari: 17 };

/**
 * The bench builds with `wxt build --mode bench`, into .output/<target>-mv3-bench. Only that
 * build keeps the performance marks and measures the bench reads. Release builds have none.
 */
export const isBench = (mode?: string): boolean => mode === 'bench';

/** Folder under .output for a diagnostics build, apart from the builds that ship. */
export const DIAG_DIR = 'diag';
/** File at the root of a diagnostics build. The Release build of the app refuses a bundle with it. */
export const DIAG_FILE = 'DIAGNOSTICS.txt';

/** Loopback, private and link-local IPv4 addresses, and names on the local network. */
const LOCAL_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|[\w-]+\.local)$/;

/**
 * The origin of the device check page (apple/device) when this is a diagnostics build, else
 * null. A diagnostics build is made only when INK_DIAG_ORIGIN is set, only for Safari, only
 * for a plain http page on this network, and never with INK_RELEASE=1. Store zips refuse it
 * (wxt.config.ts) and so does the Release build of the app (apple/sync-extension.sh).
 */
export function diagOrigin(t: Target, env: Record<string, string | undefined> = process.env): string | null {
  const v = env.INK_DIAG_ORIGIN;
  if (!v) return null;
  if (env.INK_RELEASE === '1')
    throw new Error('A release build cannot carry diagnostics. Unset INK_DIAG_ORIGIN.');
  if (t !== 'safari') throw new Error('Diagnostics builds are made for Safari only.');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`INK_DIAG_ORIGIN is not an address: ${v}`);
  }
  if (u.protocol !== 'http:' || !LOCAL_HOST.test(u.hostname) || u.origin !== v.replace(/\/$/, '')) {
    throw new Error(
      `INK_DIAG_ORIGIN must be a plain http origin on this network, such as http://192.168.1.5:8790. Got ${v}`,
    );
  }
  return u.origin;
}

export function defines(t: Target, mode?: string): Record<string, string> {
  const diag = diagOrigin(t);
  return {
    __INK_TARGET__: JSON.stringify(t),
    __INK_PEN_READY__: JSON.stringify(penReadyDefault(t)),
    __INK_BENCH__: JSON.stringify(isBench(mode)),
    __INK_CLOUD_IDS__: JSON.stringify(t === 'safari' ? { google: '', microsoft: '' } : cloudIds()),
    __INK_CLOUD_FAKE__: JSON.stringify(isFake()),
    __INK_DIAG__: JSON.stringify(diag !== null),
    __INK_DIAG_ORIGIN__: JSON.stringify(diag ?? ''),
  };
}

/**
 * Only the PDF page, which the PDF chunk shows in a frame. Content scripts are
 * registered or injected by the background, never loaded by address, so a page
 * cannot find the extension by probing for them. Chromium gets use_dynamic_url,
 * so the page's address changes every session. Firefox and Safari do not know it.
 */
export function webAccessible(t: Target): Record<string, unknown>[] {
  const all = ['<all_urls>'];
  if (!chromium(t)) return [{ resources: ['pdf.html'], matches: all }];
  return [{ resources: ['pdf.html'], matches: all, use_dynamic_url: true }];
}

/** Manifest fields beyond what WXT derives from the entrypoints. */
export function manifestFor(t: Target): Record<string, unknown> {
  const war = webAccessible(t);
  const perms = permissionsFor(t);
  const m: Record<string, unknown> = {
    name: isFake() ? `${NAME} (test build)` : NAME,
    description: DESCRIPTION,
    permissions: perms.permissions,
    ...(perms.optional ? { optional_permissions: perms.optional } : {}),
    host_permissions: ['<all_urls>'],
    content_security_policy: { extension_pages: extensionCsp(t) },
    content_scripts: [
      { matches: ['<all_urls>'], js: ['stub.js'], run_at: 'document_start', all_frames: true },
    ],
    web_accessible_resources: war,
    commands: {
      'toggle-draw': {
        suggested_key: { default: 'Alt+Shift+D', mac: 'Alt+Shift+D' },
        description: 'Draw on this page',
      },
    },
    action: { default_title: NAME, default_icon: toolbarIcons(t) },
  };
  if (t === 'chrome') m.minimum_chrome_version = String(MIN_VERSION.chrome);
  const key = chromium(t) && !isFake() ? devKey() : undefined;
  if (key) m.key = key;
  if (t === 'firefox') {
    m.browser_specific_settings = {
      // data_collection_permissions arrived in Firefox 140 and Firefox for Android 142.
      gecko: {
        id: FIREFOX_ID,
        strict_min_version: `${MIN_VERSION.firefox}.0`,
        // Nothing leaves the device unless the reader connects their own Google Drive or
        // OneDrive. Then page addresses and the words notes sit on go there, and only there.
        // Asked for at that click (src/ui/connect.ts).
        data_collection_permissions: { required: ['none'], optional: ['browsingActivity', 'websiteContent'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    };
  }
  return m;
}

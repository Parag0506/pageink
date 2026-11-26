/**
 * DESIGN 9 and CONTRACT 2: the built extension talks to nobody unless the reader
 * connects a cloud, and then only to that provider's sign-in and file addresses.
 * Parses every script, style sheet and page of every build (scan.ts), then
 * checks the manifest exactly. Each accepted finding is in network-allow.json
 * with an exact count. Every network call and remote address outside the PDF
 * read lives in cloud.js, pinned to the hosts in PRIVACY.md.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { type Hit, scanFile } from '../../../scripts/netscan';
import { NO_NET_TEXT } from '../build/pdfjs';
import { RATE_URL } from '../build/targets';
import { builds, diagBuild, files, globToRegExp, manifest, pkg, read } from './builds';

type Allow = {
  file: string;
  rule: Hit['rule'];
  detail: string;
  count: number;
  pin?: 'own-address';
  targets?: string[];
  /** A store page the popup opens in a new tab when the reader clicks Rate. Never fetched. */
  kind?: 'store-link';
  reason: string;
};
const allow: Allow[] = JSON.parse(readFileSync(join(pkg, 'network-allow.json'), 'utf8')).entries;

/** Findings in one build that no entry accepts, and the entries that were used. */
function check(hits: { file: string; hit: Hit }[], entries: Allow[]) {
  const groups = new Map<string, { file: string; hit: Hit; all: Hit[] }>();
  for (const { file, hit } of hits) {
    const k = `${file}\0${hit.rule}\0${hit.detail}`;
    const g = groups.get(k);
    if (g) g.all.push(hit);
    else groups.set(k, { file, hit, all: [hit] });
  }
  const bad: string[] = [];
  const used = new Set<Allow>();
  for (const { file, hit, all } of groups.values()) {
    const e = entries.find(
      (a) => a.rule === hit.rule && a.detail === hit.detail && globToRegExp(a.file).test(file),
    );
    const where = `${file}: ${hit.rule} ${hit.detail}`;
    if (!e) bad.push(where);
    else if (all.length !== e.count) bad.push(`${where} appears ${all.length} times, allowed ${e.count}`);
    else if (e.pin === 'own-address' && !all.every((h) => h.own === true)) {
      bad.push(`${where} does not read the page's own address`);
    } else used.add(e);
  }
  return { bad, used };
}

const all = builds();
const prod = all.filter((b) => !b.test);

/** The hosts the cloud code may name. PRIVACY.md lists the same five. */
const PINNED = [
  'accounts.google.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'login.microsoftonline.com',
  'graph.microsoft.com',
];
const forTarget = (t: string) => allow.filter((a) => !a.targets || a.targets.includes(t));

/** The manifest policy, written out again here so a change to build/targets.ts must be made twice. */
const CLOUD_CONNECT =
  'https://oauth2.googleapis.com https://www.googleapis.com https://login.microsoftonline.com ' +
  'https://graph.microsoft.com https://*.files.1drv.com https://*.sharepoint.com ' +
  'https://my.microsoftpersonalcontent.com';
const csp = (connect: string) =>
  `default-src 'self'; script-src 'self'; object-src 'none'; connect-src ${connect}; ` +
  "img-src 'self' data: blob:; style-src 'self'; font-src 'self'; worker-src 'self'; " +
  "frame-src 'self'; base-uri 'none'; form-action 'none'";

test('every target has been built', () => {
  expect(prod.map((b) => b.target).sort()).toEqual(['chrome', 'edge', 'firefox', 'safari']);
});

test('a finding outside the list, a wrong count or a moved PDF read fails', () => {
  const pdf = allow[0]!;
  const read = (own: boolean): { file: string; hit: Hit } => ({
    file: 'content/pdf.js',
    hit: { rule: 'api', detail: 'fetch', own },
  });
  expect(check([read(true)], [pdf]).bad).toEqual([]);
  expect(check([read(false)], [pdf]).bad).toHaveLength(1);
  expect(check([read(true), read(true)], [pdf]).bad).toHaveLength(1);
  expect(check([{ file: 'stub.js', hit: read(true).hit }], [pdf]).bad).toHaveLength(1);
});

/** Builds that never ship but run on real browsers: the bench builds and a diagnostics build. */
const extra = [...builds(true), ...(diagBuild() ? [diagBuild()!] : [])];

describe.each(all.map((b) => [b.name, b] as const))('%s', (_name, b) => {
  test('no network calls and no remote addresses', () => {
    const hits: { file: string; hit: Hit }[] = [];
    for (const f of files(b.dir)) {
      if (f === 'manifest.json') continue;
      for (const hit of scanFile(f, read(b.dir, f))) hits.push({ file: f, hit });
    }
    const { bad, used } = check(hits, forTarget(b.target));
    expect(bad).toEqual([]);
    // The PDF read is in content/pdf.js. Safari keeps PDFs in its own viewer and has no such file.
    const want = forTarget(b.target).filter((a) => b.target !== 'safari' || a.file !== 'content/pdf.js');
    expect([...used].map((a) => a.file).sort()).toEqual(want.map((a) => a.file).sort());
  });

  test('PDF.js is in the build with its network code removed', () => {
    const worker = read(b.dir, 'pdf/worker.js');
    expect(worker).toContain(NO_NET_TEXT);
    expect(worker.length).toBeGreaterThan(500_000);
    const page = files(b.dir).filter(
      (f) => f.startsWith('chunks/') && read(b.dir, f).includes('GlobalWorkerOptions'),
    );
    expect(page.length).toBe(1);
    expect(read(b.dir, page[0]!)).toContain(NO_NET_TEXT);
  });

  test('manifest permissions, host access and CSP are exactly as designed', () => {
    const m = manifest(b);
    // Every build registers and injects its content scripts (`scripting`).
    const perms =
      b.target === 'safari'
        ? ['storage', 'unlimitedStorage', 'scripting', 'nativeMessaging']
        : b.target === 'firefox'
          ? ['storage', 'unlimitedStorage', 'scripting', 'identity']
          : ['storage', 'unlimitedStorage', 'scripting'];
    expect(m.permissions).toEqual(perms);
    expect(m.host_permissions).toEqual(['<all_urls>']);
    // Chrome and Edge ask for identity when the reader clicks a cloud. Firefox cannot.
    expect(m.optional_permissions).toEqual(
      b.target === 'chrome' || b.target === 'edge' ? ['identity'] : undefined,
    );
    expect(m.optional_host_permissions).toBeUndefined();
    const connect =
      b.target === 'safari' ? "'none'" : b.test ? `${CLOUD_CONNECT} http://127.0.0.1:*` : CLOUD_CONNECT;
    expect(m.content_security_policy).toEqual({ extension_pages: csp(connect) });
    expect(m.content_scripts).toEqual([
      { matches: ['<all_urls>'], js: ['stub.js'], run_at: 'document_start', all_frames: true },
    ]);
    expect(Object.keys(m.commands as object)).toEqual(['toggle-draw']);
  });

  test('the only web accessible resource is the PDF page, at a per-session address where supported', () => {
    const war = manifest(b).web_accessible_resources;
    const all = ['<all_urls>'];
    const expected =
      b.target === 'chrome' || b.target === 'edge'
        ? [{ resources: ['pdf.html'], matches: all, use_dynamic_url: true }]
        : [{ resources: ['pdf.html'], matches: all }];
    expect(war).toEqual(expected);
  });
});

test('the bench build has been built', () => {
  expect(builds(true).map((b) => b.target)).toContain('chrome');
});

describe.each(extra.map((b) => [b.name, b] as const))('%s, which never ships', (_name, b) => {
  test('has the same network findings as the release build of its target', () => {
    // A diagnostics build names the check page's origin, as the target of postMessage only.
    const note = b.name === 'diag' ? read(b.dir, 'DIAGNOSTICS.txt') : '';
    const origin = /reports to (http:\/\/\S+?)\. /.exec(note)?.[1];
    if (b.name === 'diag') expect(origin).toBeTruthy();
    const hits: { file: string; hit: Hit }[] = [];
    for (const f of files(b.dir)) {
      if (f === 'manifest.json') continue;
      for (const hit of scanFile(f, read(b.dir, f))) {
        if (origin && hit.rule === 'remote-string' && hit.detail === origin) continue;
        hits.push({ file: f, hit });
      }
    }
    expect(check(hits, forTarget(b.target)).bad).toEqual([]);
  });

  test('asks for the same permissions and the same connect-src as its release build', () => {
    const rel = prod.find((x) => x.target === b.target);
    if (!rel) return;
    const m = manifest(b);
    const r = manifest(rel);
    for (const k of ['permissions', 'optional_permissions', 'host_permissions', 'content_security_policy'])
      expect(m[k], k).toEqual(r[k]);
    expect(m.web_accessible_resources).toEqual(r.web_accessible_resources);
  });
});

test('the allow-list holds the PDF read, two PDF.js file loads, and the cloud file', () => {
  expect(allow[0]).toMatchObject({
    file: 'content/pdf.js',
    rule: 'api',
    detail: 'fetch',
    count: 1,
    pin: 'own-address',
  });
  expect(allow.filter((a) => a.rule === 'import').map((a) => a.file)).toEqual([
    'chunks/app-*.js',
    'pdf/worker.js',
  ]);
  // Network calls: the PDF read, the cloud's one request function, and the worker loading cloud.js.
  expect(allow.filter((a) => a.rule === 'api').map((a) => `${a.file} ${a.detail}`)).toEqual([
    'content/pdf.js fetch',
    'background.js importScripts',
    'cloud.js fetch',
  ]);
  // Every remote address the extension uses is in cloud.js, never on Safari, and on a pinned host.
  const links = allow.filter((a) => a.kind === 'store-link');
  const remote = allow.filter((a) => a.rule === 'remote-string' && a.kind !== 'store-link');
  expect(remote.every((a) => a.file === 'cloud.js' && !a.targets?.includes('safari'))).toBe(true);
  expect(new Set(remote.map((a) => new URL(a.detail).host))).toEqual(new Set(PINNED));
  // The store links: one per browser with a store page, each once, in the popup only.
  expect(links.map((a) => [a.targets, a.detail])).toEqual(
    Object.entries(STORE_LINKS).map(([t, u]) => [[t], u]),
  );
  for (const a of links)
    expect(a).toMatchObject({ file: 'chunks/popup-*.js', rule: 'remote-string', count: 1 });
  expect(allow.length).toBe(3 + 2 + remote.length + links.length);
});

/**
 * The store page each build may name, written out again so a change to RATE_URL in
 * build/targets.ts must be made twice. Safari has none: Apple allows only its own review prompt.
 */
const STORE_LINKS = {
  chrome: 'https://chromewebstore.google.com/detail/pageink/okegfngejejaddeaobgpamojcdddlmgf/reviews',
  edge: 'https://microsoftedge.microsoft.com/addons/detail/pageink/nocfjhikfelnnjakadlpchhppdihamdo',
  firefox: 'https://addons.mozilla.org/firefox/addon/pageink/reviews/',
} as const;
const STORE_HOSTS =
  /chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com|addons\.mozilla\.org|apps\.apple\.com/;

test('the build settings name the same store pages', () => {
  expect(RATE_URL).toEqual({ ...STORE_LINKS, safari: '' });
});

describe.each(all.map((b) => [b.name, b] as const))('%s store link', (_name, b) => {
  test('names only its own store, and only where the popup opens it', () => {
    const own = (STORE_LINKS as Record<string, string>)[b.target];
    for (const f of files(b.dir)) {
      const text = read(b.dir, f);
      const hosts = [...text.matchAll(new RegExp(STORE_HOSTS, 'g'))].map((m) => m[0]);
      if (own && /^chunks\/popup-[^/]+\.js$/.test(f)) {
        expect(hosts, f).toEqual([new URL(own).host]);
        // It goes to tabs.create, never to a request.
        expect(text, f).toMatch(/tabs\.create\(\{url:/);
      } else expect(hosts, f).toEqual([]);
    }
    expect(JSON.stringify(manifest(b))).not.toMatch(STORE_HOSTS);
  });
});

describe.each(prod.filter((b) => b.target !== 'safari').map((b) => [b.name, b] as const))(
  '%s cloud file',
  (_name, b) => {
    test('names only the pinned hosts, and nothing of the test build', () => {
      const text = read(b.dir, 'cloud.js');
      const hosts = new Set(
        scanFile('cloud.js', text)
          .filter((h) => h.rule === 'remote-string')
          .map((h) => new URL(h.detail).host),
      );
      expect(hosts).toEqual(new Set(PINNED));
      for (const f of files(b.dir)) {
        const t = read(b.dir, f);
        expect(t, f).not.toMatch(
          /127\.0\.0\.1|cloudFake|fake-google-client|fake-microsoft-client|test build/,
        );
      }
      expect(JSON.stringify(manifest(b))).not.toContain('127.0.0.1');
    });
  },
);

test('Safari has no cloud file: its app does the cloud work', () => {
  for (const b of prod.filter((x) => x.target === 'safari')) {
    expect(files(b.dir)).not.toContain('cloud.js');
  }
});

test('every allow-list entry is exact and has a reason', () => {
  for (const a of allow) {
    expect(a.file).toBeTruthy();
    expect(a.file).not.toMatch(/\*\*/);
    expect(a.detail).toBeTruthy();
    expect(Number.isInteger(a.count) && a.count > 0).toBe(true);
    expect(a.reason.length).toBeGreaterThan(10);
  }
});

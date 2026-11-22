/**
 * Connect to a cloud in a real browser, against the local fakes (test/cloud-fake.ts), with
 * the test build (INK_CLOUD_FAKE=1). Two browser profiles stand in for two devices signed in
 * to one account. The request recorder checks that the extension talked to the fake and to
 * nothing else.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { Fake } from '../test/cloud-fake';
import {
  centre,
  dropProfile,
  expect,
  extensionRequests,
  launch,
  layerInfo,
  newProfile,
  ring,
  stroke,
  test,
  testExtDir,
  textBox,
  workerOf,
} from './fixtures';

type Provider = 'google' | 'onedrive';
const NAMES: Record<Provider, string> = { google: 'Google Drive', onedrive: 'OneDrive' };

let fake: Fake;
test.beforeEach(async () => {
  fake = await new Fake().start();
});
test.afterEach(async () => {
  await fake.stop();
});

interface Device {
  ctx: BrowserContext;
  id: string;
  opt: Page;
  profile: string;
}

/** A browser profile with the test build, pointed at the fake. */
async function device(): Promise<Device> {
  const profile = newProfile();
  const ctx = await launch(profile, [], testExtDir);
  const id = new URL((await workerOf(ctx)).url()).host;
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options.html#settings`);
  await opt.evaluate((base) => chrome.storage.local.set({ cloudFake: base }), fake.base);
  return { ctx, id, opt, profile };
}

/** Every request the extension made went to the fake; then they are cleared so close() passes. */
function onlyFake(d: Device): number {
  const reqs = extensionRequests(d.ctx);
  const bad = reqs.filter((r) => !r.url.startsWith(`${fake.base}/`));
  expect(bad, 'requests to anything but the fake').toEqual([]);
  const n = reqs.length;
  reqs.length = 0;
  return n;
}

async function close(d: Device): Promise<void> {
  onlyFake(d);
  try {
    await d.ctx.close();
  } finally {
    dropProfile(d.profile);
  }
}

async function connect(d: Device, p: Provider): Promise<void> {
  await d.opt.bringToFront();
  await d.opt.reload();
  await d.opt.click(`#connect-${p}`);
  // OneDrive asks for no profile scope, so it has no account name to show.
  await expect(d.opt.locator('#folder-state')).toContainText(
    p === 'google' ? `Connected to ${NAMES[p]} as ${fake.account}` : `Connected to ${NAMES[p]}.`,
    { timeout: 15_000 },
  );
}

const store = (d: Device, keys: string[] | null = null) =>
  d.opt.evaluate((k) => chrome.storage.local.get(k), keys) as Promise<Record<string, unknown>>;

const files = (p: Provider) => (p === 'google' ? fake.drivePages() : fake.msPages());
const notesIn = (p: Provider) => files(p).flatMap((f) => (JSON.parse(f.text).notes ?? []) as unknown[]);

/** Write a ring around a word on the article. */
async function write(page: Page, word: string): Promise<void> {
  const w = (await textBox(page, word))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
}

const sync = (d: Device) => d.opt.evaluate(() => chrome.runtime.sendMessage({ ink: 'sync' }));

/** The keys in the background's secret store, read in the service worker. */
async function secretKeys(d: Device): Promise<string[]> {
  const sw = await workerOf(d.ctx);
  return sw.evaluate(
    () =>
      new Promise<string[]>((ok, no) => {
        const r = indexedDB.open('pageink-secrets', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onerror = () => no(r.error);
        r.onsuccess = () => {
          const k = r.result.transaction('kv').objectStore('kv').getAllKeys();
          k.onsuccess = () => {
            ok((k.result as string[]).sort());
            r.result.close();
          };
          k.onerror = () => no(k.error);
        };
      }),
  );
}

for (const p of ['google', 'onedrive'] as const) {
  test(`${NAMES[p]}: connect, write, a second device sees it, both write offline, disconnect`, async ({
    origin,
  }) => {
    test.slow();
    const url = `${origin.a}/article.html`;
    const a = await device();
    await connect(a, p);
    // identity was asked for from the click, and granted without a prompt.
    expect(await a.opt.evaluate(() => chrome.permissions.contains({ permissions: ['identity'] }))).toBe(true);
    // Tokens are in the background's own store. storage.local, which every content script can
    // read, holds none; neither does storage.sync.
    expect(Object.keys(await store(a)).filter((k) => k.startsWith('tok:') || k === 'lockKey')).toEqual([]);
    expect(await a.opt.evaluate(() => chrome.storage.sync.get(null))).toEqual({});
    expect(await secretKeys(a)).toEqual([`tok:${p}`]);

    const pageA = await a.ctx.newPage();
    await pageA.goto(url);
    await write(pageA, 'pomegranate');
    await expect.poll(async () => (await layerInfo(pageA))?.notes.length).toBe(1);
    // The file appears in the cloud by itself.
    await expect.poll(() => files(p).length, { timeout: 20_000 }).toBe(1);
    expect(JSON.parse(files(p)[0]!.text).key).toBe(url);

    // A second device signs in to the same account and gets the note.
    const b = await device();
    await connect(b, p);
    const pageB = await b.ctx.newPage();
    await pageB.goto(url);
    await expect.poll(async () => (await layerInfo(pageB))?.notes.length, { timeout: 15_000 }).toBe(1);

    // Both write while offline. Nothing reaches the cloud, nothing is lost.
    fake.offline = true;
    const dropped = fake.dropped;
    await write(pageA, 'Borrowdale');
    await write(pageB, 'Europe');
    await expect.poll(async () => (await layerInfo(pageA))?.notes.length).toBe(2);
    await expect.poll(async () => (await layerInfo(pageB))?.notes.length).toBe(2);
    // Both devices tried to push, after their debounce and pacing, and were cut off.
    await expect.poll(() => fake.dropped - dropped, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    expect(notesIn(p)).toHaveLength(1);
    fake.offline = false;
    // Back online: the next trigger syncs. A, then B, then A again.
    await sync(a);
    await sync(b);
    await sync(a);
    expect(notesIn(p)).toHaveLength(3);
    await expect.poll(async () => (await layerInfo(pageA))?.notes.length).toBe(3);
    await expect.poll(async () => (await layerInfo(pageB))?.notes.length).toBe(3);

    // Disconnect keeps the files and removes every token.
    await a.opt.bringToFront();
    await a.opt.reload();
    await a.opt.click('#disconnect');
    await a.opt.click('#disconnect-keep');
    await expect(a.opt.locator('#folder-state')).toContainText('only in this browser');
    const left = Object.keys(await store(a));
    expect(left.filter((k) => /^(tok|names|seen):/.test(k) || k === 'dest' || k === 'lockKey')).toEqual([]);
    expect(files(p)).toHaveLength(1);
    if (p === 'google') expect(fake.google.revoked).toHaveLength(1);

    expect(onlyFake(a)).toBeGreaterThan(0);
    expect(onlyFake(b)).toBeGreaterThan(0);
    await close(a);
    await close(b);
  });
}

test('OneDrive: a Single-page application address works, since the service worker sends an Origin header', async () => {
  test.slow();
  fake.msPlatform = 'spa';
  const a = await device();
  // Before any click: the note on the provider's screen, and the return address to register.
  await a.opt.reload();
  await expect(a.opt.locator('#consent-note')).toContainText('can use files in its own folder');
  await expect(a.opt.locator('#consent-note')).toContainText(
    'It cannot see anything else in your Drive or OneDrive.',
  );
  // Chrome grants the sign-in permission only from a click, so the address is one click away.
  await a.opt.click('#show-return-address');
  await expect(a.opt.locator('#return-address-help .return-address')).toHaveText(
    `https://${a.id}.chromiumapp.org/`,
  );
  await connect(a, 'onedrive');
  for (const s of fake.scopes)
    expect(s.split(' ').sort()).toEqual(['Files.ReadWrite.AppFolder', 'offline_access']);
  await close(a);
});

test('OneDrive: a Mobile and desktop address is refused, and the Details say why', async () => {
  test.slow();
  fake.msPlatform = 'desktop';
  const a = await device();
  await a.opt.reload();
  await a.opt.click('#connect-onedrive');
  await expect(a.opt.locator('#place-problem-text')).toHaveText(
    'Sign-in worked, but OneDrive refused the next step.',
    {
      timeout: 15_000,
    },
  );
  await expect(a.opt.locator('#place-hint')).toContainText('to Single-page application');
  await a.opt.click('#place-details summary');
  const details = a.opt.locator('#sign-in-details');
  await expect(details).toContainText('token');
  await expect(details).toContainText('invalid_request');
  await expect(details).toContainText('AADSTS9002326');
  await expect(details).toContainText('400');
  await expect(a.opt.locator('#place-details')).toContainText(
    `Return address used by this build: https://${a.id}.chromiumapp.org/`,
  );
  // Nothing secret reaches the page.
  const html = await a.opt.locator('#place-problem').innerHTML();
  expect(html).not.toMatch(/code=c-|code_verifier|Trace ID|m-[0-9a-z]{6}/);
  await close(a);
});

test('Google: Cancel on the consent screen reads as a closed window, with the address to compare', async () => {
  test.slow();
  // Google sends the window back with access_denied. An error page such as
  // redirect_uri_mismatch never comes back, and ends the same way when the reader closes it.
  fake.authError = { error: 'access_denied' };
  const a = await device();
  await a.opt.reload();
  await a.opt.click('#connect-google');
  await expect(a.opt.locator('#place-problem-text')).toHaveText(
    'You closed the sign-in window or chose Cancel.',
    {
      timeout: 15_000,
    },
  );
  await expect(a.opt.locator('#place-hint')).toContainText('test users list');
  await a.opt.click('#place-details summary');
  await expect(a.opt.locator('#sign-in-details')).toContainText('access_denied');
  await expect(a.opt.locator('#place-details')).toContainText('compare the return address below');
  await expect(a.opt.locator('#place-details .return-address')).toHaveText(
    `https://${a.id}.chromiumapp.org/`,
  );
  await close(a);
});

test('lock on with two devices: sealed files, a wrong password refused, the right one opens', async ({
  origin,
}) => {
  test.slow();
  const p: Provider = 'google';
  const url = `${origin.a}/article.html`;
  const a = await device();
  await connect(a, p);
  const pageA = await a.ctx.newPage();
  await pageA.goto(url);
  await write(pageA, 'pomegranate');
  await expect.poll(() => files(p).length, { timeout: 20_000 }).toBe(1);

  // Turn the lock on.
  await a.opt.bringToFront();
  await a.opt.reload();
  await a.opt.check('#lock-switch');
  await a.opt.fill('#lock-pass', 'a long password');
  await a.opt.fill('#lock-pass2', 'a long password');
  await a.opt.click('#lock-on');
  await expect(a.opt.locator('#lock-switch')).toBeChecked({ timeout: 20_000 });
  await expect(a.opt.locator('#lock-recovery')).toBeVisible();
  const sealed = files(p)[0]!.text;
  expect(JSON.parse(sealed)).toMatchObject({ lock: 2, alg: 'A256GCM' });
  expect(sealed).not.toContain('pomegranate');
  // The file's name is keyed: 16 letters and digits, not the plain hash of the address.
  expect(files(p)[0]!.name).toMatch(/^[a-z2-7]{16}\.ink\.json$/);
  const lockFile = [...fake.google.files.values()].find((f) => f.name === 'pageink.lock.json');
  expect(JSON.parse(lockFile!.text)).toMatchObject({ v: 2, state: 'on', mac: expect.any(String) });
  // The key is in the background's own store, not in storage.local.
  expect(Object.keys(await store(a)).filter((k) => k.startsWith('tok:') || k === 'lockKey')).toEqual([]);
  expect(await secretKeys(a)).toEqual(['lockKey', `tok:${p}`]);
  // A recovery key can be shown.
  await a.opt.click('#lock-recovery');
  await expect(a.opt.locator('#recovery-code')).toHaveText(/^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/);

  // The second device must give the password before it syncs.
  const b = await device();
  await connect(b, p);
  await b.opt.reload();
  await expect(b.opt.locator('#unlock-pass')).toBeVisible();
  await b.opt.fill('#unlock-pass', 'not the password');
  await b.opt.click('#unlock');
  await expect(b.opt.locator('#lock-msg')).toContainText('does not open');
  await b.opt.fill('#unlock-pass', 'a long password');
  await b.opt.click('#unlock');
  await expect(b.opt.locator('#lock-switch')).toBeChecked({ timeout: 20_000 });
  const pageB = await b.ctx.newPage();
  await pageB.goto(url);
  await expect.poll(async () => (await layerInfo(pageB))?.notes.length, { timeout: 15_000 }).toBe(1);

  // B writes: the file it sends is sealed too.
  await write(pageB, 'Europe');
  await expect
    .poll(
      () => {
        const t = files(p)[0]!.text;
        return JSON.parse(t).lock === 2 && t !== sealed;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await sync(a);
  await expect.poll(async () => (await layerInfo(pageA))?.notes.length).toBe(2);

  await close(a);
  await close(b);
});

test('release build: connect-src stops the service worker reaching any other address', async ({
  context,
  sw,
  origin,
}) => {
  // The page server answers, and the extension has host access to it, so only the policy can stop it.
  const target = `${origin.b}/plain.html`;
  const page = await context.newPage();
  expect((await page.goto(target))?.ok()).toBe(true);
  const r = await sw.evaluate(async (u) => {
    try {
      await fetch(u);
      return 'reached';
    } catch {
      return 'blocked';
    }
  }, target);
  expect(r).toBe('blocked');
  // Nothing went out. Had it, the recorder would fail the test when the browser closes.
  expect(extensionRequests(context).filter((q) => q.url === target)).toEqual([]);
  // The release build has no fake and has not asked for the sign-in window.
  expect(await sw.evaluate(() => typeof chrome.identity)).toBe('undefined');
});

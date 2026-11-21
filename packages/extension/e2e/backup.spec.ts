/**
 * Backup that keeps working: lapsed folder access shows on the action and in the popup and
 * is fixed with one click, pages with ink pull what other devices wrote, deletes stick
 * through sync, and the backup prompt shows once there is ink on a few pages.
 * An OPFS directory stands in for the picked folder, as in sync.spec.ts.
 */
import type { Page, Worker } from '@playwright/test';
import { hashKey, idxKey, pageKeyOf } from 'pageink-core/hash';
import { NUDGE_TEXT } from '../src/nudge';
import { note, record } from '../src/testing/records';
import {
  centre,
  expect,
  layerInfo,
  readStorage,
  ring,
  seedStorage,
  stroke,
  tabId,
  test,
  textBox,
} from './fixtures';

const connect = (opt: Page) =>
  opt.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('PageInk Notes', { create: true });
    await new Promise<void>((ok, fail) => {
      const r = indexedDB.open('ink-folder', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('handles');
      r.onerror = () => fail(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(dir, 'folder');
        tx.oncomplete = () => {
          r.result.close();
          ok();
        };
        tx.onerror = () => fail(tx.error);
      };
    });
  });

const files = (opt: Page) =>
  opt.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('PageInk Notes'))
      .getDirectoryHandle('pages')
      .catch(() => null);
    const out: string[] = [];
    if (dir) for await (const k of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(k);
    return out.sort();
  });

const readFile = (opt: Page, name: string) =>
  opt.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('PageInk Notes')).getDirectoryHandle('pages');
    return (await (await dir.getFileHandle(n)).getFile()).text();
  }, name);

const writeFile = (opt: Page, name: string, text: string) =>
  opt.evaluate(
    async ([n, t]) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('PageInk Notes')).getDirectoryHandle('pages', {
        create: true,
      });
      const w = await (await dir.getFileHandle(n, { create: true })).createWritable();
      await w.write(t);
      await w.close();
    },
    [name, text] as const,
  );

/** Make folder access lapse in the background, as after a browser restart: the query says "prompt". */
const lapse = (sw: Worker, on: boolean) =>
  sw.evaluate((v) => {
    const g = globalThis as unknown as { __lapsed?: boolean; __q?: unknown };
    const proto = FileSystemHandle.prototype as unknown as { queryPermission(o: object): Promise<string> };
    if (!g.__q) {
      const q = proto.queryPermission;
      g.__q = q;
      proto.queryPermission = function (o) {
        return g.__lapsed ? Promise.resolve('prompt') : q.call(this, o);
      };
    }
    g.__lapsed = v;
  }, on);

const badge = (sw: Worker) => sw.evaluate(() => chrome.action.getBadgeText({}));
const send = (p: Page, m: object) =>
  p.evaluate((x) => chrome.runtime.sendMessage(x), m) as Promise<Record<string, unknown>>;

test('lapsed folder access shows a badge and a popup line, and Reconnect fixes it in one click', async ({
  context,
  origin,
  extId,
  sw,
}) => {
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#settings`);
  await connect(opt);
  await lapse(sw, true);
  expect((await send(opt, { ink: 'sync' })).error).toBe('permission');
  await expect.poll(() => badge(sw)).toBe('!');

  // Ink written while access is lapsed waits in the browser.
  const url = `${origin.a}/article.html`;
  const page = await context.newPage();
  await page.goto(url);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  // A sync asked for now, after the note is stored, still cannot write it.
  await expect
    .poll(async () => Object.keys(await readStorage(opt, null)).some((k) => k.startsWith('p:')))
    .toBe(true);
  expect((await send(opt, { ink: 'sync' })).error).toBe('permission');
  expect(await files(opt)).toEqual([]);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${await tabId(opt, url)}`);
  await expect(popup.locator('#attention')).toBeVisible();
  await expect(popup.locator('#attention-text')).toHaveText('The backup folder needs access again.');
  await expect(popup.locator('#attention-go')).toHaveText('Reconnect');
  // The browser's prompt cannot be clicked here. Granting it is what the stand-in below does.
  await popup.evaluate(() => {
    (FileSystemHandle.prototype as unknown as { requestPermission(): Promise<string> }).requestPermission =
      async () => 'granted';
    (FileSystemHandle.prototype as unknown as { queryPermission(): Promise<string> }).queryPermission =
      async () => 'prompt';
  });
  await lapse(sw, false);
  await popup.click('#attention-go');
  await expect(popup.locator('#attention-text')).toContainText('Reconnected');
  await expect.poll(() => badge(sw)).toBe('');
  await expect.poll(() => files(opt)).toEqual([`${hashKey(url)}.ink.json`]);
});

test('a page with ink pulls what another device wrote, and a library delete sticks through sync', async ({
  context,
  origin,
  extId,
  ext,
}) => {
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#settings`);
  await connect(opt);
  const url = `${origin.a}/article.html`;
  const page = await context.newPage();
  await page.goto(url);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const file = `${hashKey(url)}.ink.json`;
  await expect.poll(() => files(opt), { timeout: 10_000 }).toEqual([file]);
  await page.close();

  // Another device adds a stroke and writes the file. Nobody asks for a sync.
  const other = JSON.parse(await readFile(opt, file));
  const s0 = other.notes[0].strokes[0];
  const t = Date.now() + 1000;
  other.notes[0].strokes.push({ ...s0, id: `${s0.id}-other`, t });
  other.notes[0].updatedAt = t;
  other.updatedAt = t;
  await writeFile(opt, file, JSON.stringify(other));
  // Opening the page is enough: it reports in and the background pulls its file.
  const again = await context.newPage();
  await again.goto(url);
  await expect.poll(async () => (await layerInfo(again))?.notes[0]?.strokes, { timeout: 10_000 }).toBe(2);
  await again.close();

  // Delete from the library: tombstones, so the next sync cannot bring the notes back.
  await opt.goto(`chrome-extension://${extId}/options.html#library`);
  opt.once('dialog', (d) => d.accept());
  await opt.locator('#pages tbody tr .delete').click();
  await expect(opt.locator('#pages tbody tr')).toHaveCount(0);
  expect((await send(opt, { ink: 'sync' })).error).toBeUndefined();
  const rec = (await readStorage(ext, [pageKeyOf(url)]))[pageKeyOf(url)] as {
    notes: unknown[];
    deleted: unknown[];
  };
  expect(rec.notes).toEqual([]);
  expect(rec.deleted.length).toBeGreaterThanOrEqual(3);
  // The page itself shows no ink after a delete: the library test in options.spec.ts checks that.
  await expect.poll(async () => JSON.parse(await readFile(opt, file)).notes).toEqual([]);
});

test('the backup prompt shows with ink on three pages and no folder, and rests after Not now', async ({
  context,
  origin,
  extId,
  ext,
  sw,
}) => {
  const items: Record<string, unknown> = {};
  for (const n of [1, 2, 3]) {
    const u = `${origin.a}/page${n}.html`;
    const r = record(u, [note(`n${n}`)]);
    items[pageKeyOf(u)] = r;
    items[idxKey(new URL(u).hostname)] = { v: 1, m: {} };
  }
  await seedStorage(ext, items);
  const tab = await context.newPage();
  await tab.goto(`${origin.a}/plain.html`);
  const popup = await context.newPage();
  await popup.goto(
    `chrome-extension://${extId}/popup.html?tab=${await tabId(ext, `${origin.a}/plain.html`)}`,
  );
  await expect(popup.locator('#attention-text')).toHaveText(NUDGE_TEXT.folder);
  await expect.poll(() => badge(sw)).toBe('•');
  await popup.click('#attention-later');
  await expect(popup.locator('#attention')).toBeHidden();
  await expect.poll(() => badge(sw)).toBe('');
  await popup.reload();
  // The popup asks the worker before it shows a line. Too short a wait can only pass early.
  await popup.waitForTimeout(300);
  await expect(popup.locator('#attention')).toBeHidden();
  expect((await readStorage(ext, ['nudge'])).nudge).toMatchObject({ dismissed: 1 });
});

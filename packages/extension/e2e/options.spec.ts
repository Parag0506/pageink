import { readFileSync } from 'node:fs';
import { pageKeyOf } from 'pageink-core/hash';
import { NAME } from '../src/brand';
import { note, record, seed } from '../src/testing/records';
import {
  allNotes,
  centre,
  expect,
  launch,
  layerInfo,
  readStorage,
  ring,
  seedStorage,
  shotPath,
  stroke,
  test,
  textBox,
  workerOf,
} from './fixtures';

test('first run opens the guide once, on top of the library', async ({ context, extId }) => {
  const guide =
    context.pages().find((p) => p.url().endsWith('options.html#welcome')) ??
    (await context.waitForEvent('page', { predicate: (p) => p.url().endsWith('options.html#welcome') }));
  await guide.waitForLoadState();
  await expect(guide.locator('#welcome h2')).toHaveText(`Welcome to ${NAME}`);
  await expect(guide.locator('#welcome-key')).not.toBeEmpty();
  for (const t of [
    'Write with a pen',
    'No pen? Use Draw',
    'Moved notes',
    'Where notes live',
    'Back up and sync',
    'Private by design',
  ])
    await expect(guide.locator('#welcome h3', { hasText: t })).toBeVisible();
  await expect(guide.locator('#library')).toBeVisible();
  await guide.setViewportSize({ width: 1100, height: 900 });
  await guide.screenshot({ path: shotPath('options-welcome'), fullPage: true });
  await guide.click('#welcome-done');
  await expect(guide.locator('#welcome')).toBeHidden();
  await expect(guide).toHaveURL(`chrome-extension://${extId}/options.html#library`);
  // Only one guide tab, ever.
  expect(context.pages().filter((p) => p.url().includes('#welcome'))).toHaveLength(0);
});

test('the library lists a written page, opens it, deletes it; an archive restores it in a fresh profile', async ({
  context,
  origin,
  extId,
  ext,
}) => {
  const url = `${origin.a}/article.html`;
  const page = await context.newPage();
  await page.goto(url);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);
  const word = async (p: typeof page) => {
    const n = (await layerInfo(p))?.notes[0]?.box;
    const t = await textBox(p, 'pomegranate');
    return n && t ? { dx: n.x - t.x, dy: n.y - t.y } : null;
  };
  const where = await word(page);
  await page.close();

  const opt = await context.newPage();
  await opt.setViewportSize({ width: 1100, height: 800 });
  await opt.goto(`chrome-extension://${extId}/options.html#library`);
  const rows = opt.locator('#pages tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.open')).toHaveText('Article page');
  await expect(rows.first().locator('.count')).toHaveText('1');
  await opt.screenshot({ path: shotPath('options-library') });

  // Open: the page comes up with its ink.
  const [opened] = await Promise.all([context.waitForEvent('page'), rows.first().locator('.open').click()]);
  await opened.waitForLoadState();
  expect(opened.url()).toBe(url);
  await expect.poll(async () => (await layerInfo(opened))?.notes.length).toBe(1);
  await opened.close();

  // Export the archive before deleting.
  const [dl] = await Promise.all([opt.waitForEvent('download'), opt.click('#export-archive')]);
  const zip = readFileSync((await dl.path())!);
  opt.once('dialog', (d) => d.accept());
  await rows.first().locator('.delete').click();
  await expect(rows).toHaveCount(0);
  // Deleted for good: the record stays, holding tombstones only, so a sync cannot bring it back.
  expect((await readStorage(ext))[pageKeyOf(url)]).toMatchObject({ notes: [] });
  // On the page, a new pen note loads the viewer with the record: once it is drawn, it is the
  // only ink there.
  const gone = await context.newPage();
  await gone.goto(url);
  const w2 = (await textBox(gone, 'Borrowdale'))!;
  await stroke(gone, ring(centre(w2), w2.w / 2 + 8, w2.h / 2 + 6));
  const c2 = centre(w2);
  const around = (b: { x: number; y: number; w: number; h: number }) =>
    b.x <= c2.x && c2.x <= b.x + b.w && b.y <= c2.y && c2.y <= b.y + b.h;
  await expect.poll(async () => (await layerInfo(gone))?.notes.some((n) => around(n.box))).toBe(true);
  expect((await layerInfo(gone))!.notes).toHaveLength(1);

  // A fresh profile: import the archive and the ink is back on its words.
  const fresh = await launch();
  try {
    const sw = await workerOf(fresh);
    const id = new URL(sw.url()).host;
    const o2 = await fresh.newPage();
    await o2.goto(`chrome-extension://${id}/options.html#library`);
    await expect(o2.locator('#pages tbody tr')).toHaveCount(0);
    await o2.setInputFiles('#import-file', { name: 'ink.zip', mimeType: 'application/zip', buffer: zip });
    await expect(o2.locator('#pages tbody tr')).toHaveCount(1);
    const p2 = await fresh.newPage();
    await p2.goto(url);
    await expect.poll(async () => (await layerInfo(p2))?.notes.length).toBe(1);
    const there = await word(p2);
    expect(Math.abs(there!.dx - where!.dx) + Math.abs(there!.dy - where!.dy)).toBeLessThan(2);
  } finally {
    await fresh.close();
  }
});

test('settings: written to cfg, sites off listed, and shown in screenshots', async ({
  context,
  extId,
  ext,
}) => {
  const opt = await context.newPage();
  await opt.setViewportSize({ width: 1100, height: 900 });
  await opt.goto(`chrome-extension://${extId}/options.html#settings`);
  await opt.selectOption('#modifier', 'Meta');
  await opt.fill('#bar-hide', '7');
  await opt.locator('#bar-hide').dispatchEvent('change');
  await opt.selectOption('#theme', 'dark');
  await opt.fill('#pen-w', '3');
  await opt.locator('#pen-w').dispatchEvent('change');
  await expect
    .poll(async () => (await readStorage(ext, ['cfg'])).cfg)
    .toMatchObject({ modifier: 'Meta', barHideMs: 7000, theme: 'dark', penW: 3 });
  await opt.fill('#site-add', 'https://news.test/front');
  await opt.click('#site-add-button');
  await expect(opt.locator('#sites li')).toHaveText([/news\.test/]);
  // Nothing connected: the three choices. This build has no client ids, so the clouds say so.
  await expect(opt.locator('#folder-state')).toContainText('only in this browser');
  for (const p of ['google', 'onedrive']) {
    await expect(opt.locator(`#connect-${p}`)).toBeDisabled();
    await expect(opt.locator(`#connect-${p}`)).toContainText('Not set up in this build.');
  }
  await expect(opt.locator('#connect')).toBeEnabled();
  await expect(opt.locator('#connect')).toContainText('iCloud Drive, Dropbox');
  await opt.screenshot({ path: shotPath('options-settings'), fullPage: true });
  await opt.getByRole('button', { name: 'Switch ink on for news.test' }).click();
  await expect(opt.locator('#sites li')).toHaveText([`${NAME} is on everywhere.`]);
});

test('settings: the five new rows save, and reset puts settings back but keeps notes', async ({
  context,
  extId,
  ext,
  origin,
}) => {
  const url = `${origin.a}/article.html`;
  await seedStorage(ext, seed(record(url, [note('n1')])));
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#settings`);
  for (const id of ['remember-draw', 'pen-needs-toggle', 'thumbs', 'private-keep', 'draw-on']) {
    await expect(opt.locator(`#${id}-help`)).not.toBeEmpty();
  }
  await expect(opt.locator('#remember-draw')).toBeChecked();
  await expect(opt.locator('#thumbs')).toBeChecked();
  await expect(opt.locator('#pen-needs-toggle')).not.toBeChecked();
  await expect(opt.locator('#private-keep')).not.toBeChecked();
  await opt.uncheck('#thumbs');
  await opt.check('#pen-needs-toggle');
  await opt.check('#private-keep');
  await opt.uncheck('#remember-draw');
  await expect
    .poll(async () => (await readStorage(ext, ['cfg'])).cfg)
    .toMatchObject({ thumbs: false, penNeedsToggle: true, privateKeep: true, rememberDraw: false });
  const device = ((await readStorage(ext, ['cfg'])).cfg as { device: string }).device;

  // Reset asks first. Cancel keeps everything.
  await opt.click('#reset-settings');
  await opt.click('#reset-cancel');
  await expect(opt.locator('#thumbs')).not.toBeChecked();
  await opt.click('#reset-settings');
  await opt.click('#reset-confirm');
  await expect(opt.locator('#thumbs')).toBeChecked();
  expect((await readStorage(ext, ['cfg'])).cfg).toEqual({ v: 1, device });
  expect((await readStorage(ext))[pageKeyOf(url)]).toMatchObject({ notes: [{ id: 'n1' }] });
});

test('library: notes move to the page their address became', async ({ context, extId, ext, origin }) => {
  const old = `${origin.a}/2024/old-name.html`;
  await seedStorage(ext, seed(record(old, [note('n1', 'pomegranate')], 'Old name')));
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#library`);
  await opt.locator('#pages tbody tr .move').click();
  const to = `${origin.a}/article.html`;
  await opt.fill('#move-address', to);
  await opt.click('#move-go');
  await expect(opt.locator('#pages tbody tr')).toHaveCount(1);
  await expect(opt.locator('#pages tbody tr .url')).toHaveText(to);
  const moved = (await readStorage(ext, [pageKeyOf(to)]))[pageKeyOf(to)] as { notes: { id: string }[] };
  expect(moved.notes).toHaveLength(1);
  expect(moved.notes[0]!.id).not.toBe('n1');
  expect((await readStorage(ext, [pageKeyOf(old)]))[pageKeyOf(old)]).toMatchObject({ notes: [] });
});

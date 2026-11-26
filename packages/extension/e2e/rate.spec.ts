/**
 * The rating line in the real popup: it shows only after real use (ink on five pages, three
 * days), waits while the backup prompt asks, and each button settles it for good. The plain
 * "Rate PageInk" link is always there. Rate opens this browser's store page in a new tab. The
 * store host is answered locally, so nothing leaves the machine.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { idxKey, pageKeyOf } from 'pageink-core/hash';
import { RATE_URL, type Target } from '../build/targets';
import { RATE_KEY } from '../src/rate';
import { note, record } from '../src/testing/records';
import { RATE_TEXT } from '../src/ui/rate';
import { expect, readStorage, seedStorage, tabId, test } from './fixtures';

const target = (process.env.INK_TARGET ?? 'chrome') as Target;
const STORE = RATE_URL[target];
const DAY = 24 * 60 * 60 * 1000;

/** Pages with ink on the first origin, last changed `ageDays` ago. */
function pages(origin: string, n: number, ageDays: number): Record<string, unknown> {
  const items: Record<string, unknown> = {};
  for (let i = 1; i <= n; i++) {
    const u = `${origin}/rate${i}.html`;
    items[pageKeyOf(u)] = record(u, [note(`n${i}`)], `Page ${i}`, Date.now() - ageDays * DAY);
    items[idxKey(new URL(u).hostname)] = { v: 1, m: {} };
  }
  return items;
}

/** The backup prompt has had its answer, so it does not ask in the popup. */
const NUDGE_DONE = { nudge: { chosen: true } };

async function openPopup(context: BrowserContext, ext: Page, extId: string, origin: string): Promise<Page> {
  const tab = await context.newPage();
  await tab.goto(`${origin}/plain.html`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${await tabId(ext, `${origin}/plain.html`)}`);
  // The text is set as soon as the popup knows its store page, before it reads anything.
  await expect(popup.locator('#rate-text')).toHaveText(RATE_TEXT);
  // The popup asks the worker before it decides. Too short a wait can only pass early.
  await popup.waitForTimeout(400);
  return popup;
}

/** Answer the store's host here, so a click opens a tab without going online. */
async function fakeStore(context: BrowserContext): Promise<void> {
  const host = new URL(STORE).host;
  await context.route(
    (u) => u.host === host,
    (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>Store</title>' }),
  );
}

test('the build links to its own store', () => {
  expect(STORE).toMatch(/^https:\/\//);
});

test('no line before real use, but the plain link is always there', async ({
  context,
  origin,
  extId,
  ext,
}) => {
  // Four pages, long in use: one page short.
  await seedStorage(ext, { ...pages(origin.a, 4, 30), ...NUDGE_DONE });
  let popup = await openPopup(context, ext, extId, origin.a);
  await expect(popup.locator('#rate')).toBeHidden();
  await expect(popup.locator('#rate-link')).toHaveText('Rate PageInk');

  // Five pages, all written today, seen for the first time now: the clock starts.
  await seedStorage(ext, pages(origin.a, 5, 0));
  popup = await openPopup(context, ext, extId, origin.a);
  await expect(popup.locator('#rate')).toBeHidden();
  const st = (await readStorage(ext, [RATE_KEY]))[RATE_KEY] as { first?: number; done?: string };
  expect(st.first).toBeGreaterThan(Date.now() - DAY);
  expect(st.done).toBeUndefined();
});

test('the line waits while the backup prompt asks', async ({ context, origin, extId, ext }) => {
  await seedStorage(ext, pages(origin.a, 5, 4));
  const popup = await openPopup(context, ext, extId, origin.a);
  await expect(popup.locator('#attention')).toBeVisible();
  await expect(popup.locator('#rate')).toBeHidden();
});

test('No thanks hides the line for good', async ({ context, origin, extId, ext }) => {
  await seedStorage(ext, { ...pages(origin.a, 5, 4), ...NUDGE_DONE });
  let popup = await openPopup(context, ext, extId, origin.a);
  await expect(popup.locator('#rate')).toBeVisible();
  await expect(popup.locator('#rate-text')).toHaveText(RATE_TEXT);
  await expect(popup.locator('#rate-go')).toHaveText('Rate PageInk');
  // The line holds the link while it shows; the plain one steps aside.
  await expect(popup.locator('#about')).toBeHidden();
  await popup.click('#rate-no');
  await expect(popup.locator('#rate')).toBeHidden();
  await expect(popup.locator('#rate-link')).toBeVisible();
  await expect
    .poll(async () => ((await readStorage(ext, [RATE_KEY]))[RATE_KEY] as { done?: string }).done)
    .toBe('declined');
  // Even with more use, it does not come back.
  await seedStorage(ext, pages(origin.a, 12, 40));
  popup = await openPopup(context, ext, extId, origin.a);
  await expect(popup.locator('#rate')).toBeHidden();
  await expect(popup.locator('#rate-link')).toBeVisible();
});

test('Rate opens the store page in a new tab and hides the line for good', async ({
  context,
  origin,
  extId,
  ext,
}) => {
  await fakeStore(context);
  await seedStorage(ext, { ...pages(origin.a, 5, 4), ...NUDGE_DONE });
  let popup = await openPopup(context, ext, extId, origin.a);
  await expect(popup.locator('#rate')).toBeVisible();
  const opened = context.waitForEvent('page');
  await popup.click('#rate-go');
  const store = await opened;
  await store.waitForURL(STORE);
  await expect
    .poll(async () => ((await readStorage(ext, [RATE_KEY]))[RATE_KEY] as { done?: string }).done)
    .toBe('rated');
  await store.close();
  popup = await openPopup(context, ext, extId, origin.a);
  await expect(popup.locator('#rate')).toBeHidden();
});

test('the plain link opens the same store page', async ({ context, origin, extId, ext }) => {
  await fakeStore(context);
  const popup = await openPopup(context, ext, extId, origin.a);
  await expect(popup.locator('#rate')).toBeHidden();
  const opened = context.waitForEvent('page');
  await popup.click('#rate-link');
  await (await opened).waitForURL(STORE);
  await expect
    .poll(async () => ((await readStorage(ext, [RATE_KEY]))[RATE_KEY] as { done?: string }).done)
    .toBe('rated');
});

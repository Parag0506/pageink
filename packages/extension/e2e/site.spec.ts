import { idxKey } from 'pageink-core/hash';
import {
  barClick,
  centre,
  expect,
  inkState,
  layerInfo,
  readStorage,
  ring,
  stroke,
  tabId,
  test,
  textBox,
} from './fixtures';

test('site off from the popup removes the ink at once and the stub does nothing; on again restores it live', async ({
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
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const tab = await tabId(ext, `${origin.a}/*`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
  await expect(popup.locator('#site')).toBeChecked();

  await popup.locator('#site').uncheck();
  await expect.poll(() => page.locator('ink-layer').count()).toBe(0);
  expect(((await readStorage(ext, ['cfg'])).cfg as { off: string[] }).off).toEqual(['localhost']);
  await expect.poll(() => ext.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tab)).toBe('');
  // The stub does nothing now: a pen stroke leaves no ink and the popup cannot draw. A pen-down
  // the stub took would have started its viewer, and its answer waits for that viewer.
  const w2 = (await textBox(page, 'Borrowdale'))!;
  await stroke(page, ring(centre(w2), w2.w / 2 + 8, w2.h / 2 + 6));
  expect(await inkState(ext, tab)).toMatchObject({ loaded: false, off: true });
  expect(await page.locator('ink-layer').count()).toBe(0);
  await popup.reload();
  await expect(popup.locator('#site')).not.toBeChecked();
  await expect(popup.locator('#draw')).toBeDisabled();
  // After a reload too: once the stub has read the settings it says it is off, and a pen does nothing.
  await page.reload();
  await expect.poll(async () => (await inkState(ext, tab))?.off).toBe(true);
  await stroke(page, ring(centre(w2), w2.w / 2 + 8, w2.h / 2 + 6));
  expect(await inkState(ext, tab)).toMatchObject({ loaded: false, off: true });
  expect(await page.locator('ink-layer').count()).toBe(0);

  // On again: the ink comes back without a reload.
  await popup.locator('#site').check();
  await expect.poll(async () => (await layerInfo(page))?.notes.length ?? 0).toBe(1);
  // The pen writes again.
  await stroke(page, ring(centre(w2), w2.w / 2 + 8, w2.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length ?? 0).toBe(2);
  // Notes were never removed from storage.
  expect((await readStorage(ext))[idxKey('localhost')]).toBeTruthy();
});

test('site off from the bar, then on from the popup, leaves the page working', async ({
  context,
  origin,
  extId,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/article.html`);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await barClick(page, 'More');
  await barClick(page, 'Turn ink off for this site');
  await expect.poll(() => page.locator('ink-layer').count()).toBe(0);
  await expect
    .poll(async () => ((await readStorage(ext, ['cfg'])).cfg as { off: string[] }).off)
    .toEqual(['localhost']);

  const tab = await tabId(ext, `${origin.a}/*`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
  await expect(popup.locator('#site')).not.toBeChecked();
  await popup.locator('#site').check();
  await expect.poll(async () => (await layerInfo(page))?.notes.length ?? 0).toBe(1);
  // Draw works from the popup again.
  await popup.click('#draw');
  await expect.poll(async () => (await layerInfo(page))?.bar).toMatchObject({ hidden: false, draw: true });
});

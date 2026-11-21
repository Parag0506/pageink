import {
  allNotes,
  centre,
  expect,
  layerInfo,
  line,
  ring,
  shotPath,
  stroke,
  tabId,
  test,
  textBox,
  touch,
} from './fixtures';

test('popup: draw on shows the bar in draw mode, then mouse and one finger draw, two fingers scroll', async ({
  context,
  origin,
  extId,
  ext,
}) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/article.html`);
  const tab = await tabId(ext, `${origin.a}/*`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
  await expect(popup.locator('#host')).toHaveText('localhost');
  await expect(popup.locator('#count')).toHaveText('No notes on this page');
  await popup.click('#draw');
  await expect(popup.locator('#draw')).toHaveAttribute('aria-pressed', 'true');
  // Visible feedback on the page: the bar is up with Draw pressed.
  await expect.poll(async () => (await layerInfo(page))?.bar).toMatchObject({ hidden: false, draw: true });
  await page.bringToFront();
  await page.screenshot({ path: shotPath('draw-on') });

  // The mouse draws with the toggle on.
  const a = (await textBox(page, 'Borrowdale'))!;
  await stroke(page, ring(centre(a), a.w / 2 + 8, a.h / 2 + 6), { kind: 'mouse' });
  await expect.poll(async () => (await allNotes(ext)).length).toBe(1);

  // One finger draws.
  const b = (await textBox(page, 'centuries'))!;
  await touch(page, [ring(centre(b), b.w / 2 + 8, b.h / 2 + 6, 24)]);
  await expect.poll(async () => (await allNotes(ext)).length).toBe(2);

  // Two fingers scroll and leave no ink.
  const y0 = await page.evaluate(() => scrollY);
  await touch(page, [
    line({ x: 300, y: 600 }, { x: 300, y: 300 }, 10),
    line({ x: 420, y: 600 }, { x: 420, y: 300 }, 10),
  ]);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(y0 + 50);
  // A pen after them: gestures are written in order, and the page's record holds every note,
  // so once this one is stored a note from the two fingers would be there too.
  const c = (await textBox(page, 'Pencils'))!;
  await stroke(page, ring(centre(c), c.w / 2 + 8, c.h / 2 + 6));
  await expect
    .poll(async () => (await allNotes(ext)).some((n) => n.anchor.quote.exact.includes('Pencils')))
    .toBe(true);
  expect(await allNotes(ext)).toHaveLength(3);

  // The popup count and the action badge follow the notes.
  await popup.reload();
  await expect(popup.locator('#count')).toHaveText('3 notes on this page');
  await popup.setViewportSize({ width: 264, height: 240 });
  await popup.screenshot({ path: shotPath('popup') });
  await expect.poll(() => ext.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tab)).toBe('3');

  // Draw off from the popup: the mouse selects text again and links work.
  await popup.click('#draw');
  await expect(popup.locator('#draw')).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await layerInfo(page))?.bar?.draw).toBe(false);
  await page.evaluate(() => scrollTo(0, 0));
  const p3 = (await textBox(page, 'Pens changed'))!;
  await stroke(page, line({ x: p3.x + 2, y: p3.y + p3.h / 2 }, { x: p3.x + 300, y: p3.y + p3.h / 2 }, 10), {
    kind: 'mouse',
  });
  await expect.poll(() => page.evaluate(() => getSelection()?.toString().length ?? 0)).toBeGreaterThan(10);
  // A pen still writes. Once its note is stored, a note from the mouse would be there too.
  const d = (await textBox(page, 'Paper was made'))!;
  await stroke(page, ring(centre(d), d.w / 2 + 8, d.h / 2 + 6));
  await expect
    .poll(async () => (await allNotes(ext)).some((n) => n.anchor.quote.exact.includes('Paper')))
    .toBe(true);
  expect(await allNotes(ext)).toHaveLength(4);
  await page.click('#link');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#linked');
});

test('the keyboard shortcut toggles draw and shows the bar', async ({ context, origin, ext, sw }) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/article.html`);
  const tab = await tabId(ext, `${origin.a}/*`);
  // The browser hands the shortcut to the worker as a command. Fire that same event.
  const press = () =>
    sw.evaluate(
      (id) =>
        (chrome.commands.onCommand as unknown as { dispatch(n: string, t: object): void }).dispatch(
          'toggle-draw',
          { id },
        ),
      tab,
    );
  expect(
    await sw.evaluate(() =>
      chrome.commands.getAll().then((c) => c.find((x) => x.name === 'toggle-draw')?.shortcut),
    ),
  ).toBeTruthy();
  await press();
  await expect.poll(async () => (await layerInfo(page))?.bar).toMatchObject({ hidden: false, draw: true });
  // The bar stays up while drawing is on, past its hide delay. Its hide timer was set when it
  // came up. A page timer set now for longer is due later, and the page and the content script
  // share one event loop, so when it fires the bar's timer has fired too.
  const hideMs = 4000;
  await page.evaluate((ms) => new Promise((r) => setTimeout(r, ms + 50)), hideMs);
  expect((await layerInfo(page))?.bar).toMatchObject({ hidden: false, draw: true });
  await press();
  await expect.poll(async () => (await layerInfo(page))?.bar?.draw).toBe(false);
  // With drawing off, the same delay hides it: the timer above was the real one.
  await expect.poll(async () => (await layerInfo(page))?.bar?.hidden, { timeout: 15_000 }).toBe(true);
});

test('the action badge counts seeded notes and clears when the page has none', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/article.html`;
  const page = await context.newPage();
  await page.goto(url);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  const tab = await tabId(ext, `${origin.a}/*`);
  await expect.poll(() => ext.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tab)).toBe('1');
  await page.reload();
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  await expect.poll(() => ext.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tab)).toBe('1');
  // A page on the same site without notes: the badge is cleared.
  await page.goto(`${origin.a}/plain.html`);
  await expect.poll(() => ext.evaluate((t) => chrome.action.getBadgeText({ tabId: t }), tab)).toBe('');
});

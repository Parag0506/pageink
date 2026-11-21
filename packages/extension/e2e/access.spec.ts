/**
 * Site access (src/ui/access.ts). With access to all sites the popup shows no extra line. When the
 * reader takes it away, the stub no longer runs on pages and the popup says what to click.
 * Safari's prompt and its own words are covered by the simulator tests (apple/SimTests).
 */
import { expect, tabId, test } from './fixtures';

test('the popup asks for website access only when it is missing', async ({ context, origin, extId, ext }) => {
  const page = await context.newPage();
  await page.goto(`${origin.a}/article.html`);
  const tab = await tabId(ext, `${origin.a}/*`);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
  await expect(popup.locator('#count')).toHaveText('No notes on this page');
  await expect(popup.locator('#access')).toBeHidden();

  // As if the reader set the extension to some sites only. Chromium does not let a test take a
  // required permission away, so this popup's view of it is replaced.
  const limited = await context.newPage();
  await limited.addInitScript(() => {
    const p = chrome.permissions;
    const contains = p.contains.bind(p);
    p.contains = (async (q: chrome.permissions.Permissions) =>
      q.origins?.length ? false : contains(q)) as typeof p.contains;
  });
  await limited.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
  await expect(limited.locator('#access')).toBeVisible();
  await expect(limited.locator('#access-go')).toHaveText(
    /needs permission for websites\. Click this, then choose Allow\.$/,
  );
  // A click that the browser does not turn into a prompt leaves the line saying where the switch is.
  await limited.evaluate(() => {
    chrome.permissions.request = (async () => false) as typeof chrome.permissions.request;
  });
  await limited.locator('#access-go').click();
  await expect(limited.locator('#access-go')).toHaveText(/extension settings/);
});

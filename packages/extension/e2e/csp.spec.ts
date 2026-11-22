/**
 * Strict style policies. Many sites send style-src without 'unsafe-inline',
 * and the extension's own pages do too. Ink must look right there and cause
 * no policy violation at all.
 */
import type { Page } from '@playwright/test';
import { note, record, seed } from '../src/testing/records';
import {
  barClick,
  centre,
  expect,
  inLayer,
  layerInfo,
  ring,
  STRICT_CSP,
  seedStorage,
  stroke,
  test,
  textBox,
} from './fixtures';
import { pdfServer, ready, viewerOf } from './pdf-kit';

/** Policy problems seen by the page: violation events and console messages. */
async function watchPolicy(page: Page): Promise<() => Promise<string[]>> {
  const said: string[] = [];
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to apply/i.test(t)) said.push(t);
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener(
      'securitypolicyviolation',
      (e) => w.__violations.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`),
      true,
    );
  });
  return async () => {
    const seen = await page
      .evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])
      .catch(() => [] as string[]);
    return [...said, ...seen];
  };
}

test('a page with a strict style policy: ink, bar and tray are styled and nothing is refused', async ({
  context,
  origin,
  ext,
}) => {
  const url = `${origin.a}/csp.html`;
  // One note whose words are not on the page, so the tray has something to show.
  await seedStorage(ext, seed(record(url, [note('gone', 'words that are not on this page')])));
  const page = await context.newPage();
  const problems = await watchPolicy(page);
  const res = await page.goto(url);
  expect(res?.headers()['content-security-policy']).toBe(STRICT_CSP);

  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);
  const info = (await layerInfo(page))!;
  // The ring sits on its word.
  const n = info.notes[0]!.box;
  expect(Math.abs(n.x + n.w / 2 - (w.x + w.w / 2))).toBeLessThan(6);
  expect(Math.abs(n.y + n.h / 2 - (w.y + w.h / 2))).toBeLessThan(6);
  expect(info.bar?.tray).toBe('1');

  const look = () =>
    inLayer(page, (root) => {
      const cs = (sel: string) => {
        const el = root.querySelector(sel);
        return el ? getComputedStyle(el) : null;
      };
      const host = getComputedStyle(root.host);
      const bar = cs('.iu .bar');
      const tray = cs('.iu .tray');
      const path = root.querySelector('path[data-stroke]');
      return {
        host: { display: host.display, pointer: host.pointerEvents },
        bar: bar && { position: bar.position, display: bar.display, radius: bar.borderTopLeftRadius },
        tray: tray && { position: tray.position, display: tray.display, bg: tray.backgroundColor },
        surface: cs('svg.s')?.position,
        fill: path ? getComputedStyle(path).fill : null,
      };
    });
  let l = (await look())!;
  // The host has no box, so the browser can never give it a layer of its own.
  expect(l.host).toEqual({ display: 'contents', pointer: 'none' });
  expect(l.bar).toEqual({ position: 'fixed', display: 'flex', radius: '14px' });
  expect(l.surface).toBe('absolute');
  expect(l.fill).not.toBe('rgb(0, 0, 0)');

  await barClick(page, 'Moved notes, 1');
  await expect.poll(async () => (await look())?.tray?.display).toBe('flex');
  l = (await look())!;
  expect(l.tray?.position).toBe('fixed');
  expect(l.tray?.bg).not.toBe('rgba(0, 0, 0, 0)');

  await page.waitForTimeout(300);
  expect(await problems()).toEqual([]);
});

test('the PDF viewer page shows no policy warnings', async ({ context }) => {
  const srv = await pdfServer();
  try {
    const page = await context.newPage();
    const said: string[] = [];
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to apply/i.test(m.text())) said.push(m.text());
    });
    await page.goto(`${srv.url}/doc.pdf`);
    const v = await viewerOf(page);
    await ready(v);
    const bar = await inLayer(v, (root) => {
      const el = root.querySelector('.iu .bar');
      return el && getComputedStyle(el).display;
    });
    expect(bar).toBe('flex');
    await page.waitForTimeout(300);
    expect(said).toEqual([]);
  } finally {
    srv.close();
  }
});

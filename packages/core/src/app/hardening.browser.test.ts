import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { memoryKV } from '../store/memory';
import {
  centreIn,
  closeAll,
  drawnOn,
  filler,
  loop,
  openViewer,
  settle,
  stroke,
  textRect,
  until,
} from './testkit';

beforeAll(async () => {
  await page.viewport(900, 700);
});
afterAll(async () => {
  await page.viewport(414, 896);
});
afterEach(() => {
  closeAll();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  window.scrollTo(0, 0);
});

const el = (id: string) => document.getElementById(id)!;

function paragraphs(n: number): string {
  return Array.from(
    { length: n },
    (_, i) => `<p id="s${i}">Section ${i} begins. ${filler(i + 5, 30)}.</p>`,
  ).join('');
}

/** Client rect to the document space ink uses: window scroll only. */
const doc = (r: DOMRect) => ({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height });

describe('pages that scroll on an element, not the window', () => {
  const cases = {
    body: () => {
      document.documentElement.style.cssText = 'height:100%;overflow:hidden';
      document.body.style.cssText = 'height:100%;margin:0;overflow:auto;font:18px/1.6 serif';
      document.body.innerHTML = `<main style="width:560px;margin:20px 40px">${paragraphs(30)}</main>`;
      return document.body;
    },
    'an app container': () => {
      document.body.style.cssText = 'margin:0;font:18px/1.6 serif';
      document.body.innerHTML = `<div id="app" style="position:fixed;inset:0;overflow-y:auto"><main style="width:560px;margin:20px 40px">${paragraphs(30)}</main></div>`;
      return el('app');
    },
  } as const;

  for (const [name, make] of Object.entries(cases)) {
    test(`${name}: ink is written, follows the scroll and comes back after reload`, async () => {
      const scroller = make();
      const at = (top: number) => {
        scroller.scrollTop += el('s12').getBoundingClientRect().top - top;
      };
      at(250);
      await settle();
      expect(window.scrollY).toBe(0);
      const kv = memoryKV();
      const a = await openViewer(kv);
      await a.cmd();
      const word = () => doc(textRect(el('s12'), 'Section 12'));
      await stroke(loop(textRect(el('s12'), 'Section 12')));
      await until(() => a.notes().length === 1, 'note');
      const n = a.notes()[0]!;
      expect(n.anchor.scroller).toBeDefined();
      await settle();
      expect(centreIn(a.placed(n.id)!.bbox, word())).toBe(true);

      at(400);
      await until(() => centreIn(a.placed(n.id)!.bbox, word(), 1), 'follow the scroll');
      await until(() => drawnOn(a, n.id, word(), 1), 'drawn ink follows the scroll');
      a.viewer.destroy();

      at(150);
      const b = await openViewer(kv);
      await b.viewer.ready;
      await b.cmd();
      await settle();
      expect(centreIn(b.placed(n.id)!.bbox, word(), 1)).toBe(true);
      expect(drawnOn(b, n.id, word(), 1)).toBe(true);
      at(300);
      await until(() => drawnOn(b, n.id, word(), 1), 'drawn ink follows after reload');
    });
  }
});

/** The zoom el is drawn at: currentCSSZoom, or where the engine lacks it, the computed zooms up the tree. */
function drawnZoom(el: Element): number {
  const z = (el as Element & { currentCSSZoom?: number }).currentCSSZoom;
  if (typeof z === 'number') return z;
  let k = 1;
  for (let e: Element | null = el; e; e = e.parentElement)
    k *= Number.parseFloat(getComputedStyle(e).zoom) || 1;
  return k;
}

describe('zoom and transforms on <html>', () => {
  test('under CSS zoom ink is written and placed on its words', async () => {
    document.body.style.cssText = 'margin:0;font:16px/1.6 serif';
    document.body.innerHTML = `<main style="width:500px;margin:20px 40px">${paragraphs(8)}</main>`;
    document.documentElement.style.zoom = '1.25';
    const kv = memoryKV();
    const a = await openViewer(kv);
    await a.cmd();
    await stroke(loop(textRect(el('s3'), 'Section 3')));
    await until(() => a.notes().length === 1, 'note');
    const n = a.notes()[0]!;
    await settle();
    const word = () => doc(textRect(el('s3'), 'Section 3'));
    expect(centreIn(a.placed(n.id)!.bbox, word())).toBe(true);
    expect(drawnOn(a, n.id, word())).toBe(true);
    // The layer cancels the zoom, so what is drawn is where the placer says.
    const host = document.querySelector('ink-layer') as HTMLElement;
    expect(drawnZoom(host)).toBeCloseTo(1, 3);
    a.viewer.destroy();

    // Written without zoom, shown with zoom: placed and scaled with the text.
    document.documentElement.style.zoom = '';
    const c = await openViewer(kv);
    await c.viewer.ready;
    await c.cmd();
    await settle();
    expect(c.placed(n.id)!.scale).toBeCloseTo(1 / 1.25, 2);
    expect(centreIn(c.placed(n.id)!.bbox, word())).toBe(true);
    expect(drawnOn(c, n.id, word())).toBe(true);
  });

  test('a scaling transform on <html> hides ink instead of showing it in the wrong place', async () => {
    document.body.style.cssText = 'margin:0;font:16px/1.6 serif';
    document.body.innerHTML = `<main style="width:500px;margin:20px 40px">${paragraphs(6)}</main>`;
    const kv = memoryKV();
    const a = await openViewer(kv);
    await a.cmd();
    await stroke(loop(textRect(el('s2'), 'Section 2')));
    await until(() => a.notes().length === 1, 'note');
    await settle();
    const id = a.notes()[0]!.id;
    // Find the drawn group: the layer is closed, so look through the layer API.
    const shown = () => {
      const svg = a.v!.layer.toSVG({ x: 0, y: 0, w: 2000, h: 4000 });
      return svg.includes('<path');
    };
    expect(shown()).toBe(true);
    const host = document.querySelector('ink-layer') as HTMLElement;
    const visibleSurfaces = () =>
      [...(a.v!.layer.root.querySelectorAll('svg.s') as NodeListOf<SVGSVGElement>)].filter(
        (s) => getComputedStyle(s).display !== 'none',
      ).length;
    expect(visibleSurfaces()).toBe(4);
    document.documentElement.style.transform = 'scale(0.8)';
    a.v!.placer.refresh();
    await until(() => visibleSurfaces() === 0, 'hidden');
    // A plain translation is fine: the host offset cancels it.
    document.documentElement.style.transform = 'translate(10px, 20px)';
    a.v!.placer.refresh();
    await until(() => visibleSurfaces() === 4, 'shown again');
    expect(a.placed(id)).toBeDefined();
    expect(host.isConnected).toBe(true);
  });
});

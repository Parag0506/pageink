// The bar in the real viewer, with capture running: the reader can move it out of the way with
// any pointer, and at the end of a page the last line comes clear of it and takes ink.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { swipeAlong, touchEmulation } from '../capture/testkit';
import {
  ARTICLE_STYLE,
  articleHtml,
  closeAll,
  isChromium,
  line,
  NEEDS_CDP,
  openViewer,
  type Rig,
  setPage,
  settle,
  stroke,
  until,
} from './testkit';

beforeAll(async () => {
  await page.viewport(900, 800);
  await touchEmulation(true);
});
// Emulated touch makes the pointer coarse for every later file in this browser.
afterAll(async () => {
  await touchEmulation(false);
  await page.viewport(414, 896);
});
afterEach(() => {
  closeAll();
  document.body.innerHTML = '';
  scrollTo(0, 0);
});

type Pointer = 'pen' | 'touch' | 'mouse';

const ui = (rig: Rig) => rig.v!.layer.ui.querySelector('.iu') as HTMLElement;
const edgeOf = (rig: Rig) => ui(rig).getAttribute('data-edge');
const rectOf = (rig: Rig, sel: string) => (ui(rig).querySelector(sel) as HTMLElement).getBoundingClientRect();
const onScreen = (r: DOMRect) =>
  r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;

async function drag(kind: Pointer, pts: [number, number][]): Promise<void> {
  if (kind !== 'touch') return stroke(pts, kind);
  await swipeAlong([pts]);
}

/** Drag the bar by its grip to the middle of an edge. */
async function dragBarTo(rig: Rig, edge: string, kind: Pointer): Promise<void> {
  const g = rectOf(rig, '.grip');
  const to: Record<string, [number, number]> = {
    left: [12, innerHeight / 2],
    right: [innerWidth - 12, innerHeight / 2],
    top: [innerWidth / 2, 12],
    bottom: [innerWidth / 2, innerHeight - 12],
  };
  await drag(kind, line([g.left + g.width / 2, g.top + g.height / 2], to[edge]!, 8));
  await until(() => edgeOf(rig) === edge, `bar on the ${edge} edge`);
}

async function drawing(html: string): Promise<Rig> {
  setPage(html);
  const rig = await openViewer();
  (await rig.cmd()).setDraw(true);
  await settle();
  return rig;
}

describe('moving the bar while drawing', () => {
  // The bar sits in a closed shadow root. Only real input finds the grip in it: the mouse is
  // real in every engine, pen and touch in Chromium.
  for (const kind of ['mouse', 'pen', 'touch'] as const) {
    test.runIf(kind === 'mouse' || isChromium)(
      `a ${kind} on the grip moves the bar to another edge and writes no ink${kind === 'mouse' ? '' : ` (${NEEDS_CDP})`}`,
      async () => {
        const rig = await drawing(articleHtml());
        for (const edge of edgeOf(rig) === 'left' ? ['top', 'left'] : ['left', 'top']) {
          await dragBarTo(rig, edge, kind);
          expect(onScreen(rectOf(rig, '.bar'))).toBe(true);
        }
        await settle();
        expect(rig.notes()).toHaveLength(0);
        // Where the bar was, the page takes ink again.
        await stroke(line([300, innerHeight - 30], [420, innerHeight - 30]), 'pen');
        await until(() => rig.notes().length === 1, 'a note where the bar was');
      },
    );
  }
});

describe('the end of the page', () => {
  test('scrolled to the end, the last line is clear of a bar at the bottom and takes ink', async () => {
    const rig = await drawing(
      `<style>${ARTICLE_STYLE}</style><main style="width:800px"><div style="height:3000px"></div>` +
        '<p id="last" style="margin:0;white-space:nowrap">The last line of the page runs on and on, right across to the far side.</p></main>',
    );
    if (edgeOf(rig) !== 'bottom') await dragBarTo(rig, 'bottom', 'mouse');
    scrollTo(0, 1e7);
    await settle();
    scrollTo(0, 1e7);
    const last = (document.getElementById('last') as HTMLElement).getBoundingClientRect();
    const bar = rectOf(rig, '.bar');
    expect(last.bottom).toBeLessThanOrEqual(bar.top);
    // A stroke on the words right above the middle of the bar.
    const x = bar.left + bar.width / 2;
    const y = last.top + last.height / 2;
    expect(last.left).toBeLessThan(x - 60);
    expect(last.right).toBeGreaterThan(x + 60);
    await stroke(line([x - 50, y], [x + 50, y + 1]), 'pen');
    await until(() => rig.notes().length === 1, 'ink on the last line');
  });
});

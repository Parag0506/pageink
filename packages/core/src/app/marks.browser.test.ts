// A pen line under words becomes a mark on those words, wherever they sit on the line. DESIGN 7.3.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { memoryKV } from '../store/memory';
import type { Rect } from '../types';
import { closeAll, line, openViewer, type Rig, setPage, settle, stroke, until } from './testkit';

beforeAll(async () => {
  await page.viewport(900, 800);
});
afterAll(async () => {
  await page.viewport(414, 896);
});
afterEach(() => {
  closeAll();
  document.body.innerHTML = '';
  window.scrollTo(0, 0);
});

/** A paragraph of short sentences with links and raised note markers, some at line ends. */
const PAGE = `<style>body{margin:0;font:16px/1.6 sans-serif;color:#222}</style><main id="main" style="width:420px;margin:20px 40px"><p id="lk">${Array.from(
  { length: 10 },
  (_, i) =>
    `The <a href="#a${i}">orchard ${i} keeps</a> its pears near the river, and${i % 3 === 0 ? `<sup><a href="#n">[${i + 1}]</a></sup>` : ''} the gardener writes.`,
).join(' ')}</p></main>`;

/** Words with their client rects; a word that runs into a marker is one word. */
function words(el: Element): { text: string; rects: DOMRect[] }[] {
  const out: { text: string; rects: DOMRect[] }[] = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let glue = false;
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    const re = /\S+/g;
    for (let m = re.exec(n.data); m; m = re.exec(n.data)) {
      const r = document.createRange();
      r.setStart(n, m.index);
      r.setEnd(n, m.index + m[0].length);
      const rects = [...r.getClientRects()].filter((q) => q.width > 0);
      if (glue && m.index === 0 && out.length) {
        out[out.length - 1]!.text += m[0];
        out[out.length - 1]!.rects.push(...rects);
      } else out.push({ text: m[0], rects });
      glue = false;
    }
    glue = !/\s$/.test(n.data);
  }
  return out;
}

/**
 * Makes the first sentence's "and[1] the" end the first line, whatever the font: with the column
 * wide, the sentence sits on one line from the paragraph's start, so a column as wide as the text
 * up to "the" keeps that text on the first line and sends the next word to the second.
 */
function markerAtLineEnd(): { a: DOMRect; b: DOMRect; text: string } {
  const main = document.getElementById('main')!;
  const lk = document.getElementById('lk')!;
  main.style.width = '2000px';
  const k = words(lk).findIndex((w) => w.text.includes('['));
  const first = words(lk);
  const left = lk.getBoundingClientRect().left;
  const end = first[k + 1]!.rects.at(-1)!.right;
  main.style.width = `${Math.ceil(end - left) + 1}px`;
  const ws = words(lk);
  const a = ws[k]!;
  const b = ws[k + 1]!;
  const ra = a.rects[0]!;
  const rb = b.rects.at(-1)!;
  // The phrase is on one line, and it ends that line.
  expect(Math.abs(ra.top - rb.top)).toBeLessThan(2);
  expect(ws[k + 2]!.rects[0]!.top).toBeGreaterThan(rb.top + 2);
  return { a: ra, b: rb, text: `${a.text} ${b.text}` };
}

async function underline(rig: Rig, a: DOMRect, b: DOMRect): Promise<string> {
  const before = new Set(rig.notes().map((n) => n.id));
  const y = Math.max(a.bottom, b.bottom) + 1;
  await stroke(line([a.left + 2, y], [b.right + 3, y], 16));
  await until(() => rig.notes().some((n) => !before.has(n.id)), 'new note');
  const n = rig.notes().find((x) => !before.has(x.id))!;
  await until(() => !!rig.placed(n.id), 'placed');
  return n.id;
}

const covers = (box: Rect, left: number, right: number): boolean =>
  box.x <= left + scrollX + 1 && box.x + box.w >= right + scrollX - 1;

describe('pen underlines', () => {
  test('a phrase that ends a line, with a note marker in it, is marked whole', async () => {
    setPage(PAGE);
    const kv = memoryKV();
    const rig = await openViewer(kv);
    await rig.cmd();
    const { a, b, text } = markerAtLineEnd();
    const id = await underline(rig, a, b);
    const n = rig.notes().find((x) => x.id === id)!;
    expect(n.kind).toBe('textmark');
    expect(n.mark?.style).toBe('underline');
    expect(n.anchor.quote.exact).toBe(text);
    await settle();
    expect(covers(rig.placed(id)!.bbox, a.left, b.right)).toBe(true);
    rig.viewer.destroy();

    // After a reload, and after the text reflows, the mark still covers its words.
    const again = await openViewer(kv);
    await again.viewer.ready;
    await again.cmd();
    await until(() => !!again.placed(id), 'placed after reload');
    expect(covers(again.placed(id)!.bbox, a.left, b.right)).toBe(true);
    const main = document.getElementById('main')!;
    main.style.width = `${Math.round(main.getBoundingClientRect().width * 0.7)}px`;
    await until(() => {
      const p = again.placed(id);
      const now = words(document.getElementById('lk')!).find((w) => w.text === text.split(' ')[0]);
      return !!p && !!now && Math.abs(p.bbox.x - (now.rects[0]!.left + scrollX)) < 1;
    }, 'reflow');
    const all = again.placed(id)!.bbox;
    expect(all.w).toBeGreaterThan(b.right - a.left - 2);
  });
});

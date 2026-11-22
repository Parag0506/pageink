import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { penBurst } from '../capture/testkit';
import { memoryKV } from '../store/memory';
import {
  articleHtml,
  centreIn,
  closeAll,
  line,
  loop,
  mouseInput,
  openViewer,
  type Rig,
  setPage,
  settle,
  stroke,
  textRect,
  toDocRect,
  until,
  wait,
} from './testkit';

beforeAll(async () => {
  await page.viewport(900, 800);
});
afterAll(async () => {
  await page.viewport(414, 896);
});
afterEach(() => {
  closeAll();
  document.body.innerHTML = '';
});

const el = (id: string) => document.getElementById(id)!;

/** How many lines the first occurrence of text inside el takes. */
function wordLines(root: Element, text: string): number {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = (n as Text).data.indexOf(text);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + text.length);
    return new Set([...r.getClientRects()].filter((c) => c.width > 0).map((c) => Math.round(c.top))).size;
  }
  throw new Error(`text not found: ${text}`);
}

async function writeLoop(rig: Rig, r: DOMRect): Promise<string> {
  const before = new Set(rig.notes().map((n) => n.id));
  await stroke(loop(r));
  await until(() => rig.notes().some((n) => !before.has(n.id)), 'new note');
  const n = rig.notes().find((x) => !before.has(x.id))!;
  await until(() => !!rig.placed(n.id), 'placed');
  return n.id;
}

/** Two separate notes far enough apart in time and space not to group. */
async function twoNotes(rig: Rig): Promise<[string, string]> {
  const a = await writeLoop(rig, textRect(el('p1'), 'Paragraph 1'));
  await wait(1600);
  const b = await writeLoop(rig, textRect(el('p3'), 'Paragraph 3'));
  return [a, b];
}

describe('writing', () => {
  test('strokes written close together form one note; later ones start another', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    await rig.cmd();
    const r = textRect(el('p1'), 'Paragraph 1');
    await stroke(loop(r));
    await until(() => rig.notes().length === 1, 'first');
    await stroke(line([r.right + 4, r.top], [r.right + 30, r.bottom + 6]));
    await until(() => rig.notes()[0]?.strokes.length === 2, 'joined');
    expect(rig.notes()).toHaveLength(1);
    await wait(1600);
    await stroke(loop(textRect(el('p5'), 'Paragraph 5')));
    await until(() => rig.notes().length === 2, 'second note');
  });

  test('a straight highlighter line over text becomes a text mark that rewraps', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    const cmd = await rig.cmd();
    cmd.setTool('hi');
    expect(rig.viewer.state().color).toBe('hi-1');
    const r = textRect(el('w-line'), 'Bright yellow marks');
    const y = r.top + r.height / 2;
    await stroke(line([r.left + 2, y], [r.right - 2, y], 16));

    await until(() => rig.notes().length === 1, 'mark');
    const n = rig.notes()[0]!;
    expect(n.kind).toBe('textmark');
    expect(n.mark?.style).toBe('highlight');
    expect(n.anchor.quote.exact).toBe('Bright yellow marks');
    await until(() => !!rig.placed(n.id), 'placed');
    const wide = rig.placed(n.id)!.bbox;
    // The words sit on one line in the wide column.
    expect(wordLines(el('w-line'), 'Bright yellow marks')).toBe(1);
    const span = el('w-line');
    const words = toDocRect(textRect(span, 'Bright yellow marks'));
    expect(centreIn(wide, words)).toBe(true);
    // A column narrower than the words cannot hold them on one line, whatever the font and
    // wherever the reflow puts them, so they wrap.
    el('main').style.width = `${Math.floor(r.width * 0.6)}px`;
    expect(wordLines(el('w-line'), 'Bright yellow marks')).toBeGreaterThan(1);
    await until(() => (rig.placed(n.id)?.bbox.h ?? 0) > wide.h * 1.5, 'rewrap');
  });

  test('a pen underline becomes an underline mark', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    await rig.cmd();
    const r = textRect(el('w-line'), 'Bright yellow marks');
    const y = r.bottom - 2;
    await stroke(line([r.left + 2, y], [r.right - 2, y], 16));

    await until(() => rig.notes().length === 1, 'mark');
    expect(rig.notes()[0]!.mark?.style).toBe('underline');
  });

  test('the eraser removes the strokes it touches, and text marks', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    const cmd = await rig.cmd();
    const id = await writeLoop(rig, textRect(el('p1'), 'Paragraph 1'));
    const pl = rig.placed(id)!;
    cmd.setTool('eraser');
    const y = pl.bbox.y - scrollY + pl.bbox.h / 2;
    await stroke(line([pl.bbox.x - 20, y], [pl.bbox.x + pl.bbox.w + 20, y], 20));
    await until(() => rig.notes().length === 0, 'erased');

    cmd.setTool('hi');
    const r = textRect(el('w-line'), 'Bright yellow');
    await stroke(line([r.left + 2, r.top + r.height / 2], [r.right - 2, r.top + r.height / 2], 16));

    await until(() => rig.notes().length === 1, 'mark');
    // The eraser removes what is placed. A mark is placed a moment after it is made, and
    // outside Chromium the whole eraser stroke can pass before that.
    const mark = rig.notes()[0]!.id;
    await until(() => !!rig.placed(mark), 'mark placed');
    cmd.setTool('eraser');
    await stroke(line([r.left + 20, r.top - 10], [r.left + 24, r.bottom + 10], 10));
    await until(() => rig.notes().length === 0, 'mark erased');
  });

  test('undo and redo walk back and forth through several steps', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    const cmd = await rig.cmd();
    expect(rig.viewer.state().canUndo).toBe(false);
    const [a, b] = await twoNotes(rig);
    expect(rig.viewer.state().canUndo).toBe(true);
    cmd.deleteNotes([a]);
    expect(rig.notes().map((n) => n.id)).toEqual([b]);
    cmd.undo();
    expect(rig.notes()).toHaveLength(2);
    cmd.undo();
    expect(rig.notes()).toHaveLength(1);
    cmd.undo();
    expect(rig.notes()).toHaveLength(0);
    expect(rig.viewer.state().canUndo).toBe(false);
    expect(rig.viewer.state().canRedo).toBe(true);
    cmd.redo();
    cmd.redo();
    expect(rig.notes()).toHaveLength(2);
    cmd.redo();
    expect(rig.notes()).toHaveLength(1);
    expect(rig.viewer.state().canRedo).toBe(false);
    // What comes back is placed again where it was.
    const back = rig.notes()[0]!;
    await until(() => !!rig.placed(back.id), 'placed');
    expect(centreIn(rig.placed(back.id)!.bbox, toDocRect(textRect(el('p3'), 'Paragraph 3')), 12)).toBe(true);
  });

  test('clear page removes all ink for good: tombstones, no undo, and it is saved', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const rig = await openViewer(kv);
    const cmd = await rig.cmd();
    const [first] = await twoNotes(rig);
    // A single deleted note stays undoable until the page is cleared.
    cmd.deleteNotes([first]);
    cmd.undo();
    expect(rig.notes()).toHaveLength(2);
    const [a, b] = rig.notes().map((n) => n.id) as [string, string];
    const strokes = rig.notes().flatMap((n) => n.strokes.map((s) => s.id));
    cmd.clearPage();
    expect(rig.notes()).toHaveLength(0);
    const dead = new Set(rig.v!.record().deleted.map((d) => d.id));
    for (const id of [a, b, ...strokes]) expect(dead.has(id), id).toBe(true);
    expect(rig.viewer.state()).toMatchObject({ canUndo: false, canRedo: false, notes: 0, tray: 0 });
    cmd.undo();
    expect(rig.notes()).toHaveLength(0);
    // It syncs like any other change: storage holds the tombstones, so nothing comes back.
    const saved = async () => {
      const keys = await kv.keys('p:');
      const got = await kv.get(keys);
      return Object.values(got) as { notes: unknown[]; deleted: { id: string }[] }[];
    };
    await vi.waitFor(
      async () => {
        const recs = await saved();
        if (!recs.some((r) => r.notes.length === 0 && r.deleted.some((d) => d.id === b)))
          throw new Error('not saved');
      },
      { timeout: 15_000 },
    );
    const recs = await saved();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.notes).toEqual([]);
    expect(recs[0]!.deleted.map((d) => d.id)).toEqual(expect.arrayContaining([a, b, ...strokes]));
    const again = await openViewer(kv);
    await again.viewer.ready;
    expect(again.viewer.state().notes).toBe(0);
  });
});

describe('lasso', () => {
  const lassoAround = (r: { x: number; y: number; w: number; h: number }): [number, number][] => {
    const x0 = r.x - scrollX - 14;
    const y0 = r.y - scrollY - 14;
    const x1 = r.x - scrollX + r.w + 14;
    const y1 = r.y - scrollY + r.h + 14;
    return [
      ...line([x0, y0], [x1, y0], 6),
      ...line([x1, y0], [x1, y1], 6),
      ...line([x1, y1], [x0, y1], 6),
      [x0, y0 + 2],
    ];
  };

  test('select, drag to move, join and split', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    const cmd = await rig.cmd();
    const [a, b] = await twoNotes(rig);
    cmd.setTool('lasso');
    const ba = rig.placed(a)!.bbox;
    await stroke(lassoAround(ba));
    await until(() => rig.viewer.state().selected.length === 1, 'selected');
    expect(rig.viewer.state().selected).toEqual([a]);

    // Drag the selection down onto paragraph 5.
    const p5 = textRect(el('p5'), 'Paragraph 5');
    const from: [number, number] = [ba.x - scrollX + ba.w / 2, ba.y - scrollY + ba.h / 2];
    const to: [number, number] = [p5.left + p5.width / 2, p5.top + p5.height / 2];
    await stroke(line(from, to, 10));
    await until(() => !rig.notes().some((n) => n.id === a), 'moved');
    const moved = rig.viewer.state().selected[0]!;
    const mn = rig.notes().find((n) => n.id === moved)!;
    expect(mn.anchor.quote.exact).toContain('Paragraph 5');
    await settle();
    expect(centreIn(rig.placed(moved)!.bbox, toDocRect(p5), 8)).toBe(true);

    // Select both and join.
    const bb = rig.placed(b)!.bbox;
    const mb = rig.placed(moved)!.bbox;
    const all = {
      x: Math.min(bb.x, mb.x),
      y: Math.min(bb.y, mb.y),
      w: Math.max(bb.x + bb.w, mb.x + mb.w) - Math.min(bb.x, mb.x),
      h: Math.max(bb.y + bb.h, mb.y + mb.h) - Math.min(bb.y, mb.y),
    };
    cmd.clearSelection();
    await stroke(lassoAround(all));
    await until(() => rig.viewer.state().selected.length === 2, 'two selected');
    cmd.joinSelected();
    expect(rig.notes()).toHaveLength(1);
    const joined = rig.notes()[0]!;
    expect(joined.strokes).toHaveLength(2);
    await settle();
    // Joining moves no ink.
    expect(rig.placed(joined.id)!.bbox.y).toBeCloseTo(all.y, 0);

    // Lasso only the lower stroke and split it out.
    cmd.clearSelection();
    await stroke(lassoAround(mb));
    await until(() => rig.viewer.state().selected.length === 1, 'partial');
    cmd.splitSelected();
    expect(rig.notes()).toHaveLength(2);
    expect(rig.notes().every((n) => n.strokes.length === 1)).toBe(true);
    await settle();
    const lower = rig.notes().find((n) => n.id !== joined.id)!;
    expect(lower.anchor.quote.exact).toContain('Paragraph 5');
    expect(centreIn(rig.placed(lower.id)!.bbox, toDocRect(p5), 8)).toBe(true);
    // Undo walks back the split.
    cmd.undo();
    expect(rig.notes()).toHaveLength(1);
  });

  test('a drag whose last moves come in the same frame as the lift lands where the pen lifted', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    const cmd = await rig.cmd();
    const [a] = await twoNotes(rig);
    cmd.setTool('lasso');
    const ba = rig.placed(a)!.bbox;
    await stroke(lassoAround(ba));
    await until(() => rig.viewer.state().selected.length === 1, 'selected');
    const p5 = textRect(el('p5'), 'Paragraph 5');
    const from: [number, number] = [ba.x - scrollX + ba.w / 2, ba.y - scrollY + ba.h / 2];
    const to: [number, number] = [p5.left + p5.width / 2, p5.top + p5.height / 2];
    penBurst(line(from, to, 10));
    await until(() => !rig.notes().some((n) => n.id === a), 'moved');
    const mn = rig.notes().find((n) => n.id === rig.viewer.state().selected[0])!;
    expect(mn.anchor.quote.exact).toContain('Paragraph 5');
  });
});

describe('lasso drag', () => {
  test('dragging part of a note moves only the selected strokes while the pen is down', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    const cmd = await rig.cmd();
    const r = textRect(el('p1'), 'Paragraph 1');
    await stroke(loop(r));
    await until(() => rig.notes().length === 1, 'first');
    await stroke(line([r.right + 12, r.top], [r.right + 34, r.bottom + 6]));
    await until(() => rig.notes()[0]?.strokes.length === 2, 'joined');
    const note = rig.notes()[0]!;
    const ring = note.strokes[0]!;
    const tick = note.strokes[1]!;
    await settle();
    cmd.setTool('lasso');
    const x0 = r.right + 4;
    const x1 = r.right + 46;
    const y0 = r.top - 10;
    const y1 = r.bottom + 16;
    await stroke([
      ...line([x0, y0], [x1, y0], 6),
      ...line([x1, y0], [x1, y1], 6),
      ...line([x1, y1], [x0, y1], 6),
      [x0, y0 + 2],
    ]);
    await until(() => rig.viewer.state().selected.length === 1, 'partial selection');

    const box = (id: string) =>
      rig.v!.layer.root.querySelector(`[data-stroke="${id}"]`)!.getBoundingClientRect();
    const ring0 = box(ring.id);
    const tick0 = box(tick.id);
    const at = (x: number, y: number, type: 'mousePressed' | 'mouseMoved' | 'mouseReleased', down = true) =>
      mouseInput(type, x, y, 'pen', { down });
    const fx = tick0.left + tick0.width / 2;
    const fy = tick0.top + tick0.height / 2;
    await at(fx, fy, 'mouseMoved', false);
    await at(fx, fy, 'mousePressed');
    for (let i = 1; i <= 8; i++) await at(fx, fy + i * 15, 'mouseMoved');
    await settle();
    // Mid drag: the selected stroke follows the pen, the rest of the note stays.
    expect(box(tick.id).top - tick0.top).toBeGreaterThan(100);
    expect(box(ring.id).top).toBeCloseTo(ring0.top, 0);
    await at(fx, fy + 120, 'mouseReleased');
    await until(() => rig.notes().length === 2, 'split by the drag');
    await settle();
    expect(box(ring.id).top).toBeCloseTo(ring0.top, 0);
    expect(rig.v!.layer.root.querySelectorAll(`[data-stroke="${tick.id}"]`).length).toBe(0);
  });
});

describe('commands', () => {
  test('export Markdown writes the quotes of this page', async () => {
    setPage(articleHtml());
    const saved: { name: string; data: Blob }[] = [];
    const rig = await openViewer(memoryKV(), {
      hooks: { saveFile: async (name, data) => void saved.push({ name, data }) },
    });
    const cmd = await rig.cmd();
    await writeLoop(rig, el('w-target').getBoundingClientRect());
    await cmd.exportMarkdown();
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toMatch(/\.md$/);
    const md = await saved[0]!.data.text();
    expect(md).toContain('# Notes');
    expect(md).toContain('pomegranate');
    expect(md).toContain('Handwriting');
  });

  test('export image saves a PNG of the ink in view', async () => {
    setPage(articleHtml());
    const saved: Blob[] = [];
    const rig = await openViewer(memoryKV(), { hooks: { saveFile: async (_n, d) => void saved.push(d) } });
    const cmd = await rig.cmd();
    await writeLoop(rig, el('w-target').getBoundingClientRect());
    await cmd.exportImage();
    expect(saved[0]!.type).toBe('image/png');
    expect(saved[0]!.size).toBeGreaterThan(500);
  });

  test('copy for chat writes the text in view and a picture as one item', async () => {
    setPage(articleHtml());
    const rig = await openViewer();
    const cmd = await rig.cmd();
    await writeLoop(rig, el('w-target').getBoundingClientRect());
    const items: ClipboardItem[] = [];
    const texts: string[] = [];
    const clip = navigator.clipboard;
    const w = vi.spyOn(clip, 'write').mockImplementation(async (x) => void items.push(...x));
    const wt = vi.spyOn(clip, 'writeText').mockImplementation(async (t) => void texts.push(t));
    try {
      await cmd.copyForChat();
      expect(items).toHaveLength(1);
      expect(items[0]!.types).toEqual(expect.arrayContaining(['text/plain', 'image/png']));
      const text = await (await items[0]!.getType('text/plain')).text();
      expect(text).toContain('The orchard notes');
      expect(text).toContain('pomegranate grows in warm valleys');
      // Text only when the rich write is refused.
      w.mockRejectedValueOnce(new Error('no'));
      await cmd.copyForChat();
      expect(texts[0]).toContain('pomegranate');
    } finally {
      w.mockRestore();
      wt.mockRestore();
    }
  });

  test('tool and colour choices last for the session', async () => {
    setPage(articleHtml());
    const a = await openViewer();
    const cmd = await a.cmd();
    cmd.setTool('hi');
    cmd.setColor('hi-2');
    cmd.setColor('ink-2');
    expect(a.viewer.state()).toMatchObject({ tool: 'pen', color: 'ink-2' });
    cmd.setTool('hi');
    expect(a.viewer.state().color).toBe('hi-2');
    a.viewer.destroy();
    const b = await openViewer();
    await b.cmd();
    expect(b.viewer.state()).toMatchObject({ tool: 'hi', color: 'hi-2' });
  });
});

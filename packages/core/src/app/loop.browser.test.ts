import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { memoryKV } from '../store/memory';
import {
  articleHtml,
  centreIn,
  closeAll,
  drawnOn,
  loop,
  openViewer,
  setPage,
  settle,
  stroke,
  tap,
  toDocRect,
  until,
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
  document.documentElement.removeAttribute('style');
});

const target = () => document.getElementById('w-target')!;

/** Write a loop around the target word and return the new note id. */
async function circleTarget(rig: Awaited<ReturnType<typeof openViewer>>): Promise<string> {
  await rig.cmd();
  const before = rig.notes().length;
  await stroke(loop(target().getBoundingClientRect()));
  await until(() => rig.notes().length === before + 1, 'a new note');
  const n = rig.notes()[rig.notes().length - 1]!;
  await until(() => !!rig.placed(n.id), 'placement');
  return n.id;
}

describe('the full loop on an article', () => {
  test('pen ink is saved, and comes back in the same place after a reload', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const a = await openViewer(kv);
    const id = await circleTarget(a);
    const note = a.notes().find((n) => n.id === id)!;
    expect(note.kind).toBe('ink');
    expect(note.anchor.type).toBe('text');
    expect(note.anchor.quote.exact).toContain('pomegranate');
    const box = { ...a.placed(id)!.bbox };
    expect(centreIn(box, toDocRect(target().getBoundingClientRect()))).toBe(true);
    a.viewer.destroy();
    expect(document.querySelector('ink-layer')).toBeNull();

    const b = await openViewer(kv);
    await b.viewer.ready;
    expect(b.viewer.state().notes).toBe(1);
    expect(document.querySelector('ink-layer')).not.toBeNull();
    await b.cmd();
    const again = b.placed(id)!;
    expect(again.bbox.x).toBeCloseTo(box.x, 0);
    expect(again.bbox.y).toBeCloseTo(box.y, 0);
    expect(again.bbox.w).toBeCloseTo(box.w, 0);
    expect(drawnOn(b, id, target().getBoundingClientRect())).toBe(true);
  });

  test('ink stays on its words when the viewport narrows and the font grows', async () => {
    setPage(articleHtml());
    const kv = memoryKV();
    const a = await openViewer(kv);
    const id = await circleTarget(a);
    a.viewer.destroy();

    await page.viewport(420, 800);
    const main = document.getElementById('main')!;
    main.style.width = '340px';
    main.style.marginLeft = '20px';
    main.style.fontSize = '24px';
    const b = await openViewer(kv);
    await b.viewer.ready;
    await b.cmd();
    await settle();
    const pl = b.placed(id)!;
    expect(centreIn(pl.bbox, toDocRect(target().getBoundingClientRect()))).toBe(true);
    // The note grew with the text.
    expect(pl.scale).toBeCloseTo(24 / 18, 2);
    expect(drawnOn(b, id, target().getBoundingClientRect())).toBe(true);

    // And it follows a live change too.
    main.style.width = '300px';
    await until(() => {
      const p = b.placed(id);
      return !!p && centreIn(p.bbox, toDocRect(target().getBoundingClientRect()));
    }, 'replacement after resize');
    await page.viewport(900, 800);
  });

  test('ink stays when content is inserted above it', async () => {
    setPage(articleHtml());
    const a = await openViewer();
    const id = await circleTarget(a);
    const y0 = a.placed(id)!.bbox.y;
    const extra = document.createElement('p');
    extra.textContent = 'A new paragraph pushed in above everything else. '.repeat(8);
    document.getElementById('p0')!.before(extra);
    await until(() => (a.placed(id)?.bbox.y ?? 0) > y0 + 50, 'move down');
    expect(centreIn(a.placed(id)!.bbox, toDocRect(target().getBoundingClientRect()))).toBe(true);
  });

  test('a deleted passage sends the note to the tray as missing, and a tap places it again', async () => {
    setPage(articleHtml());
    const a = await openViewer();
    const id = await circleTarget(a);
    const p2 = document.getElementById('p2')!;
    p2.remove();
    await until(() => a.viewer.state().tray === 1, 'tray');
    expect(a.v!.tray()[0]!.state).toBe('waiting');
    // The page counts as settled a second after its last change.
    await until(() => a.v!.tray()[0]?.state === 'missing', 'missing');
    const item = a.v!.tray()[0]!;
    expect(item.note.id).toBe(id);
    expect(item.quote).toContain('pomegranate');

    const cmd = await a.cmd();
    cmd.place(id);
    expect(a.viewer.state().placing).toBe(id);
    const p4 = document.getElementById('p4')!.getBoundingClientRect();
    await tap(p4.left + 100, p4.top + 10);
    await until(() => a.viewer.state().tray === 0, 'tray empty');
    expect(a.viewer.state().placing).toBeUndefined();
    const moved = a.notes()[0]!;
    await until(() => !!a.placed(moved.id), 'placed');
    const pl = a.placed(moved.id)!;
    expect(Math.abs(pl.bbox.x + pl.bbox.w / 2 - (p4.left + 100 + scrollX))).toBeLessThan(3);
    expect(Math.abs(pl.bbox.y + pl.bbox.h / 2 - (p4.top + 10 + scrollY))).toBeLessThan(3);
  });
});

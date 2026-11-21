import type { Rect, ViewerInternals } from 'pageink-core/types';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { type LegacyStroke, legacySurface, migrateLegacy } from './legacy';
import { type InkHandle, mountWith } from './mount';
import { fromTest, quiet, recordingKV, stroke, until } from './testkit';

const handles: InkHandle[] = [];
beforeAll(async () => {
  await page.viewport(1000, 800);
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.destroy();
  document.body.innerHTML = '';
});

const LESSON = `
<style>
  body{margin:0;font:18px/1.6 Georgia,serif}
  .col{margin:30px 0 0 120px;width:720px}
  section{position:relative;padding:0 0 20px}
  p{margin:0 0 16px}
</style>
<div class="col" id="col">
  <section id="intro"><h2>Intro</h2><p>Opening words for the first section of the lesson.</p></section>
  <section id="waves"><h2>Waves</h2>
    <p>A wave carries energy from one place to another without carrying the water with it.</p>
    <p>The height of a wave depends on the wind speed, how long it blows, and the distance it blows over.</p>
    <p>Near the shore the wave slows down, grows taller, and finally breaks on the beach.</p>
  </section>
</div>`;

// A pen loop and a highlighter band far apart, in 720 unit column coordinates.
const OLD: LegacyStroke[] = [
  { k: 'pen', c: 1, w: 3, p: [100, 60, 5, 160, 50, 6, 220, 70, 7, 200, 110, 6, 120, 100, 5, 100, 60, 5] },
  { k: 'hi', w: 18, p: [40, 300, 5, 300, 302, 5, 560, 300, 5] },
  { k: 'pen', c: 0, w: 3, p: [-60, 150, 4, -20, 190, 6] },
];

/** Union of the drawn paths of a note, in document space. */
function drawn(v: ViewerInternals, id: string): Rect | null {
  const rs = [...v.layer.root.querySelectorAll(`g[data-note="${id}"] path`)]
    .map((p) => p.getBoundingClientRect())
    .filter((r) => r.width > 0 || r.height > 0);
  if (!rs.length) return null;
  const x0 = Math.min(...rs.map((r) => r.left));
  const y0 = Math.min(...rs.map((r) => r.top));
  const x1 = Math.max(...rs.map((r) => r.right));
  const y1 = Math.max(...rs.map((r) => r.bottom));
  return { x: x0 + scrollX, y: y0 + scrollY, w: x1 - x0, h: y1 - y0 };
}

/** Where the earlier layer drew a point: the section's corner plus the point times width / 720. */
function oldPlace(section: HTMLElement, x: number, y: number): { x: number; y: number } {
  const r = section.getBoundingClientRect();
  const k = section.clientWidth / 720;
  return { x: r.left + scrollX + x * k, y: r.top + scrollY + y * k };
}

async function mounted(): Promise<{ h: InkHandle; v: () => ViewerInternals }> {
  let v: ViewerInternals | null = null;
  const h = mountWith(
    { store: recordingKV(), page: 'lesson-waves', legacy: 'section' },
    { onInternals: (x) => (v = x), real: fromTest },
  );
  handles.push(h);
  await h.ready;
  return { h, v: () => v! };
}

describe('migrateLegacy', () => {
  test('groups strokes into notes anchored to the section surface, with stable ids', () => {
    document.body.innerHTML = LESSON;
    const sec = document.getElementById('waves')!;
    const a = migrateLegacy(sec, OLD, { now: 5 });
    const b = migrateLegacy(sec, OLD, { now: 9 });
    expect(a).toHaveLength(3);
    expect(a.map((n) => n.id)).toEqual(b.map((n) => n.id));
    expect(sec.querySelectorAll('ink-surface')).toHaveLength(1);
    for (const n of a) {
      expect(n.kind).toBe('ink');
      expect(n.anchor.type).toBe('media');
      expect(n.anchor.media?.src).toBe('legacy:waves');
      expect(n.anchor.quote.exact).toBe('Waves');
      expect(n.frame.w).toBe(720);
    }
    expect(a[0]!.strokes[0]!.color).toBe('ink-2');
    expect(a[1]!.strokes[0]!.tool).toBe('hi');
    expect(a[1]!.strokes[0]!.color).toBe('hi-1');
    expect(migrateLegacy(sec, [])).toEqual([]);
    expect(() => migrateLegacy(document.createElement('section'), OLD)).toThrow(/id/);
  });

  test('old ink keeps its place at two widths', async () => {
    document.body.innerHTML = LESSON;
    const sec = document.getElementById('waves')!;
    const { h, v } = await mounted();
    const notes = migrateLegacy(sec, OLD);
    await h.addNotes(notes);
    await until(() => h.state().notes === 3, 'three notes');

    const check = async () => {
      await until(() => notes.every((n) => drawn(v(), n.id)), 'drawn');
      const k = sec.clientWidth / 720;
      // Pen loop: points span x 100..220, y 50..110. Highlighter: x 40..560 at y 300. Margin: x -60..-20.
      const cases: [string, number, number, number, number][] = [
        [notes[0]!.id, 100, 50, 220, 110],
        [notes[1]!.id, 40, 300, 560, 302],
        [notes[2]!.id, -60, 150, -20, 190],
      ];
      for (const [id, x0, y0, x1, y1] of cases) {
        const d = drawn(v(), id)!;
        const a = oldPlace(sec, x0, y0);
        const b = oldPlace(sec, x1, y1);
        const cx = d.x + d.w / 2;
        const cy = d.y + d.h / 2;
        expect(Math.abs(cx - (a.x + b.x) / 2)).toBeLessThan(2.5);
        expect(Math.abs(cy - (a.y + b.y) / 2)).toBeLessThan(2.5);
        // Size follows the width too: the ink is no wider than the old span plus its pen width.
        expect(d.w).toBeGreaterThan((b.x - a.x) * 0.9);
        expect(d.w).toBeLessThan(b.x - a.x + 20 * k + 2);
        const pl = v().placer.get(id)!;
        expect(pl.scale).toBeCloseTo(k, 3);
      }
    };

    await check();
    // The placer starts watching an anchor's size one report after placing it, in a frame
    // quiet() waits for.
    await quiet();
    // A pass places notes in idle slices and draws them in a later frame, so wait until every
    // note has its new scale and nothing is left to run before reading what is drawn.
    const placedAt = async (scale: number, label: string) => {
      await until(
        () => notes.every((n) => Math.abs((v().placer.get(n.id)?.scale ?? 0) - scale) < 0.01),
        label,
      );
      await quiet(label);
    };
    document.getElementById('col')!.style.width = '360px';
    await placedAt(0.5, 'placed again');
    await check();

    document.getElementById('col')!.style.width = '1080px';
    await placedAt(1.5, 'placed again wider');
    await check();
  });

  test('migrating twice adds nothing, and an erased note stays erased', async () => {
    document.body.innerHTML = LESSON;
    const sec = document.getElementById('waves')!;
    const { h } = await mounted();
    await h.addNotes(migrateLegacy(sec, OLD));
    await until(() => h.state().notes === 3, 'three notes');
    await h.addNotes(migrateLegacy(sec, OLD));
    await quiet();
    expect(h.state().notes).toBe(3);
  });

  test('new ink over a migrated section still anchors to the text', async () => {
    document.body.innerHTML = LESSON;
    const sec = document.getElementById('waves')!;
    legacySurface(sec);
    const { h, v } = await mounted();
    const p = sec.querySelectorAll('p')[1]!.getBoundingClientRect();
    const pts: [number, number][] = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2.1;
      pts.push([p.left + 200 + 50 * Math.cos(a), p.top + 14 + 14 * Math.sin(a)]);
    }
    await stroke(pts);
    await until(() => h.state().notes === 1, 'new note');
    const n = v().record().notes[0]!;
    expect(n.anchor.type).not.toBe('media');
  });

  test('the legacy option makes one surface per section, once', async () => {
    document.body.innerHTML = LESSON;
    await mounted();
    expect(document.querySelectorAll('section > ink-surface')).toHaveLength(2);
    expect(document.querySelector('#intro > ink-surface')?.getAttribute('data-ink-media')).toBe(
      'legacy:intro',
    );
    legacySurface(document.getElementById('intro')!);
    expect(document.querySelectorAll('#intro > ink-surface')).toHaveLength(1);
  });
});

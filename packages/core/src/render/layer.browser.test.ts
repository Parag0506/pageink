import { afterEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { frame, shown } from '../testkit';
import type { Note, Stroke } from '../types';
import type { InkLayer } from './layer';
import { createLayer, svgToPng } from './layer';
import { markPath, seedOf } from './marks';
import { detectTheme, PALETTES, realColor } from './theme';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  window.scrollTo(0, 0);
});

function addStyle(css: string): void {
  const s = document.createElement('style');
  s.textContent = css;
  document.head.append(s);
  cleanups.push(() => s.remove());
}

function addEl<K extends keyof HTMLElementTagNameMap>(tag: K, css: string, parent: Element = document.body) {
  const el = document.createElement(tag);
  el.setAttribute('style', css);
  parent.append(el);
  cleanups.push(() => el.remove());
  return el;
}

function mkLayer(opts?: Parameters<typeof createLayer>[1]): InkLayer {
  const l = createLayer(document, opts) as InkLayer;
  cleanups.push(() => l.destroy());
  return l;
}

/** A 40 by 10 box stroke in note-local units. */
function boxStroke(id: string, tool: 'pen' | 'hi' = 'pen', color = tool === 'hi' ? 'hi-1' : 'ink-1'): Stroke {
  return { id, t: 1, tool, color, w: 2, pts: [10, 10, 50, 380, 80, 0], d: 'M0 0L40 0L40 10L0 10Z' };
}

function note(id: string, strokes: Stroke[], extra: Partial<Note> = {}): Note {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    device: 'd',
    kind: 'ink',
    anchor: {
      type: 'block',
      quote: { exact: '', prefix: '', suffix: '' },
      path: { css: 'p', xpath: '/p' },
      pos: { start: 0, end: 0 },
      hash: '',
      place: 'on',
    },
    frame: { w: 100, h: 20, fontPx: 16, viewportW: 800 },
    strokes,
    ...extra,
  };
}

function pathRect(l: InkLayer, strokeId: string): DOMRect {
  const p = l.root.querySelector(`[data-stroke="${strokeId}"]`);
  if (!p) throw new Error(`no path ${strokeId}`);
  return p.getBoundingClientRect();
}

describe('host element', () => {
  test('is a closed element on <html> with no box that takes no pointer events', () => {
    const l = mkLayer();
    expect(l.host.tagName.toLowerCase()).toBe('ink-layer');
    expect(l.host.parentElement).toBe(document.documentElement);
    expect(l.host.shadowRoot).toBeNull();
    const cs = getComputedStyle(l.host);
    // No box: the host can never get a layer of its own or form a stacking context.
    expect(cs.display).toBe('contents');
    expect(l.host.getClientRects().length).toBe(0);
    expect(cs.pointerEvents).toBe('none');
    const svg = l.root.querySelector('svg')!;
    expect(getComputedStyle(svg).zIndex).toBe('2147483647');
  });

  test('hostile page CSS cannot hide, move or restyle the layer', () => {
    addStyle(`
      *, *::before, *::after, ink-layer, html > :last-child { all: unset !important; display: none !important; }
      html, head, body, style { display: block !important; }
      head, style { display: none !important; }
      ink-layer { position: fixed !important; transform: scale(0) !important; width: 500px !important;
        height: 500px !important; pointer-events: auto !important; opacity: 0 !important; z-index: 1 !important;
        filter: blur(10px) !important; contain: strict !important; margin: 100px !important; }
      svg, path, g { display: none !important; fill: red !important; }
      ink-layer::before { content: "x" !important; display: block !important; width: 900px !important; height: 900px !important; }
    `);
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 50, y: 60 }, scale: 1 });
    const cs = getComputedStyle(l.host);
    expect(cs.display).toBe('contents');
    expect(l.host.getClientRects().length).toBe(0);
    expect(cs.pointerEvents).toBe('none');
    expect(cs.visibility).toBe('visible');
    expect(getComputedStyle(l.host, '::before').content).toBe('none');
    const r = pathRect(l, 's1');
    expect(r.left).toBeCloseTo(50, 0);
    expect(r.top).toBeCloseTo(60, 0);
    expect(r.width).toBeCloseTo(40, 0);
    const p = l.root.querySelector('[data-stroke="s1"]')!;
    expect(getComputedStyle(p).fill).not.toBe('rgb(255, 0, 0)');
  });

  test('ink never takes a click from the page', () => {
    const target = addEl('div', 'position:absolute;left:0;top:0;width:300px;height:300px;background:#eee');
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 10, y: 10 }, scale: 3 });
    expect(document.elementFromPoint(30, 20)).toBe(target);
  });

  test('cancels an offset on <html>', () => {
    addStyle('html { position: relative !important; margin-left: 30px !important; top: 20px !important; }');
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 100, y: 100 }, scale: 1 });
    const r = pathRect(l, 's1');
    expect(r.left).toBeCloseTo(100, 0);
    expect(r.top).toBeCloseTo(100, 0);
  });

  test('cancels CSS zoom on <html>, so ink lands at client coordinates', () => {
    addStyle('html { zoom: 1.5 !important; }');
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 100, y: 100 }, scale: 1 });
    const r = pathRect(l, 's1');
    expect(r.left).toBeCloseTo(100, 0);
    expect(r.top).toBeCloseTo(100, 0);
    expect(r.width).toBeCloseTo(40, 0);
  });

  test('hides ink under a scaling transform on <html> and shows it under a translation', () => {
    addStyle('html { transform: scale(0.8) rotate(2deg) !important; }');
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 100, y: 100 }, scale: 1 });
    const svg = l.root.querySelector('[data-stroke="s1"]')!.closest('svg')!;
    expect(getComputedStyle(svg).visibility).toBe('hidden');
    addStyle('html { transform: translate(5px, 7px) !important; }');
    l.measure();
    l.flush();
    expect(getComputedStyle(svg).visibility).toBe('visible');
    const r = pathRect(l, 's1');
    expect(r.left).toBeCloseTo(100, 0);
    expect(r.top).toBeCloseTo(100, 0);
  });

  test('destroy removes the host', () => {
    const l = createLayer(document);
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 0, y: 0 }, scale: 1 });
    l.destroy();
    expect(document.querySelector('ink-layer')).toBeNull();
  });
});

describe('notes', () => {
  test('pose is translate then scale, and stored paths are used as given', () => {
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 20, y: 30 }, scale: 2 });
    const p = l.root.querySelector('[data-stroke="s1"]')!;
    expect(p.getAttribute('d')).toBe('M0 0L40 0L40 10L0 10Z');
    const r = pathRect(l, 's1');
    expect([r.left, r.top, r.width, r.height].map(Math.round)).toEqual([20, 30, 80, 20]);
  });

  test('pen paints above highlighter across notes', () => {
    const l = mkLayer();
    l.drawNote(note('a', [boxStroke('pa', 'pen')]), { origin: { x: 0, y: 0 }, scale: 1 });
    l.drawNote(note('b', [boxStroke('hb', 'hi')]), { origin: { x: 0, y: 0 }, scale: 1 });
    const pa = l.root.querySelector('[data-stroke="pa"]')!;
    const hb = l.root.querySelector('[data-stroke="hb"]')!;
    // Later in tree order paints on top.
    expect(hb.compareDocumentPosition(pa) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(getComputedStyle(hb.closest('svg')!).mixBlendMode).toBe('multiply');
  });

  test('redraw adds new strokes, drops removed ones and keeps the rest', () => {
    const l = mkLayer();
    const n = note('n1', [boxStroke('s1'), boxStroke('s2')]);
    l.drawNote(n, { origin: { x: 0, y: 0 }, scale: 1 });
    const s1 = l.root.querySelector('[data-stroke="s1"]');
    l.drawNote({ ...n, strokes: [boxStroke('s1'), boxStroke('s3')] }, { origin: { x: 5, y: 5 }, scale: 1 });
    expect(l.root.querySelector('[data-stroke="s1"]')).toBe(s1);
    expect(l.root.querySelector('[data-stroke="s2"]')).toBeNull();
    expect(l.root.querySelector('[data-stroke="s3"]')).not.toBeNull();
    l.removeNote('n1');
    expect(l.root.querySelector('[data-stroke]')).toBeNull();
    l.drawNote(n, { origin: { x: 0, y: 0 }, scale: 1 });
    l.clear();
    expect(l.root.querySelector('[data-stroke]')).toBeNull();
  });

  test('colours from storage cannot carry CSS or urls', () => {
    const l = mkLayer();
    const bad = { ...boxStroke('s1'), color: 'url(https://example.com/x.svg#a)' };
    l.drawNote(note('n1', [bad]), { origin: { x: 0, y: 0 }, scale: 1 });
    const p = l.root.querySelector<SVGPathElement>('[data-stroke="s1"]')!;
    expect(p.style.fill).toBe('var(--c-ink-1)');
    expect(l.toSVG({ x: 0, y: 0, w: 100, h: 100 })).not.toContain('example.com');
  });

  test('setHidden hides single strokes and shows them again', () => {
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1'), boxStroke('s2')]), { origin: { x: 0, y: 0 }, scale: 1 });
    l.setHidden(['s1']);
    expect(pathRect(l, 's1').width).toBe(0);
    expect(pathRect(l, 's2').width).toBeGreaterThan(0);
    l.setHidden([]);
    expect(pathRect(l, 's1').width).toBeGreaterThan(0);
  });

  test('setSelected outlines the note', () => {
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 100, y: 100 }, scale: 1 });
    l.setSelected(['n1']);
    const sel = l.root.querySelector('.sel')!;
    const r = sel.getBoundingClientRect();
    expect(r.left).toBeLessThan(101);
    expect(r.right).toBeGreaterThan(139);
    l.setSelected([]);
    expect(l.root.querySelector('.sel')).toBeNull();
  });

  test('a leader line runs from the ink to the anchor point', () => {
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), {
      origin: { x: 300, y: 100 },
      scale: 1,
      leaderTo: { x: 200, y: 105 },
    });
    const lead = l.root.querySelector('.lead')!;
    const r = lead.getBoundingClientRect();
    // Firefox counts the stroke width in the box of an SVG path, Chromium and WebKit do not.
    expect(Math.abs(r.left - 200)).toBeLessThan(2.5);
    expect(Math.abs(r.right - 300)).toBeLessThan(2.5);
  });

  test('a leader can pass points on its way, so it goes round text', () => {
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), {
      origin: { x: 100, y: 300 },
      scale: 1,
      leaderVia: [
        { x: 380, y: 305 },
        { x: 380, y: 105 },
      ],
      leaderTo: { x: 360, y: 105 },
    });
    const d = l.root.querySelector('.lead')!.getAttribute('d')!;
    expect(d).toBe('M140.5 305L380 305L380 105L360 105');
  });

  test('a folded note shows a marker instead of its ink, and unfolds when told', () => {
    const l = mkLayer();
    const n = note('n1', [boxStroke('s1')]);
    l.drawNote(n, { origin: { x: 100, y: 100 }, scale: 1, marker: { x: 300, y: 120, w: 22, h: 22 } });
    const b = l.root.querySelector<HTMLButtonElement>('button.dk[data-note="n1"]')!;
    const r = b.getBoundingClientRect();
    expect([r.left, r.top, r.width, r.height]).toEqual([300, 120, 22, 22]);
    expect(pathRect(l, 's1').width).toBe(0);
    expect(l.toSVG({ x: 0, y: 0, w: 800, h: 800 })).not.toContain('M0 0L40 0');
    // A press shows the ink at its own size in a popover; a second press hides it.
    b.click();
    const pop = l.root.querySelector<HTMLElement>('.pop')!;
    expect(pop.hidden).toBe(false);
    expect(pop.querySelector('svg')!.getBoundingClientRect().width).toBeCloseTo(41, 0);
    expect(pop.querySelector('[data-stroke]')).toBeNull();
    b.click();
    expect(pop.hidden).toBe(true);
    l.drawNote(n, { origin: { x: 100, y: 100 }, scale: 1 });
    expect(l.root.querySelector('button.dk')).toBeNull();
    expect(pathRect(l, 's1').width).toBeGreaterThan(30);
  });
});

describe('text marks', () => {
  const rects = [
    { x: 10, y: 100, w: 200, h: 20 },
    { x: 10, y: 124, w: 120, h: 20 },
  ];
  const mark = (id: string, style: 'highlight' | 'underline' | 'strike'): Note =>
    note(id, [], { kind: 'textmark', mark: { style, color: style === 'highlight' ? 'hi-1' : 'ink-2' } });

  test('highlight fills the rects in the blended surface', () => {
    const l = mkLayer();
    l.drawMark(mark('m1', 'highlight'), rects);
    const p = l.root.querySelector('[data-mark="highlight"]')!;
    expect(p.closest('svg')!.classList.contains('hi')).toBe(true);
    const r = p.getBoundingClientRect();
    expect(r.top).toBeLessThan(102);
    expect(r.bottom).toBeGreaterThan(142);
    expect(r.left).toBeLessThan(11);
    expect(r.right).toBeGreaterThan(209);
  });

  test('setHidden hides a whole mark by its note id', () => {
    const l = mkLayer();
    l.drawMark(mark('m1', 'highlight'), rects);
    const p = l.root.querySelector('[data-mark="highlight"]') as SVGPathElement;
    l.setHidden(['m1']);
    expect(p.style.display).toBe('none');
    l.setHidden([]);
    expect(p.style.display).toBe('');
  });

  test('underline and strike are thin bands at the right height', () => {
    const l = mkLayer();
    l.drawMark(mark('u', 'underline'), [rects[0]!]);
    l.drawMark(mark('s', 'strike'), [rects[0]!]);
    const u = l.root.querySelector('[data-mark="underline"]')!.getBoundingClientRect();
    const s = l.root.querySelector('[data-mark="strike"]')!.getBoundingClientRect();
    expect(u.height).toBeLessThan(5);
    expect(s.height).toBeLessThan(5);
    expect(u.top).toBeGreaterThan(115);
    expect(s.top).toBeGreaterThan(105);
    expect(s.bottom).toBeLessThan(116);
  });

  test('the wobble is stable for a note id and differs between notes', () => {
    expect(markPath('highlight', rects, seedOf('a'))).toBe(markPath('highlight', rects, seedOf('a')));
    expect(markPath('highlight', rects, seedOf('a'))).not.toBe(markPath('highlight', rects, seedOf('b')));
    const l = mkLayer();
    l.drawMark(mark('m1', 'underline'), rects);
    const d1 = l.root.querySelector('[data-mark]')!.getAttribute('d');
    l.removeNote('m1');
    l.drawMark(mark('m1', 'underline'), rects);
    expect(l.root.querySelector('[data-mark]')!.getAttribute('d')).toBe(d1);
  });
});

describe('theme', () => {
  test('auto picks light on a light page and dark on a dark page', () => {
    addStyle('body { background: #ffffff !important; }');
    expect(detectTheme(document)).toBe('light');
    const l = mkLayer();
    expect(l.theme()).toBe('light');
    addStyle('body { background: #121212 !important; }');
    expect(detectTheme(document)).toBe('dark');
    l.setTheme('auto');
    expect(l.theme()).toBe('dark');
    expect(l.host.style.getPropertyValue('--c-ink-1')).toBe(PALETTES.dark['ink-1']);
    expect(l.cssColor('ink-1', 'pen')).toBe(PALETTES.dark['ink-1']);
  });

  test('before the page has painted, the page colours are read in the first placement, not when the layer is made', () => {
    addStyle('body { background: #121212 !important; }');
    const read = window.getComputedStyle;
    let reads = 0;
    window.getComputedStyle = ((el: Element, p?: string | null) => {
      reads++;
      return read.call(window, el, p);
    }) as typeof window.getComputedStyle;
    const entries = performance.getEntriesByType;
    // A page that has not painted yet. Only browsers that report paints can tell.
    const reports = PerformanceObserver.supportedEntryTypes?.includes('paint') ?? false;
    performance.getEntriesByType = ((type: string) =>
      type === 'paint' ? [] : entries.call(performance, type)) as typeof performance.getEntriesByType;
    try {
      const l = mkLayer();
      if (reports) {
        // Reading them now would force a style pass ahead of the page's own first one.
        expect(reads).toBe(0);
        expect(l.theme()).toBe('light');
        l.readTheme();
        l.flush();
      }
      expect(l.theme()).toBe('dark');
      expect(reads).toBeGreaterThan(0);
    } finally {
      window.getComputedStyle = read;
      performance.getEntriesByType = entries;
    }
    // Once the page has painted, a new layer reads them at once.
    if (!reports || performance.getEntriesByType('paint').length) expect(mkLayer().theme()).toBe('dark');
  });

  test('auto reads html when body is clear, and color-scheme when both are clear', () => {
    addStyle('html { background: rgb(20, 20, 30) !important; } body { background: transparent !important; }');
    expect(detectTheme(document)).toBe('dark');
    cleanups.pop()!();
    addStyle('html, body { background: transparent !important; } html { color-scheme: dark !important; }');
    expect(detectTheme(document)).toBe('dark');
    cleanups.pop()!();
    addStyle('html, body { background: oklch(0.2 0.02 250) !important; }');
    expect(detectTheme(document)).toBe('dark');
  });

  test('explicit themes and colours map through the palettes', () => {
    const l = mkLayer({ theme: 'dark' });
    expect(l.theme()).toBe('dark');
    l.setTheme('light');
    expect(l.cssColor('hi-1', 'hi')).toBe(PALETTES.light['hi-1']);
    expect(l.cssColor('#123456', 'pen')).toBe('#123456');
    expect(realColor('light', 'nonsense', 'hi')).toBe(PALETTES.light['hi-1']);
    expect(getComputedStyle(l.root.querySelector('svg.hi')!).mixBlendMode).toBe('multiply');
    l.setTheme('dark');
    expect(getComputedStyle(l.root.querySelector('svg.hi')!).mixBlendMode).toBe('screen');
  });
});

/** Decode a PNG and return the RGBA at a point. */
async function pixelAt(png: Blob, x: number, y: number): Promise<number[]> {
  const bmp = await createImageBitmap(png);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  return [...ctx.getImageData(x, y, 1, 1).data];
}

describe('blending', () => {
  test('highlighter over text keeps the text dark on a light page', async () => {
    addStyle('html, body { background: #fff !important; margin: 0 !important; }');
    const block = addEl('div', 'position:absolute;left:20px;top:20px;width:60px;height:30px;background:#000');
    const l = mkLayer();
    l.drawMark(note('m', [], { kind: 'textmark', mark: { style: 'highlight', color: 'hi-1' } }), [
      { x: 0, y: 10, w: 120, h: 50 },
    ]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const b64 = await page.screenshot({ save: false });
    const blob = pngBlob(b64);
    const dpr = window.devicePixelRatio;
    const onText = await pixelAt(blob, 40 * dpr, 35 * dpr);
    const onPaper = await pixelAt(blob, 100 * dpr, 35 * dpr);
    // Multiply keeps black text black, and turns white paper yellow.
    expect(onText.slice(0, 3).every((v) => v < 40)).toBe(true);
    expect(onPaper[0]!).toBeGreaterThan(200);
    expect(onPaper[2]!).toBeLessThan(150);
    void block;
  });

  // WebKit gives a part of the page a layer of its own when it moves, is pinned, or lies over
  // such a part. A surface that needs a layer only for the last reason is painted into the
  // layer of an ancestor that has one. The host must never be that ancestor: it holds nothing
  // but ink, so the highlighter would have no page under it to blend with and would paint
  // solid. A screenshot does not show this, so the test reads what is on screen.
  const UNDER: [string, string][] = [
    ['a bar pinned to the top', 'position:fixed;left:0;top:0;width:100%;height:4px;background:#dde'],
    [
      'a moving part in the corner',
      'position:absolute;left:0;top:0;width:2px;height:2px;will-change:transform',
    ],
    [
      'a moving part under the words',
      'position:absolute;left:30px;top:22px;width:4px;height:4px;will-change:transform',
    ],
  ];
  for (const order of ['before', 'after'] as const) {
    test.each(UNDER)(
      `the words show through the highlighter on a page with %s, made ${order} the layer`,
      async (_, css) => {
        addStyle('html, body { background: #fff !important; margin: 0 !important; }');
        addEl('div', 'position:absolute;left:20px;top:20px;width:60px;height:30px;background:#000');
        const l = order === 'after' ? mkLayer() : null;
        addEl('div', css, document.documentElement);
        const layer = l ?? mkLayer();
        layer.drawMark(note('m', [], { kind: 'textmark', mark: { style: 'highlight', color: 'hi-1' } }), [
          { x: 0, y: 10, w: 120, h: 50 },
        ]);
        await frame();
        await frame();
        const at = await shown();
        const onText = at(50, 38);
        const onPaper = at(100, 38);
        expect(
          onText.every((v) => v < 60),
          `words under the highlighter: rgb(${onText})`,
        ).toBe(true);
        expect(onPaper[0]).toBeGreaterThan(200);
        expect(onPaper[2]).toBeLessThan(150);
      },
    );
  }

  // A host in the top layer is a stacking context, so a surface inside it blends only with
  // what that host holds. The highlighter of the top layer has a host of its own, which
  // blends as a whole with the dialog under it. Pen ink sits in a second host and never blends.
  test.each([
    ['a modal dialog', ''],
    [
      'a modal dialog with a moving part in its corner',
      'position:absolute;left:0;top:0;width:2px;height:2px;will-change:transform',
    ],
  ])('the words show through the highlighter on %s, and pen ink keeps its colour', async (_, part) => {
    addStyle('html, body { background: #fff !important; margin: 0 !important; }');
    const d = addEl(
      'dialog',
      'position:fixed;left:0;top:0;margin:0;width:300px;height:200px;max-width:none;max-height:none;border:0;padding:0;background:#fff',
    );
    addEl('div', 'position:absolute;left:20px;top:20px;width:60px;height:30px;background:#000', d);
    if (part) addEl('div', part, d);
    d.showModal();
    cleanups.push(() => d.close());
    const l = mkLayer();
    l.drawMark(
      note('m', [], { kind: 'textmark', mark: { style: 'highlight', color: 'hi-1' } }),
      [{ x: 0, y: 10, w: 120, h: 50 }],
      { top: true },
    );
    l.drawNote(note('n', [boxStroke('s1', 'pen', '#ff0000')]), {
      origin: { x: 30, y: 40 },
      scale: 1,
      top: true,
    });
    if (!l.syncTop()) return;
    await frame();
    await frame();
    const at = await shown();
    const onText = at(50, 30);
    const onPaper = at(100, 30);
    const onPen = at(50, 45);
    expect(
      onText.every((v) => v < 60),
      `words under the highlighter: rgb(${onText})`,
    ).toBe(true);
    expect(onPaper[0]).toBeGreaterThan(200);
    expect(onPaper[2]).toBeLessThan(150);
    expect(onPen[0], `pen ink: rgb(${onPen})`).toBeGreaterThan(200);
    expect(onPen[1]).toBeLessThan(60);
  });

  test('the highlighter on a modal dialog is cut to its clip box, in its own host', async () => {
    addStyle('html, body { background: #fff !important; margin: 0 !important; }');
    const d = addEl(
      'dialog',
      'position:fixed;left:0;top:0;margin:0;width:300px;height:200px;max-width:none;max-height:none;border:0;padding:0;background:#fff',
    );
    d.showModal();
    cleanups.push(() => d.close());
    const l = mkLayer();
    const yellow = (c: number[]): boolean => c[0]! > 200 && c[1]! > 170 && c[2]! < 150;
    const m = note('m', [], { kind: 'textmark', mark: { style: 'highlight', color: 'hi-1' } });
    const h = note('h', [boxStroke('h1', 'hi')]);
    // A text mark, cut in container units, and a highlighter stroke, cut in the note's own units.
    l.drawMark(m, [{ x: 0, y: 10, w: 200, h: 40 }], { top: true, clip: { x: 0, y: 0, w: 100, h: 200 } });
    l.drawNote(h, { origin: { x: 20, y: 100 }, scale: 4, top: true, clip: { x: 0, y: 0, w: 100, h: 200 } });
    if (!l.syncTop()) return;
    await frame();
    await frame();
    let at = await shown();
    expect(yellow(at(50, 30))).toBe(true);
    expect(yellow(at(150, 30))).toBe(false);
    expect(yellow(at(60, 120))).toBe(true);
    expect(yellow(at(150, 120))).toBe(false);
    // The cut goes when the clip does.
    l.clipNote('m', null);
    l.clipNote('h', null);
    await frame();
    await frame();
    at = await shown();
    expect(yellow(at(150, 30))).toBe(true);
    expect(yellow(at(150, 120))).toBe(true);
  });
});

/** Base64 PNG to a Blob. */
function pngBlob(b64: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

describe('inner scrollers and pinned notes', () => {
  test('scroller notes are clipped to its box and move by one transform', () => {
    const sc = addEl('div', 'position:absolute;left:50px;top:50px;width:200px;height:100px;overflow:auto');
    addEl('div', 'height:1000px', sc);
    const l = mkLayer();
    const n = note('n1', [boxStroke('s1')]);
    l.setScroller(sc, { x: 50, y: 50, w: 200, h: 100 }, { x: 0, y: 0 });
    l.drawNote(n, { origin: { x: 60, y: 120 }, scale: 1, scroller: sc });
    expect(pathRect(l, 's1').top).toBeCloseTo(120, 0);
    const clip = l.root.querySelector('[data-stroke="s1"]')!.closest('g')!.parentElement!.closest('svg')!;
    expect(clip.getAttribute('overflow')).toBe('hidden');
    expect(['x', 'y', 'width', 'height'].map((a) => clip.getAttribute(a))).toEqual([
      '50',
      '50',
      '200',
      '100',
    ]);
    l.scrollScroller(sc, { x: 0, y: 40 });
    expect(pathRect(l, 's1').top).toBeCloseTo(80, 0);
  });

  test('without a placer the layer reads the scroller itself', () => {
    const sc = addEl('div', 'position:absolute;left:50px;top:50px;width:200px;height:100px;overflow:auto');
    addEl('div', 'height:1000px', sc);
    sc.scrollTop = 30;
    const l = mkLayer();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 60, y: 90 }, scale: 1, scroller: sc });
    expect(pathRect(l, 's1').top).toBeCloseTo(90, 0);
  });

  test('pinned notes stay in the viewport while the page scrolls', () => {
    addEl('div', 'height:4000px');
    const l = mkLayer();
    window.scrollTo(0, 500);
    l.measure();
    l.drawNote(note('n1', [boxStroke('s1')]), { origin: { x: 10, y: 520 }, scale: 1, pinned: true });
    expect(pathRect(l, 's1').top).toBeCloseTo(20, 0);
    window.scrollTo(0, 900);
    expect(pathRect(l, 's1').top).toBeCloseTo(20, 0);
  });
});

describe('badge', () => {
  test('shows the count, opens on click and hides at zero', () => {
    const l = mkLayer();
    let opened = 0;
    l.setBadge(3, () => opened++);
    const b = l.ui.querySelector('button')!;
    expect(b.hidden).toBe(false);
    expect(b.textContent).toBe('3');
    expect(getComputedStyle(b).pointerEvents).toBe('auto');
    b.click();
    expect(opened).toBe(1);
    l.setBadge(0);
    expect(b.hidden).toBe(true);
  });
});

describe('export', () => {
  test('toSVG has the ink in an area with real colours and leaves the rest out', () => {
    const l = mkLayer({ theme: 'light' });
    l.drawNote(note('in', [boxStroke('s1'), boxStroke('h1', 'hi')]), { origin: { x: 10, y: 10 }, scale: 1 });
    l.drawNote(note('out', [boxStroke('s2')]), { origin: { x: 900, y: 900 }, scale: 1 });
    l.drawMark(note('m', [], { kind: 'textmark', mark: { style: 'underline', color: 'ink-2' } }), [
      { x: 10, y: 40, w: 50, h: 16 },
    ]);
    const svg = l.toSVG({ x: 0, y: 0, w: 100, h: 100 });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('viewBox="0 0 100 100"');
    expect(svg).toContain(PALETTES.light['ink-1']);
    expect(svg).toContain(PALETTES.light['hi-1']);
    expect(svg).toContain(PALETTES.light['ink-2']);
    expect(svg).not.toContain('var(');
    expect(svg.match(/<path/g)!.length).toBe(3);
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
    expect(parsed.querySelector('parsererror')).toBeNull();
  });

  test('svgToPng rasterises the SVG at the given scale', async () => {
    const l = mkLayer({ theme: 'light' });
    l.drawNote(note('n', [boxStroke('s1', 'pen', '#ff0000')]), { origin: { x: 10, y: 10 }, scale: 1 });
    const svg = l.toSVG({ x: 0, y: 0, w: 60, h: 30 });
    const png = await svgToPng(svg, 60, 30, 2);
    expect(png.type).toBe('image/png');
    const bmp = await createImageBitmap(png);
    expect([bmp.width, bmp.height]).toEqual([120, 60]);
    expect(await pixelAt(png, 50, 30)).toEqual([255, 0, 0, 255]);
    expect((await pixelAt(png, 115, 55))[3]).toBe(0);
  });
});

describe('print', () => {
  test('print rules keep the ink colours and hide the controls', () => {
    const l = mkLayer();
    const sheet = l.root.adoptedStyleSheets[0]!;
    const media = [...sheet.cssRules].filter((r): r is CSSMediaRule => r instanceof CSSMediaRule);
    const print = media.find((m) => m.media.mediaText === 'print');
    expect(print).toBeDefined();
    expect(print!.cssText).toMatch(/print-color-adjust: exact/);
    expect(print!.cssText).toMatch(/\.ui/);
    expect(l.host.style.getPropertyValue('print-color-adjust')).toBe('exact');
    expect(l.host.style.getPropertyPriority('print-color-adjust')).toBe('important');
  });
});

describe('strict style-src', () => {
  test('the layer uses adopted sheets and the CSSOM, never a style element', () => {
    const l = mkLayer();
    l.drawNote(note('n', [boxStroke('s1', 'pen', 'ink-1')]), { origin: { x: 10, y: 10 }, scale: 1 });
    expect(l.root.querySelectorAll('style').length).toBe(0);
    expect(l.root.adoptedStyleSheets.length).toBe(2);
    // The host style was written through the CSSOM. A blocked attribute would leave it empty.
    expect(l.host.style.getPropertyValue('display')).toBe('contents');
    expect(l.host.style.getPropertyPriority('pointer-events')).toBe('important');
  });

  test('the zoom rule goes into the second sheet', () => {
    document.documentElement.style.zoom = '2';
    try {
      const l = mkLayer();
      l.drawNote(note('n', [boxStroke('s1', 'pen', 'ink-1')]), { origin: { x: 10, y: 10 }, scale: 1 });
      const view = l.root.adoptedStyleSheets[1]!;
      expect([...view.cssRules].map((r) => r.cssText).join('')).toMatch(/zoom: 0\.5/);
    } finally {
      document.documentElement.style.zoom = '';
    }
  });

  test('falls back to style elements where sheets cannot be adopted', () => {
    const desc = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, 'adoptedStyleSheets')!;
    Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
      configurable: true,
      get: () => [],
      set: () => {},
    });
    try {
      const l = mkLayer();
      expect(l.root.querySelectorAll('style').length).toBe(2);
      expect(l.root.querySelector('style')!.textContent).toContain('.s{position:absolute');
    } finally {
      Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', desc);
    }
  });
});

describe('page edge markers', () => {
  test('sit at the right edge at their relative height, never past the page end, and report clicks', () => {
    addEl('div', 'height:3000px');
    const l = mkLayer();
    const opened: [string, boolean][] = [];
    l.setMarkers(
      [
        { id: 'a', relY: 0.5, label: 'Moved note: “alpha”' },
        { id: 'b', relY: 1, label: 'Moved note: “beta”' },
      ],
      (id, byKey) => opened.push([id, byKey]),
    );
    const h = document.documentElement.scrollHeight;
    const mks = [...l.root.querySelectorAll<HTMLButtonElement>('.mks .mk')];
    expect(mks.map((m) => m.title)).toEqual(['Moved note: “alpha”', 'Moved note: “beta”']);
    expect(mks[0]!.getAttribute('aria-label')).toBe('Moved note: “alpha”');
    const a = mks[0]!.getBoundingClientRect();
    expect(Math.abs(a.top + a.height / 2 + scrollY - h / 2)).toBeLessThan(1);
    expect(Math.abs(a.right - (document.documentElement.clientWidth - 2))).toBeLessThan(1);
    // The last one stays inside the page, so it cannot make the page taller.
    const b = mks[1]!.getBoundingClientRect();
    expect(b.bottom + scrollY).toBeLessThanOrEqual(h);
    expect(document.documentElement.scrollHeight).toBe(h);
    mks[1]!.click();
    expect(opened).toEqual([['b', true]]);
  });

  test('an empty list hides them, and they do not print', () => {
    const l = mkLayer();
    l.setMarkers([{ id: 'a', relY: 0.2, label: 'x' }]);
    const box = l.root.querySelector<HTMLElement>('.mks')!;
    expect(box.hidden).toBe(false);
    l.setMarkers([]);
    expect(box.hidden).toBe(true);
    expect(box.children.length).toBe(0);
    const print = [...l.root.adoptedStyleSheets[0]!.cssRules].find(
      (r) => r instanceof CSSMediaRule && r.media.mediaText === 'print',
    );
    expect(print?.cssText).toMatch(/\.mks/);
  });
});

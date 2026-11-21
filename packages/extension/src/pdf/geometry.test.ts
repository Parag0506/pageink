import { describe, expect, test } from 'vitest';
import {
  AUTO_MAX,
  autoZoom,
  CSS_PER_PT,
  canvasScale,
  clampZoom,
  fitWidth,
  GAP,
  layout,
  MAX_ZOOM,
  MIN_ZOOM,
  nearPages,
  PAD,
  pageAt,
  pageCss,
  pageId,
  pageOfAnchor,
  pointAt,
  stepZoom,
  yOf,
} from './geometry';

const LETTER = { w: 612, h: 792 };
const sizes = [LETTER, LETTER, { w: 792, h: 612 }, LETTER];

describe('layout', () => {
  test('pages stack with a gap, sized to the zoom in whole pixels', () => {
    const l = layout(sizes, 1);
    expect(l.widths[0]).toBe(816);
    expect(l.heights[0]).toBe(1056);
    expect(l.widths[2]).toBe(1056);
    expect(l.tops[0]).toBe(PAD);
    expect(l.tops[1]).toBe(PAD + 1056 + GAP);
    expect(l.tops[3]).toBe(l.tops[2]! + l.heights[2]! + GAP);
    expect(l.total).toBe(l.tops[3]! + l.heights[3]! + PAD);
    expect(layout([], 1).total).toBe(2 * PAD);
  });

  test('a page keeps its shape at every zoom, so a point on it is the same fraction of its width', () => {
    for (const z of [0.5, 0.8, 1.33, 2.5]) {
      const c = pageCss(LETTER, z);
      expect(c.w).toBe(Math.floor(612 * z * CSS_PER_PT));
      expect(Math.abs(c.h / c.w - 792 / 612)).toBeLessThan(0.01);
    }
  });
});

describe('zoom', () => {
  test('fit width fills the view; auto never goes above its cap', () => {
    const z = fitWidth(sizes, 1000);
    expect(Math.floor(792 * z * CSS_PER_PT)).toBeLessThanOrEqual(1000 - 2 * PAD);
    expect(Math.floor(792 * z * CSS_PER_PT)).toBeGreaterThan(1000 - 2 * PAD - 2);
    expect(autoZoom([LETTER], 3000)).toBe(AUTO_MAX);
    expect(autoZoom([LETTER], 500)).toBe(fitWidth([LETTER], 500));
  });

  test('clamps and steps', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.19, 1)).toBe(1.25);
    expect(stepZoom(1.19, -1)).toBe(1.1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe('positions', () => {
  const l = layout(sizes, 1);

  test('pageAt finds the page under a point, or the nearest one', () => {
    expect(pageAt(l, 0)).toBe(0);
    expect(pageAt(l, l.tops[1]! + 5)).toBe(1);
    expect(pageAt(l, l.tops[1]! - 2)).toBe(0);
    expect(pageAt(l, 1e9)).toBe(3);
    expect(pageAt(layout([], 1), 10)).toBe(-1);
  });

  test('nearPages covers the view and its margin', () => {
    expect(nearPages(l, l.tops[1]! + 10, l.tops[1]! + 500, 0)).toEqual([1, 1]);
    expect(nearPages(l, l.tops[1]! + 10, l.tops[1]! + 500, 1200)).toEqual([0, 2]);
    expect(nearPages(layout([], 1), 0, 100, 0)).toEqual([0, -1]);
  });

  test('a point keeps its place on its page across a zoom', () => {
    const y = l.tops[2]! + 300;
    const p = pointAt(l, y);
    expect(p.page).toBe(2);
    const l2 = layout(sizes, 2);
    expect(yOf(l2, p.page, p.frac)).toBeCloseTo(l2.tops[2]! + 300 * (l2.heights[2]! / l.heights[2]!), 5);
    expect(yOf(l, p.page, p.frac)).toBeCloseTo(y, 5);
    expect(yOf(l, 99, 0)).toBe(l.tops[3]);
  });
});

test('canvasScale caps the pixels of one page', () => {
  expect(canvasScale(800, 1000, 2)).toBe(2);
  const k = canvasScale(4000, 5000, 2, 16_000_000);
  expect(4000 * 5000 * k * k).toBeLessThanOrEqual(16_000_001);
});

describe('pageOfAnchor', () => {
  const path = (css: string, xpath = '', id?: string) => ({ css, xpath, ...(id ? { id } : {}) });
  test('reads the page from the media name, the id or the path', () => {
    expect(pageId(12)).toBe('ink-pdf-page-12');
    expect(pageOfAnchor({ path: path(''), media: { src: 'ink-pdf-page-7' } })).toBe(7);
    expect(pageOfAnchor({ path: path('#ink-pdf-page-3 > div:nth-of-type(1) > span:nth-of-type(4)') })).toBe(
      3,
    );
    expect(pageOfAnchor({ path: path('', '', 'ink-pdf-page-9') })).toBe(9);
    // Ids with three digits are not trusted by the path builder; the position still names the page.
    expect(
      pageOfAnchor({
        path: path(
          'body > main:nth-of-type(1) > div:nth-of-type(120) > div > span',
          '/html[1]/body[1]/main[1]/div[120]/div[1]/span[4]',
        ),
      }),
    ).toBe(120);
    expect(pageOfAnchor({ path: path('body > p', '/html[1]/body[1]/p[1]') })).toBeNull();
  });
});

import { afterAll, afterEach, beforeAll, beforeEach, expect, describe as group, test } from 'vitest';
import { page } from 'vitest/browser';
import type { AnchorContext, Described, Rect } from '../types';
import { describe, describeRange } from './describe';
import {
  articleHtml,
  boxOfRange,
  docRect,
  type Fixture,
  mount,
  paragraph,
  reveal,
  rng,
  STYLE,
  wordRange,
} from './fixtures';
import { createResolver } from './resolve';
import { dropModel, fold } from './text';

let saved: [number, number] = [0, 0];
beforeAll(() => {
  saved = [innerWidth, innerHeight];
});
afterAll(async () => {
  await page.viewport(saved[0], saved[1]);
});
beforeEach(async () => {
  await page.viewport(1280, 800);
});
afterEach(() => {
  dropModel(document);
  scrollTo(0, 0);
  document.body.removeAttribute('style');
});

const p = (id: string) => document.getElementById(id)!;

/** Describe a note drawn over words from..to of an element. */
function noteOnWords(ctx: AnchorContext, el: Element | ShadowRoot, from: number, to: number): Described {
  const r = wordRange(el, from, to);
  const b = boxOfRange(r);
  reveal(b);
  const first = r.getClientRects()[0]!;
  // A small box on the first line of the words, like a circle around them.
  const box: Rect = { x: first.left + scrollX, y: first.top + scrollY, w: first.width, h: first.height };
  return describe(ctx, box);
}

function noteAt(ctx: AnchorContext, box: Rect): Described {
  reveal(box);
  return describe(ctx, box);
}

function originOf(range: Range) {
  const f = [...range.getClientRects()].find((x) => x.width > 0)!;
  return { x: f.left + scrollX, y: f.top + scrollY };
}

function expectNear(a: { x: number; y: number }, b: { x: number; y: number }, tol = 0.5) {
  expect(Math.abs(a.x - b.x), `x ${a.x} vs ${b.x}`).toBeLessThanOrEqual(tol);
  expect(Math.abs(a.y - b.y), `y ${a.y} vs ${b.y}`).toBeLessThanOrEqual(tol);
}

function stripIds(root: ParentNode = document) {
  for (const el of root.querySelectorAll('[id]')) el.removeAttribute('id');
}

function setup(): Fixture & { resolve: ReturnType<typeof createResolver> } {
  const f = mount(articleHtml(21));
  return { ...f, resolve: createResolver(f.ctx) };
}

group('layout changes', () => {
  test('reflow at 1280, 390 and 820 px keeps text, margin and gap notes in place', async () => {
    const { ctx, resolve } = setup();
    const text = noteOnWords(ctx, p('pb'), 10, 13);
    expect(text.anchor.type).toBe('text');
    const pb = docRect(p('pb'));
    const left = noteAt(ctx, { x: pb.x - 70, y: pb.y + 30, w: 50, h: 30 });
    const right = noteAt(ctx, { x: pb.x + pb.w + 20, y: pb.y + 2, w: 60, h: 30 });
    const pc = docRect(p('pc'));
    const gap = noteAt(ctx, { x: pc.x + 40, y: pc.y + pc.h + 2, w: 90, h: 12 });
    expect(left.anchor).toMatchObject({ type: 'block', place: 'left' });
    expect(right.anchor).toMatchObject({ type: 'block', place: 'right' });
    expect(gap.anchor.type).toBe('block');
    expect(['below', 'above']).toContain(gap.anchor.place);

    for (const w of [390, 820, 1280]) {
      await page.viewport(w, 800);
      resolve.invalidate();
      const t = resolve.resolve(text.anchor, text.frame)!;
      expect(fold(t.range!.toString())).toBe(text.anchor.quote.exact);
      expectNear(t.origin, originOf(wordRange(p('pb'), 10, 13)));
      const now = docRect(p('pb'));
      const l = resolve.resolve(left.anchor, left.frame)!;
      expect(l.el).toBe(p('pb'));
      expect(l.origin.x).toBeCloseTo(now.x, 1);
      const r = resolve.resolve(right.anchor, right.frame)!;
      expect(r.el).toBe(p('pb'));
      expect(r.origin.x).toBeCloseTo(now.x + now.w, 1);
      // The quote line is the first line, so the origin stays at the top of that line.
      expect(r.origin.y).toBeCloseTo(originOf(wordRange(p('pb'), 0, 0)).y, 1);
      const g = resolve.resolve(gap.anchor, gap.frame)!;
      expect(g.el === p('pc') || g.el === p('fig-1') || g.el.closest('figure')).toBeTruthy();
    }
  });

  test('font size change scales the note and keeps it on its words', () => {
    const { ctx, resolve } = setup();
    const d = noteOnWords(ctx, p('pc'), 4, 6);
    document.body.style.fontSize = '20px';
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.scale).toBeCloseTo(20 / 16, 3);
    expectNear(r.origin, originOf(wordRange(p('pc'), 4, 6)));
  });
});

group('content changes', () => {
  test('paragraph inserted above, with no ids to help', () => {
    const { ctx, resolve } = setup();
    stripIds();
    const target = document.querySelectorAll('article > p')[2]!;
    const d = noteOnWords(ctx, target, 5, 8);
    const extra = document.createElement('p');
    extra.textContent = paragraph(rng(5), 3);
    target.parentElement!.insertBefore(extra, document.querySelector('article > p'));
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.method).toBe('exact');
    expect(r.el).toBe(target);
    expectNear(r.origin, originOf(wordRange(target, 5, 8)));
  });

  test('words edited inside and around the quote', () => {
    const { ctx, resolve } = setup();
    const el = p('pd');
    const words = el.textContent!.split(' ');
    const d = describeRange(ctx, wordRange(el, 6, 14));
    expect(d.anchor.quote.exact.split(' ').length).toBe(9);
    // Change one word inside the quote and one in the prefix.
    words[9] = 'transformed';
    words[3] = 'altered';
    el.textContent = words.join(' ');
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r).not.toBeNull();
    expect(r.method).toBe('fuzzy');
    expect(r.el).toBe(el);
    expectNear(r.origin, originOf(wordRange(el, 6, 6)), 1);
  });

  test('a quote repeated several times lands on the right repeat', () => {
    const r0 = rng(3);
    const same = 'Silver lanterns gathered beneath the quiet harbor wall';
    const paras = Array.from(
      { length: 5 },
      (_, i) => `<p>${paragraph(r0, 1)} ${same} ${i === 4 ? '' : paragraph(r0, 1)}</p>`,
    );
    paras[4] = `<p>${same}</p>`;
    const f = mount(`${STYLE}<main><article>${paras.join('')}${paras[4]}</article></main>`);
    const resolve = createResolver(f.ctx);
    const ps = () => [...document.querySelectorAll('article p')];
    // Note on the third repeat.
    const third = ps()[2]!;
    const idx = third.textContent!.split(' ').indexOf('Silver');
    const d = describeRange(f.ctx, wordRange(third, idx, idx + 7));
    expect(d.anchor.quote.exact).toBe(same);
    const extra = document.createElement('p');
    extra.textContent = `${same} again at the top.`;
    document.querySelector('article')!.prepend(extra);
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.el).toBe(third);
    // Identical twins at the end: the text position decides.
    const twin = ps()[6]!;
    const dt = describeRange(f.ctx, wordRange(twin, 0, 7));
    document
      .querySelector('article')!
      .prepend(Object.assign(document.createElement('p'), { textContent: 'Lead.' }));
    resolve.invalidate();
    expect(resolve.resolve(dt.anchor, dt.frame)!.el).toBe(twin);
  });

  test('passage deleted returns null, not a wrong place', () => {
    const { ctx, resolve } = setup();
    const d = noteOnWords(ctx, p('pe'), 3, 9);
    const pe = docRect(p('pe'));
    const margin = noteAt(ctx, { x: pe.x + pe.w + 20, y: pe.y + 4, w: 50, h: 24 });
    stripIds();
    document.querySelectorAll('article > p')[4]!.remove();
    resolve.invalidate();
    expect(resolve.resolve(d.anchor, d.frame)).toBeNull();
    expect(resolve.resolve(margin.anchor, margin.frame)).toBeNull();
  });

  test('element ids and classes all changed', () => {
    const { ctx, resolve } = setup();
    const target = p('pf');
    const d = noteOnWords(ctx, target, 2, 4);
    const img = document.querySelector('figure img')!;
    const im = noteAt(ctx, { ...docRect(img), w: 40, h: 40 });
    expect(im.anchor.type).toBe('media');
    for (const el of document.querySelectorAll('[id], [class]')) {
      if (el.id) el.id = `x-${Math.random().toString(36).slice(2)}`;
      if (el.getAttribute('class')) el.setAttribute('class', 'css-1q2w3e');
    }
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.method).toBe('path');
    expect(r.el).toBe(target);
    expectNear(r.origin, originOf(wordRange(target, 2, 4)));
    expect(resolve.resolve(im.anchor, im.frame)!.el).toBe(img);
  });

  test('content moved to another container', () => {
    const { ctx, resolve } = setup();
    const target = p('pc');
    const d = noteOnWords(ctx, target, 7, 9);
    const aside = document.createElement('aside');
    document.body.append(aside);
    aside.append(target);
    target.removeAttribute('id');
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.el).toBe(target);
    expectNear(r.origin, originOf(wordRange(target, 7, 9)));
  });

  test('lazy content: null first, resolved after invalidate', () => {
    const { ctx, resolve } = setup();
    const target = p('pg');
    const d = noteOnWords(ctx, target, 1, 3);
    const parent = target.parentElement!;
    const next = target.nextSibling;
    target.remove();
    resolve.invalidate();
    expect(resolve.resolve(d.anchor, d.frame)).toBeNull();
    parent.insertBefore(target, next);
    // The cached text does not know about the new content yet.
    expect(resolve.resolve(d.anchor, d.frame)).toBeNull();
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.el).toBe(target);
  });

  test('describe notices text added after the model was built', () => {
    const { ctx } = setup();
    noteOnWords(ctx, p('pa'), 0, 1);
    const fresh = Object.assign(document.createElement('p'), {
      textContent: 'Brand new words arrive here today.',
    });
    p('pa').before(fresh);
    const d = noteOnWords(ctx, fresh, 1, 2);
    expect(d.anchor.type).toBe('text');
    expect(d.anchor.quote.exact).toBe('new words');
  });

  test('stale cached nodes are rebuilt on their own', () => {
    const { ctx, resolve } = setup();
    const target = p('pb');
    const d = noteOnWords(ctx, target, 1, 3);
    expect(resolve.resolve(d.anchor, d.frame)).not.toBeNull();
    // Replace the text node in place without telling the resolver.
    target.firstChild!.replaceWith(document.createTextNode(target.textContent!));
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r).not.toBeNull();
    expect(r.range!.startContainer.isConnected).toBe(true);
  });
});

group('page structures', () => {
  test('open and closed shadow roots', () => {
    const { ctx, closed, resolve } = setup();
    const open = document.querySelector('open-card')!.shadowRoot!;
    const shut = closed.get(document.querySelector('closed-card')!)!;
    const dOpen = noteOnWords(ctx, open.querySelectorAll('p')[1]!, 2, 4);
    const dClosed = noteOnWords(ctx, shut.querySelectorAll('p')[0]!, 3, 5);
    expect(dOpen.anchor.type).toBe('text');
    expect(dClosed.anchor.type).toBe('text');
    expect(dClosed.anchor.path.css).toContain('>>>');
    p('pa').before(Object.assign(document.createElement('p'), { textContent: 'A new opening line.' }));
    resolve.invalidate();
    const ro = resolve.resolve(dOpen.anchor, dOpen.frame)!;
    expectNear(ro.origin, originOf(wordRange(open.querySelectorAll('p')[1]!, 2, 4)));
    const rc = resolve.resolve(dClosed.anchor, dClosed.frame)!;
    expectNear(rc.origin, originOf(wordRange(shut.querySelectorAll('p')[0]!, 3, 5)));
    // Without the accessor, closed content cannot be found, so the note waits.
    const blind = createResolver({ doc: document });
    expect(blind.resolve(dClosed.anchor, dClosed.frame)).toBeNull();
    dropModel(document);
  });

  test('inner scroller is reported and followed', () => {
    const { ctx, resolve } = setup();
    const box = document.getElementById('box')!;
    const d = noteOnWords(ctx, box.querySelector('p')!, 2, 3);
    expect(d.anchor.scroller?.css).toContain('#box');
    const r1 = resolve.resolve(d.anchor, d.frame)!;
    expect(r1.scroller).toBe(box);
    box.scrollTop = 50;
    const r2 = resolve.resolve(d.anchor, d.frame)!;
    expect(r2.origin.y).toBeCloseTo(r1.origin.y - 50, 0);
  });

  test('sticky header content is pinned', () => {
    const { ctx, resolve } = setup();
    const span = document.querySelector('header span')!;
    const d = noteOnWords(ctx, span, 1, 2);
    expect(d.anchor.type).toBe('text');
    expect(resolve.resolve(d.anchor, d.frame)!.pinned).toBe(true);
    const body = noteOnWords(ctx, p('pa'), 1, 2);
    expect(resolve.resolve(body.anchor, body.frame)!.pinned).toBeUndefined();
  });

  test('image src changed but file name the same, then alt only, then gone', () => {
    const { ctx, resolve } = setup();
    const img = document.querySelector('figure img') as HTMLImageElement;
    const d = noteAt(ctx, { ...docRect(img), w: 60, h: 40 });
    expect(d.anchor.type).toBe('media');
    expect(d.anchor.media?.alt).toBe('A quiet harbor at dawn');
    // New host and query, same file, and the figure moves into a wrapper.
    img.src = 'ink-test://cdn.example/assets/photo-1.png?v=2';
    const wrap = document.createElement('div');
    const fig = img.closest('figure')!;
    fig.removeAttribute('id');
    fig.before(wrap);
    wrap.append(fig);
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.el).toBe(img);
    expect(r.method).toBe('media');
    img.src = 'ink-test://cdn.example/assets/other.png';
    resolve.invalidate();
    expect(resolve.resolve(d.anchor, d.frame)!.el).toBe(img);
    fig.remove();
    resolve.invalidate();
    expect(resolve.resolve(d.anchor, d.frame)).toBeNull();
  });

  test('table and figure are media; a wider table scales the note', () => {
    const { ctx, resolve } = setup();
    const table = document.getElementById('tbl')!;
    const d = noteAt(ctx, { ...docRect(table), w: 30, h: 20 });
    expect(d.anchor.type).toBe('media');
    expect(d.anchor.media?.caption).toBe('Harbor tides by month');
    const fig = document.querySelector('figcaption')!;
    const df = noteOnWords(ctx, fig, 0, 1);
    expect(df.anchor.type).toBe('media');
    table.style.width = `${d.frame.w * 2}px`;
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.scale).toBeCloseTo(2, 2);
    expect(resolve.resolve(df.anchor, df.frame)!.el.localName).toBe('figure');
  });

  test('data-ink-media surfaces are always media, even over text', () => {
    const { ctx, resolve } = setup();
    const span = document.querySelector('.pdfpage span')!;
    const d = noteOnWords(ctx, span, 0, 2);
    expect(d.anchor.type).toBe('media');
    expect(d.anchor.media?.src).toBe('page-1');
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.el).toBe(document.querySelector('.pdfpage'));
  });

  test('notes between paragraphs stay with their paragraph', () => {
    const { ctx, resolve } = setup();
    const pa = docRect(p('pa'));
    const d = noteAt(ctx, { x: pa.x + 50, y: pa.y + pa.h + 2, w: 100, h: 10 });
    expect(d.anchor).toMatchObject({ type: 'block', place: 'below' });
    p('title').after(Object.assign(document.createElement('p'), { textContent: paragraph(rng(8), 2) }));
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.el).toBe(p('pa'));
    const now = docRect(p('pa'));
    expectNear(r.origin, { x: now.x, y: now.y + now.h });
  });

  test('viewport notes follow their tied element, else the page fraction', () => {
    const { ctx, resolve } = setup();
    const blank = docRect(p('blank-area'));
    const d = noteAt(ctx, { x: blank.x + 30, y: blank.y + 300, w: 80, h: 40 });
    expect(d.anchor.type).toBe('viewport');
    expect(d.anchor.path.id).toBe('blank-area');
    p('pa').before(Object.assign(document.createElement('p'), { textContent: paragraph(rng(9), 3) }));
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expectNear(r.origin, { x: docRect(p('blank-area')).x, y: docRect(p('blank-area')).y });
    expect(r.scale).toBe(1);
    p('blank-area').remove();
    resolve.invalidate();
    const f = resolve.resolve(d.anchor, d.frame)!;
    expect(f.el).toBe(document.documentElement);
  });

  test('media with no address is found again by the text around it', () => {
    const r0 = rng(12);
    const f = mount(
      `${STYLE}<main><p>${paragraph(r0, 2)}</p><canvas width="200" height="80"></canvas><p>${paragraph(r0, 2)}</p><canvas width="200" height="80"></canvas><p>${paragraph(r0, 2)}</p></main>`,
    );
    const resolve = createResolver(f.ctx);
    const second = document.querySelectorAll('canvas')[1]!;
    const d = noteAt(f.ctx, { ...docRect(second), w: 50, h: 30 });
    expect(d.anchor.type).toBe('media');
    // Break the structural path: a wrapper and a new canvas in front.
    const main = document.querySelector('main')!;
    const wrap = document.createElement('section');
    wrap.append(...main.childNodes);
    main.append(wrap);
    wrap.prepend(Object.assign(document.createElement('canvas'), { width: 50, height: 50 }));
    resolve.invalidate();
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(r.method).toBe('media');
    expect(r.el).toBe(second);
  });

  test('links are kept for the anchor', () => {
    const f = mount(
      `${STYLE}<main><p>Please read <a href="https://example.com/guide">the full guide</a> before you start.</p></main>`,
    );
    const a = document.querySelector('a')!;
    const d = describeRange(f.ctx, wordRange(a, 1, 2));
    expect(d.anchor.link).toBe('https://example.com/guide');
    const pr = docRect(document.querySelector('p')!);
    const m = noteAt(f.ctx, { x: pr.x + pr.w + 10, y: pr.y, w: 40, h: 20 });
    expect(m.anchor.type).toBe('block');
    expect(m.anchor.link).toBe('https://example.com/guide');
  });

  test('describeRange gives a text anchor that resolves to the same range', () => {
    const { ctx, resolve } = setup();
    const range = wordRange(p('ph'), 3, 6);
    const d = describeRange(ctx, range);
    expect(d.anchor.type).toBe('text');
    expect(d.anchor.quote.exact).toBe(fold(range.toString()));
    const r = resolve.resolve(d.anchor, d.frame)!;
    expect(fold(r.range!.toString())).toBe(d.anchor.quote.exact);
    expectNear(r.origin, d.origin);
    expect(d.anchor.link).toBeUndefined();
  });
});

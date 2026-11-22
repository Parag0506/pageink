// One test per anchoring rule that came out of the test set. Each one fails if its rule is removed.
import { afterAll, afterEach, beforeAll, beforeEach, expect, describe as group, test } from 'vitest';
import { page } from 'vitest/browser';
import type { AnchorContext, Rect } from '../types';
import { describe } from './describe';
import { docRect, paragraph, reveal, rng, STYLE } from './fixtures';
import { lineAt } from './geom';
import { createResolver } from './resolve';
import { dropModel, getModel } from './text';

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
});

const ctx: AnchorContext = { doc: document };
const $ = (id: string) => document.getElementById(id)!;

function show(html: string): void {
  document.body.innerHTML = `${STYLE}${html}`;
  dropModel(document);
}

function noteAt(box: Rect) {
  reveal(box);
  return describe(ctx, box);
}

/** A margin box level with the second line of an element, just left of it. */
function leftMargin(el: Element, gap = 14, w = 36): Rect {
  const r = docRect(el);
  return { x: r.x - gap - w, y: r.y + 26, w, h: 18 };
}

group('margin notes', () => {
  test('a sticky sidebar and its tall button never hold a note level with running text', () => {
    const r = rng(3);
    show(`
      <div style="display:flex">
        <div role="navigation" style="position:sticky;top:0;align-self:flex-start;width:240px;height:700px;overflow:hidden;display:flex">
          <div style="flex:1">${Array.from({ length: 12 }, () => `<p>${paragraph(r, 1)}</p>`).join('')}</div>
          <div id="btn" style="width:12px;height:700px;cursor:pointer">«</div>
        </div>
        <main style="margin:0 0 0 60px;max-width:560px">
          ${Array.from({ length: 6 }, (_, i) => `<p id="q${i}">${paragraph(r, 4)}</p>`).join('')}
        </main>
      </div>`);
    const target = $('q3');
    // The note sits in the gap between the sidebar button and the paragraph.
    const box = leftMargin(target, 40, 30);
    const d = noteAt(box);
    expect(d.anchor.type).toBe('block');
    expect(d.anchor.place).toBe('left');
    expect(createResolver(ctx).resolve(d.anchor, d.frame)?.el).toBe(target);
  });

  test('a wrapper with a stray line of text does not claim a note beside one of its items', () => {
    const r = rng(5);
    show(`
      <div id="wrap" style="max-width:640px;margin:0 auto">Skip to content
        <ul style="padding-left:80px">
          ${Array.from({ length: 6 }, (_, i) => `<li id="li${i}">${paragraph(r, 2)}</li>`).join('')}
        </ul>
      </div>`);
    const target = $('li4');
    const d = noteAt(leftMargin(target, 30, 30));
    expect(d.anchor.type).toBe('block');
    expect(createResolver(ctx).resolve(d.anchor, d.frame)?.el).toBe(target);
  });

  test('with no running text level with the note, chrome may still hold it', () => {
    show(`
      <nav id="side" style="width:200px"><p id="n1">Home</p><p>About this site and its many pages</p></nav>
      <div class="blank"></div>`);
    const n = docRect($('n1'));
    const d = noteAt({ x: n.x + 120, y: n.y, w: 40, h: 16 });
    expect(d.anchor.type).toBe('block');
    expect(createResolver(ctx).resolve(d.anchor, d.frame)?.el).toBe($('n1'));
  });

  test('a note level with one list item and touching the one above belongs to the one it is level with', () => {
    show(`<ol style="max-width:500px;margin:40px auto;padding-left:0;line-height:14px;font-size:16px">
      <li id="up" style="list-style:none">Do you have testers?</li>
      <li id="down" style="list-style:none">Do new candidates write code during their interview?</li>
    </ol>`);
    const down = $('down');
    const r = docRect(down);
    // Text boxes are taller than the 14 px lines, so the note grazes the item above.
    const d = noteAt({ x: r.x - 50, y: r.y, w: 36, h: 14 });
    expect(d.anchor.place).toBe('left');
    expect(createResolver(ctx).resolve(d.anchor, d.frame)?.el).toBe(down);
  });
});

group('resolving', () => {
  const words = (r: () => number, n: number) => paragraph(r, n);

  test('a heading whose surroundings changed on both sides is found as the same whole block', () => {
    const r = rng(9);
    show(
      `<main><p>${words(r, 3)}</p><h2 id="syn">Syntax</h2><p>${words(r, 3)}</p><h2>Formal syntax</h2><p>${words(r, 2)}</p></main>`,
    );
    const h = $('syn');
    reveal(docRect(h));
    const d = describe(ctx, { ...docRect(h), w: 30 });
    expect(d.anchor.quote.exact).toBe('Syntax');
    // New text on both sides, and a new section before it so the path moves too.
    const r2 = rng(10);
    show(
      `<main><p>${words(r2, 3)}</p><section><h3>Intro</h3></section><h2 id="syn2">Syntax</h2><p>${words(r2, 3)}</p><h2>Formal syntax</h2><p>${words(r2, 2)}</p></main>`,
    );
    expect(createResolver(ctx).resolve(d.anchor, d.frame)?.el).toBe($('syn2'));
    // Two such headings cannot be told apart: the tray.
    document.querySelector('main')!.insertAdjacentHTML('beforeend', '<h2>Syntax</h2>');
    dropModel(document);
    expect(createResolver(ctx).resolve(d.anchor, d.frame)).toBeNull();
  });

  test('a path into a block with an identical twin is not trusted; the text position decides', () => {
    const r = rng(12);
    const twin =
      'The bytearray version of this method does not operate in place, it always produces a new object.';
    const long = words(r, 6);
    show(`<main><p>Lead.</p><p>${twin}</p><p>${long}</p><p>${twin}</p><p>${words(r, 2)}</p></main>`);
    const second = document.querySelectorAll('main p')[3]!;
    const range = document.createRange();
    const t = second.firstChild as Text;
    range.setStart(t, t.data.indexOf('not'));
    range.setEnd(t, t.data.indexOf('not') + 3);
    reveal(docRect(second));
    const rr = range.getBoundingClientRect();
    const d = describe(ctx, {
      x: rr.left + scrollX + 1,
      y: rr.top + scrollY + 1,
      w: rr.width - 2,
      h: rr.height - 2,
    });
    expect(d.anchor.quote.exact).toBe('not');
    // Two short paragraphs added above shift every positional path: the path now names the first twin.
    document.querySelector('main p')!.insertAdjacentHTML('afterend', '<p>New.</p><p>Also new.</p>');
    dropModel(document);
    const res = createResolver(ctx).resolve(d.anchor, d.frame)!;
    expect(res.el).toBe(second);
  });

  test('a table with nothing to compare is confirmed by its text or its surroundings, not by its path alone', () => {
    const r = rng(14);
    const table = (rows: string) => `<table><tr><th>Rank</th><th>Building</th></tr>${rows}</table>`;
    show(
      `<main><p>${words(r, 2)}</p>${table('<tr><td>1</td><td>Tower A</td></tr><tr><td>2</td><td>Tower B</td></tr>')}<p>Between the two lists.</p>${table('<tr><td>1</td><td>Tower C</td></tr><tr><td>2</td><td>Tower D</td></tr>')}<p>After both lists.</p></main>`,
    );
    const second = document.querySelectorAll('table')[1]!;
    const b = docRect(second);
    reveal(b);
    // Over the cells of all three rows, so the note is on the table and not on one cell's words.
    const d = describe(ctx, { x: b.x + 10, y: b.y + 10, w: b.w - 20, h: b.h - 20 });
    expect(d.anchor.type).toBe('media');
    // A different page state: two unrelated tables. The positional path names the second one.
    const r2 = rng(15);
    show(
      `<main><p>${words(r2, 2)}</p>${table('<tr><td>9</td><td>Other</td></tr>')}<p>${words(r2, 2)}</p>${table('<tr><td>7</td><td>Another</td></tr>')}<p>${words(r2, 2)}</p></main>`,
    );
    expect(createResolver(ctx).resolve(d.anchor, d.frame)).toBeNull();
  });
});

group('text model', () => {
  test('text hidden only by visibility is left out, and a child that shows itself again is kept', () => {
    show(
      '<p id="v">Shown words <span style="visibility:hidden">secret words <b style="visibility:visible">back again</b></span> end.</p>',
    );
    const m = getModel(ctx);
    expect(m.text).toContain('Shown words');
    expect(m.text).not.toContain('secret');
    expect(m.text).toContain('back again');
  });

  test('the line at a height is found when an inline block breaks top to bottom text order', () => {
    const r = rng(21);
    show(
      `<div id="ib" style="width:600px;font:16px/20px Arial,sans-serif">Short lead words here. <span style="display:inline-block;width:90px">one two three four five six seven eight nine ten</span> ${paragraph(r, 8)}</div>`,
    );
    const m = getModel(ctx);
    const el = $('ib');
    const span = m.spanOf(el)!;
    const inner = el.querySelector('span')!.getBoundingClientRect();
    // Every line inside the inline block must come back as a line at that height.
    for (let y = inner.top + 10; y < inner.bottom - 5; y += 20) {
      const line = lineAt(m, span, y)!;
      const box = m.range(line.start, line.end)!.getClientRects()[0]!;
      expect(y >= box.top - 2 && y <= box.bottom + 2, `y ${y} got line at ${box.top}`).toBe(true);
    }
  });
});

group('hyphenation', () => {
  test('a word broken with a hyphen at a line end does not join two lines into one', () => {
    const word = 'internation&shy;alization';
    // A column narrower than the whole word, measured in this font, so it never fits on one line.
    show(
      `<span id="w" style="font:16px/26px Arial,sans-serif;white-space:nowrap">internationalization</span>`,
    );
    const width = Math.floor($('w').getBoundingClientRect().width * 0.8);
    show(
      `<p id="h" style="width:${width}px;font:16px/26px Arial,sans-serif">${Array.from({ length: 8 }, () => `at ${word} it`).join(' ')}</p>`,
    );
    const m = getModel(ctx);
    const el = $('h');
    const span = m.spanOf(el)!;
    const box = el.getBoundingClientRect();
    for (let y = box.top + 13; y < box.bottom; y += 26) {
      const line = lineAt(m, span, y)!;
      // The word never fits on one line, so a line that holds all of it is two lines run together.
      const text = m.text.slice(line.start, line.end);
      expect(text.includes('internation\u00adalization'), `line at ${y}: ${text}`).toBe(false);
    }
  });
});

group('lazy layout', () => {
  test('content skipped by content-visibility never holds a margin note, even where its boxes spill', () => {
    const r = rng(31);
    show(`<main style="position:relative;max-width:600px;margin:0 auto">
      ${Array.from({ length: 6 }, (_, i) => `<p id="n${i}">${paragraph(r, 3)}</p>`).join('')}
      <p id="ghost" style="position:absolute;left:-76px;width:70px;top:0;font-size:10px">${paragraph(r, 6)}</p>
    </main>`);
    const target = $('n3');
    const ghost = $('ghost');
    // A skipped section keeps the boxes it had when it was last drawn. Here the stale box sits
    // right beside the note, closer than the paragraph the note was written next to.
    const main = docRect(ghost.parentElement!);
    ghost.style.top = `${docRect(target).y - main.y - 40}px`;
    ghost.style.left = `${docRect(target).x - main.x - 84}px`;
    const real = ghost.checkVisibility.bind(ghost);
    ghost.checkVisibility = (o?: CheckVisibilityOptions) =>
      (o as { contentVisibilityAuto?: boolean } | undefined)?.contentVisibilityAuto ? false : real(o);
    const d = noteAt(leftMargin(target, 4, 8));
    expect(createResolver(ctx).resolve(d.anchor, d.frame)?.el).toBe(target);
  });
});

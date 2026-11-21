/**
 * Fixture pages for the browser tests, built from HTML strings.
 * Image addresses use a scheme the browser never fetches, so tests stay offline.
 */
import type { AnchorContext, Rect } from '../types';

const VOCAB =
  'river stone lantern meadow copper signal harbor garden window ladder winter summer orchard canvas pepper marble thunder candle valley forest bridge castle mirror violet silver anchor basket feather planet rocket ticket jacket pocket pillow saddle tunnel velvet walnut zephyr amber cobalt dragon falcon glacier hollow island jungle kettle lemon magnet nectar oyster parrot quarry raven saffron tiger umbrella vessel willow yonder zenith across beneath beyond during toward within argued noticed carried painted measured whispered gathered followed reminded promised quickly slowly gently barely nearly openly quietly rarely the a of and to in that with for on as by from at'.split(
    ' ',
  );

/** Seeded generator so every run builds the same page. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function sentence(r: () => number, words = 12): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(VOCAB[Math.floor(r() * VOCAB.length)]!);
  const s = out.join(' ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

export function paragraph(r: () => number, sentences = 4): string {
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) out.push(sentence(r, 8 + Math.floor(r() * 8)));
  return out.join(' ');
}

export const STYLE = `
  <style>
    html, body { margin: 0; padding: 0; }
    body { font: 16px/1.5 Arial, Helvetica, sans-serif; color: #111; background: #fff; }
    header.top { position: sticky; top: 0; background: #eee; padding: 8px 16px; z-index: 2; }
    main { max-width: 640px; margin: 0 auto; padding: 0 16px; }
    p { margin: 0 0 18px; }
    figure { margin: 16px 0; }
    figure img, img.plain { display: block; width: 300px; height: 160px; background: #ccd; }
    table { border-collapse: collapse; margin: 16px 0; }
    td, th { border: 1px solid #999; padding: 4px 8px; }
    .scroller { height: 160px; overflow: auto; border: 1px solid #aaa; padding: 8px; margin: 16px 0; }
    .pdfpage { position: relative; width: 300px; height: 200px; background: #f6f6f6; margin: 16px 0; }
    .pdfpage span { position: absolute; left: 20px; font-size: 14px; }
    .blank { height: 400px; }
    .hidden { display: none; }
  </style>`;

export interface Fixture {
  ctx: AnchorContext;
  /** Hosts with closed shadow roots, for tests that edit them. */
  closed: Map<Element, ShadowRoot>;
  root: HTMLElement;
}

/** The main article page. Every kind of anchor has something to sit on. */
export function articleHtml(seed = 7): string {
  const r = rng(seed);
  const paras = Array.from(
    { length: 8 },
    (_, i) => `<p id="p${String.fromCharCode(97 + i)}">${paragraph(r, 4)}</p>`,
  );
  return `${STYLE}
  <header class="top" id="site-header"><span>Daily ${sentence(r, 4)}</span></header>
  <main id="content">
    <article>
      <h1 id="title">${sentence(r, 6)}</h1>
      ${paras.slice(0, 3).join('\n')}
      <figure id="fig-1"><img src="ink-test://media/img/photo-1.png?v=1" alt="A quiet harbor at dawn" width="300" height="160"><figcaption>${sentence(r, 6)}</figcaption></figure>
      ${paras.slice(3, 5).join('\n')}
      <table id="tbl"><caption>Harbor tides by month</caption><tr><th>Month</th><th>High</th></tr><tr><td>March</td><td>4.1 m</td></tr><tr><td>April</td><td>3.8 m</td></tr></table>
      <div class="pdfpage" data-ink-media="page-1"><span style="top:20px">${sentence(r, 5)}</span><span style="top:60px">${sentence(r, 5)}</span></div>
      <div class="scroller" id="box">${Array.from({ length: 4 }, () => `<p>${paragraph(r, 2)}</p>`).join('')}</div>
      ${paras.slice(5).join('\n')}
      <open-card id="oc"></open-card>
      <closed-card id="cc"></closed-card>
      <p class="hidden">${sentence(r, 6)}</p>
      <script>var notText = 1;</script>
    </article>
    <div class="blank" id="blank-area"></div>
  </main>`;
}

/** Mount a page and attach its shadow roots. */
export function mount(html: string, seed = 11): Fixture {
  document.body.innerHTML = html;
  const closed = new Map<Element, ShadowRoot>();
  const r = rng(seed);
  for (const host of document.querySelectorAll('open-card')) {
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>p{margin:0 0 12px}</style><p>${paragraph(r, 2)}</p><p>${paragraph(r, 2)}</p>`;
  }
  for (const host of document.querySelectorAll('closed-card')) {
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>p{margin:0 0 12px}</style><p>${paragraph(r, 2)}</p><p>${paragraph(r, 2)}</p>`;
    closed.set(host, root);
  }
  const ctx: AnchorContext = {
    doc: document,
    shadowRootOf: (el) => closed.get(el) ?? null,
    isOurs: (el) => el.localName === 'ink-layer',
  };
  return { ctx, closed, root: document.body };
}

/** Document-space box around the client rects of a range. */
export function boxOfRange(range: Range): Rect {
  const r = range.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
}

export function docRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
}

/** Scroll so a document-space box is in view, near the top third. */
export function reveal(box: Rect): void {
  scrollTo(0, Math.max(0, box.y - innerHeight / 3));
}

/** Range over the n-th to m-th words of an element's first text node. */
export function wordRange(el: Element | ShadowRoot, from: number, to: number): Range {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const node = walker.nextNode() as Text;
  const re = /\S+/g;
  const spans: [number, number][] = [];
  for (let m = re.exec(node.data); m; m = re.exec(node.data)) spans.push([m.index, m.index + m[0].length]);
  const r = document.createRange();
  r.setStart(node, spans[from]![0]);
  r.setEnd(node, spans[Math.min(to, spans.length - 1)]![1]);
  return r;
}

/**
 * An encyclopedia page: a long contents list in a left column, the text, and a right rail. The
 * text has padding, an indent, a list, a quote, a float and two columns, so there are gaps on
 * both sides of lines and between columns.
 */
export function layoutHtml(seed: number): string {
  const r = rng(seed);
  const toc = Array.from(
    { length: 460 },
    (_, i) => `<li><a href="#s${i}">${i + 1} ${sentence(r, 2)}</a></li>`,
  );
  return `${STYLE}
  <style>
    #wrap { display: grid; grid-template-columns: 300px minmax(0, 1fr) 200px; column-gap: 24px; }
    #toc ul { list-style: none; margin: 0; padding: 0 0 0 12px; font-size: 13px; }
    #col { padding: 0 32px; }
    #col p.pad { padding-left: 24px; }
    #col p.indent { text-indent: 3em; }
    #col blockquote { margin: 0 64px 18px; }
    #col .info { float: right; width: 180px; margin: 0 0 12px 40px; font-size: 13px; }
    #col .cols { columns: 2; column-gap: 48px; }
    #rail { font-size: 13px; }
  </style>
  <div id="wrap">
    <nav id="toc"><ul>${toc.join('')}</ul></nav>
    <main id="col">
      <h1>${sentence(r, 4)}</h1>
      <p id="q1">${paragraph(r, 4)}</p>
      <p id="q2" class="pad">${paragraph(r, 4)}</p>
      <p id="q3" class="indent">${paragraph(r, 4)}</p>
      <ul><li id="q4">${paragraph(r, 2)}</li><li id="q5">${paragraph(r, 2)}</li></ul>
      <blockquote><p id="q6">${paragraph(r, 3)}</p></blockquote>
      <div class="info" id="q7">${paragraph(r, 3)}</div>
      <p id="q8">${paragraph(r, 6)}</p>
      <div class="cols"><p id="q9">${paragraph(r, 5)}</p><p id="q10">${paragraph(r, 5)}</p></div>
      <p id="q11">${paragraph(r, 4)}</p>
    </main>
    <aside id="rail"><p>${paragraph(r, 2)}</p></aside>
  </div>`;
}

/** Every piece of text on the page, document space. */
export function textPieces(): Rect[] {
  const out: Rect[] = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    if (!/\S/.test(t.nodeValue ?? '') || t.parentElement?.closest('style,script')) continue;
    range.selectNodeContents(t);
    for (const q of range.getClientRects())
      if (q.width > 0.5 && q.height > 0.5)
        out.push({ x: q.left + scrollX, y: q.top + scrollY, w: q.width, h: q.height });
  }
  return out;
}

export const isFree = (b: Rect, rs: Rect[], pad = 2): boolean =>
  rs.every(
    (q) =>
      b.x >= q.x + q.w + pad || q.x >= b.x + b.w + pad || b.y >= q.y + q.h + pad || q.y >= b.y + b.h + pad,
  );

/** Boxes in the gaps beside lines of the text column: centred between the line and the nearest text. */
export function gapBoxes(seed: number, text: Rect[]): Rect[] {
  const r = rng(seed);
  const out: Rect[] = [];
  for (const el of document.querySelectorAll('#col [id^="q"]')) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = [...range.getClientRects()]
      .filter((q) => q.width > 0.5 && q.height > 0.5)
      .map((q) => ({ x: q.left + scrollX, y: q.top + scrollY, w: q.width, h: q.height }));
    for (let i = 0; i < 3 && lines.length; i++) {
      const ln = lines[Math.floor(r() * lines.length)]!;
      const band = text.filter((q) => q.y < ln.y + ln.h && q.y + q.h > ln.y);
      const leftEdge = Math.max(0, ...band.filter((q) => q.x + q.w <= ln.x + 0.5).map((q) => q.x + q.w));
      const rightEdge = Math.min(
        document.documentElement.clientWidth,
        ...band.filter((q) => q.x >= ln.x + ln.w - 0.5).map((q) => q.x),
      );
      const h = 22;
      const y = ln.y + ln.h / 2 - h / 2;
      for (const [a, b] of [
        [leftEdge, ln.x],
        [ln.x + ln.w, rightEdge],
      ] as const) {
        const gap = b - a;
        if (gap < 30) continue;
        const w = Math.min(56, gap - 14);
        out.push({ x: a + (gap - w) / 2, y, w, h });
      }
    }
  }
  return out;
}

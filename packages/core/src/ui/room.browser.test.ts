// The bar at the bottom edge must not hide the end of a page for good: while it is shown
// there, the page can be scrolled on until its last line is clear of the bar. The page's own
// boxes and styles are never touched.
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { page } from 'vitest/browser';
import { frame, until } from '../testkit';
import type { InkState } from '../types';
import { fakeHost } from './fake';
import { createUi, resetUiSession } from './index';

const cleanup: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  scrollTo(0, 0);
});
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
  resetUiSession();
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('style');
  scrollTo(0, 0);
});

const html = document.documentElement;

/** Mounts like the real layer: a host on <html> with a closed shadow root and a fixed mount in it. */
function mountBar(opts: { barHideMs?: number; state?: Partial<InkState>; edge?: string } = {}) {
  const el = document.createElement('ink-layer');
  el.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0;pointer-events:none';
  const sr = el.attachShadow({ mode: 'closed' });
  const mount = document.createElement('div');
  mount.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0';
  sr.append(mount);
  html.append(el);
  const host = fakeHost(mount, { state: { draw: true, ...opts.state }, barHideMs: opts.barHideMs });
  const ui = createUi(host);
  let gone = false;
  const destroy = () => {
    if (gone) return;
    gone = true;
    ui.destroy();
    el.remove();
  };
  cleanup.push(destroy);
  const q = <T extends Element = HTMLElement>(s: string) => mount.querySelector(s) as T;
  const root = q('.iu');
  // The grip cycles bottom, left, top, right.
  const to = (edge: string) => {
    for (let i = 0; i < 4 && root.getAttribute('data-edge') !== edge; i++)
      q<HTMLButtonElement>('.grip').click();
    expect(root.getAttribute('data-edge')).toBe(edge);
  };
  to(opts.edge ?? 'bottom');
  return { host, ui, q, root, to, destroy, bar: () => q('.bar').getBoundingClientRect(), sr };
}

/** A plain page: the test page's own html and body are as tall as the screen, which few pages are. */
function plain(): void {
  html.style.height = 'auto';
  document.body.style.height = 'auto';
  document.body.style.margin = '0';
}

/** A page of the given height that ends in one line of text. */
function article(px: number, extra = ''): HTMLElement {
  plain();
  document.body.innerHTML = `<div id="fill" style="height:${px}px"></div>${extra}<p id="last" style="margin:0;font:16px/20px sans-serif">The last line of the page.</p>`;
  return document.getElementById('last') as HTMLElement;
}

/** Scroll as far as the page goes and say where the last line then is. */
async function atEnd(last: Element): Promise<DOMRect> {
  scrollTo(0, 1e7);
  await frame();
  return last.getBoundingClientRect();
}

/** Where the page's own elements are, to see that nothing moved. */
const layout = () =>
  [html, document.body, ...document.body.querySelectorAll('*')].map((e) => {
    const r = e.getBoundingClientRect();
    return [e.tagName, r.left, r.top + scrollY, r.width, r.height].join(' ');
  });

/** Scrollbars that take room from the page, as on Windows. Then a new scrollbar would move the layout. */
function classicScrollbars(): boolean {
  const p = document.createElement('div');
  p.style.cssText = 'position:absolute;width:60px;height:60px;overflow:scroll;visibility:hidden';
  document.body.append(p);
  const w = p.offsetWidth - p.clientWidth;
  p.remove();
  return w > 0;
}

describe('room at the end of the page', () => {
  test('the last line can be scrolled clear of a bar at the bottom', async () => {
    const last = article(3000);
    const before = await atEnd(last);
    scrollTo(0, 0);
    const { bar } = mountBar();
    // Without room, the end of the page stops at the bottom of the screen, under the bar.
    expect(before.bottom).toBeGreaterThan(bar().top);
    const r = await atEnd(last);
    expect(r.bottom).toBeLessThanOrEqual(bar().top);
    // Not a screen of blank space either: the line stops just above the bar.
    expect(bar().top - r.bottom).toBeLessThan(24);
  });

  test('the page layout is the same with the bar shown, hidden or gone', async () => {
    article(3000, '<p style="margin:10px">Some text in the page.</p><input id="f">');
    const own = html.scrollHeight;
    const was = layout();
    const { ui, root, destroy } = mountBar({ barHideMs: 30, state: { draw: false } });
    expect(html.scrollHeight).toBeGreaterThan(own);
    expect(layout()).toEqual(was);
    // The bar hides after a while without ink input. The room goes with it.
    await until(() => root.classList.contains('hid'), 'bar hidden');
    expect(html.scrollHeight).toBe(own);
    expect(layout()).toEqual(was);
    ui.wake();
    expect(html.scrollHeight).toBeGreaterThan(own);
    destroy();
    expect(html.scrollHeight).toBe(own);
    expect(layout()).toEqual(was);
  });

  test('nothing is added to the page itself: the room is one box in the layer', () => {
    article(3000);
    const body = document.body.innerHTML;
    const attrs = (e: Element) => [...e.attributes].map((a) => `${a.name}=${a.value}`).join(' ');
    const before = [attrs(html), attrs(document.body), html.childElementCount];
    const { sr } = mountBar();
    expect(document.body.innerHTML).toBe(body);
    // One host on <html>, as before. The page's root and body keep their attributes and styles.
    expect([attrs(html), attrs(document.body), html.childElementCount - 1]).toEqual(before);
    expect(sr.querySelectorAll('.iu-room').length).toBe(1);
    const box = sr.querySelector('.iu-room') as HTMLElement;
    expect(getComputedStyle(box).pointerEvents).toBe('none');
    expect(getComputedStyle(box).visibility).toBe('hidden');
  });

  test('only a bar at the bottom edge takes room', async () => {
    article(3000);
    const own = html.scrollHeight;
    const { to } = mountBar();
    expect(html.scrollHeight).toBeGreaterThan(own);
    for (const edge of ['left', 'top', 'right']) {
      to(edge);
      expect(html.scrollHeight, edge).toBe(own);
    }
    to('bottom');
    expect(html.scrollHeight).toBeGreaterThan(own);
  });

  test("a page's own fixed footer stays where it is, and the text above it comes clear of the bar", async () => {
    document.body.style.paddingBottom = '50px';
    const last = article(
      3000,
      '<div id="foot" style="position:fixed;left:0;right:0;bottom:0;height:50px;background:#ccc">Footer</div>',
    );
    const foot = document.getElementById('foot') as HTMLElement;
    const f0 = foot.getBoundingClientRect();
    const { bar } = mountBar();
    const r = await atEnd(last);
    expect(foot.getBoundingClientRect()).toEqual(f0);
    expect(r.bottom).toBeLessThanOrEqual(bar().top);
    expect(r.bottom).toBeLessThanOrEqual(f0.top);
  });

  test('a footer that sticks to the bottom of the page comes clear of the bar too', async () => {
    plain();
    document.body.innerHTML =
      '<div style="height:3000px"></div><div id="last" style="position:sticky;bottom:0;height:40px;background:#ccc">Footer</div>';
    const last = document.getElementById('last') as HTMLElement;
    const { bar } = mountBar();
    const r = await atEnd(last);
    expect(r.bottom).toBeLessThanOrEqual(bar().top);
  });

  test('the room follows the page when it grows or shrinks', async () => {
    const last = article(3000);
    const { bar } = mountBar();
    const fill = document.getElementById('fill') as HTMLElement;
    fill.style.height = '5000px';
    await frame();
    let r = await atEnd(last);
    expect(r.bottom).toBeLessThanOrEqual(bar().top);
    expect(bar().top - r.bottom).toBeLessThan(24);
    // Shorter again, as when a section closes. No blank screen is left behind.
    fill.style.height = '2000px';
    await frame();
    r = await atEnd(last);
    expect(r.bottom).toBeLessThanOrEqual(bar().top);
    expect(bar().top - r.bottom).toBeLessThan(24);
  });

  test('a page whose body has a fixed height: the room is found again when the reader gets there', async () => {
    // The content overflows a body as tall as the screen, so no box of the page changes size
    // when it grows. The room moves when it scrolls into view, or out of it.
    html.style.height = '100%';
    document.body.style.height = '100%';
    const last = article(3000);
    const { bar } = mountBar();
    let r = await atEnd(last);
    expect(r.bottom).toBeLessThanOrEqual(bar().top);
    const fill = document.getElementById('fill') as HTMLElement;
    const clear = async (label: string) => {
      await until(() => {
        scrollTo(0, 1e7);
        const l = last.getBoundingClientRect();
        const b = bar();
        return l.bottom <= b.top && b.top - l.bottom < 24;
      }, label);
    };
    scrollTo(0, 0);
    await frame();
    fill.style.height = '6000px';
    await clear('room after the page grew');
    fill.style.height = '1500px';
    await clear('room after the page shrank');
    r = await atEnd(last);
    expect(r.bottom).toBeLessThanOrEqual(bar().top);
  });

  test('rotation and resize: the room is the height the bar covers now', async () => {
    const last = article(3000);
    const { bar } = mountBar();
    cleanup.push(() => page.viewport(414, 896));
    for (const [w, h] of [
      [896, 414],
      [300, 560],
      [1366, 1024],
    ] as const) {
      await page.viewport(w, h);
      await frame();
      const r = await atEnd(last);
      expect(innerHeight).toBe(h);
      expect(r.bottom, `${w}x${h}`).toBeLessThanOrEqual(bar().top);
      expect(bar().top - r.bottom, `${w}x${h}`).toBeLessThan(24);
    }
  });

  test('a page that does not scroll the document is left alone', async () => {
    // An app that scrolls an inner pane and locks the document.
    html.style.overflow = 'hidden';
    article(3000);
    const own = html.scrollHeight;
    const { sr } = mountBar();
    await frame();
    expect(html.scrollHeight).toBe(own);
    expect((sr.querySelector('.iu-room') as HTMLElement).hidden).toBe(true);
  });

  test('a short page gets room only where a new scrollbar takes no space', async () => {
    // The page ends under the bar, and does not scroll.
    plain();
    document.body.innerHTML = `<div style="height:${innerHeight - 20}px"></div><p id="last" style="margin:0;font:16px/20px sans-serif">The last line.</p>`;
    const last = document.getElementById('last') as HTMLElement;
    const width = html.clientWidth;
    const was = layout();
    const { bar } = mountBar();
    await frame();
    expect(html.clientWidth).toBe(width);
    expect(layout()).toEqual(was);
    if (classicScrollbars()) {
      // A scrollbar would appear and push the page narrower. The reader moves the bar instead.
      expect(html.scrollHeight).toBe(html.clientHeight);
    } else {
      const r = await atEnd(last);
      expect(r.bottom).toBeLessThanOrEqual(bar().top);
    }
  });

  test('a short page with a scrollbar that takes space keeps its width: no room', async (ctx) => {
    // A page can give its scrollbar a width in WebKit and Chromium. Headless Chromium shows no
    // scrollbars at all and Firefox has overlay ones here, so this runs where the bar is real.
    const style = document.createElement('style');
    style.textContent = 'html::-webkit-scrollbar{width:16px}html::-webkit-scrollbar-thumb{background:#888}';
    document.head.append(style);
    cleanup.push(() => style.remove());
    plain();
    document.body.innerHTML = `<div style="height:${innerHeight - 20}px"></div><p id="last" style="margin:0;font:16px/20px sans-serif">The last line.</p>`;
    const width = html.clientWidth;
    const probe = document.createElement('div');
    probe.style.height = '3000px';
    document.body.append(probe);
    await frame();
    const narrower = html.clientWidth < width;
    probe.remove();
    await until(() => html.clientWidth === width, 'page as wide as before');
    if (!narrower) ctx.skip();
    const was = layout();
    const settled = () => html.clientWidth === width && html.scrollHeight === html.clientHeight;
    mountBar();
    // WebKit shows a new scrollbar a moment after the layout that needs it, so the room is
    // taken away in the next frame there. Elsewhere it never shows.
    await until(settled, 'no room and the old width');
    expect(layout()).toEqual(was);
    // A change of size fits the room again, and the answer stays the same.
    dispatchEvent(new Event('resize'));
    await frame();
    await frame();
    expect(settled()).toBe(true);
    expect(layout()).toEqual(was);
  });

  test('a short page that ends above the bar gets no room, however tall its body is', async () => {
    // The body is at least as tall as the screen here, as on many pages that keep a footer down.
    plain();
    document.body.innerHTML = '<p id="last" style="margin:0">A few words.</p>';
    expect(document.body.getBoundingClientRect().height).toBe(innerHeight);
    const { sr, bar } = mountBar();
    await frame();
    expect(html.scrollHeight).toBe(html.clientHeight);
    expect((sr.querySelector('.iu-room') as HTMLElement).hidden).toBe(true);
    // The same page with words where the bar is: now there is something to scroll clear.
    const low = document.createElement('p');
    low.style.cssText = `margin:0;position:absolute;left:0;top:${bar().top + 10}px`;
    low.textContent = 'Words under the bar.';
    document.body.append(low);
    dispatchEvent(new Event('resize'));
    await frame();
    if (!classicScrollbars()) {
      const r = await atEnd(low);
      expect(r.bottom).toBeLessThanOrEqual(bar().top);
    }
  });

  test('the room does not print', () => {
    article(3000);
    const { sr } = mountBar();
    const rules = sr.adoptedStyleSheets.flatMap((s) => [...s.cssRules]);
    const print = rules.filter(
      (r): r is CSSMediaRule => r instanceof CSSMediaRule && r.media.mediaText === 'print',
    );
    expect(print.some((r) => /\.iu-room\s*\{[^}]*display:\s*none/.test(r.cssText))).toBe(true);
  });
});

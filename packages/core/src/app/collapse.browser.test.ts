// Ink on content that opens and closes: sections, accordions, tabs, menus, popovers, dialogs.
// Ink is painted only where its content is painted, hides with it, and comes back in place.
import { afterEach, expect, describe as group, test } from 'vitest';
import { page } from 'vitest/browser';
import { describe } from '../anchor/describe';
import { createResolver } from '../anchor/resolve';
import { dropModel } from '../anchor/text';
import { createPlacer } from '../place/placer';
import { createLayer, type InkLayer } from '../render/layer';
import type { AnchorContext, Note, Placer, Rect } from '../types';
import { quiet, until } from './testkit';

const ctx: AnchorContext = { doc: document, isOurs: (el) => el.localName === 'ink-layer' };
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.body.innerHTML = '';
  for (const s of document.head.querySelectorAll('style[data-t]')) s.remove();
  dropModel(document);
  scrollTo(0, 0);
});

const $ = (id: string) => document.getElementById(id)!;
const CSS = 'body{margin:0;font:16px/24px sans-serif;color:#f00;background:#fff}p{margin:0 0 8px}';

function show(html: string, css = ''): void {
  const st = document.createElement('style');
  st.dataset.t = '';
  st.textContent = CSS + css;
  document.head.append(st);
  document.body.innerHTML = html;
  dropModel(document);
}

/** Client box of a word inside an element. */
function wordBox(el: Element, word: string): DOMRect {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = (n as Text).data.indexOf(word);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(n, i);
    r.setEnd(n, i + word.length);
    return r.getBoundingClientRect();
  }
  throw new Error(`no word ${word}`);
}

let seq = 0;
/** A note written as a filled box over a client rect, anchored by describe() as a reader would. */
function noteOver(r: { left: number; top: number; width: number; height: number }): Note {
  const box: Rect = { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  const d = describe(ctx, box);
  const x = box.x - d.origin.x;
  const y = box.y - d.origin.y;
  const id = `c${++seq}`;
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    device: 't',
    kind: 'ink',
    anchor: d.anchor,
    frame: d.frame,
    strokes: [
      {
        id: `${id}s`,
        t: 1,
        tool: 'pen',
        color: 'ink-1',
        w: 2,
        pts: [0, 0, 50, 10, 0, 0],
        d: `M${x} ${y}H${x + box.w}V${y + box.h}H${x}Z`,
      },
    ],
  };
}

function rig(): { placer: Placer; layer: InkLayer } {
  const resolver = createResolver(ctx);
  const layer = createLayer(document, { theme: 'light' }) as InkLayer;
  const placer = createPlacer({ doc: document, resolver, layer });
  cleanups.push(() => {
    placer.destroy();
    layer.destroy();
  });
  return { placer, layer };
}

/** The open or close and its passes have run. */
const settle = (): Promise<void> => quiet('settle');

const state = (p: Placer, n: Note): 'placed' | 'hidden' | 'unplaced' | 'none' =>
  p.all().some((x) => x.id === n.id)
    ? 'placed'
    : p.hidden!().some((x) => x.id === n.id)
      ? 'hidden'
      : p.unplaced().some((x) => x.id === n.id)
        ? 'unplaced'
        : 'none';

/** Client box of a note's drawn ink, as painted: its clip applied. Null when nothing shows. */
function painted(layer: InkLayer, id: string): DOMRect | null {
  const g = layer.root.querySelector(`g[data-note="${id}"] path`)?.parentElement as SVGGElement | null;
  if (!g) return null;
  const r = g.getBoundingClientRect();
  // The clip in container space is on the decoration group beside the strokes: document units.
  const cp = (g.nextElementSibling as SVGGElement | null)?.getAttribute('clip-path');
  if (!cp) return r.width && r.height ? r : null;
  const rect = layer.root.querySelector(`${cp.slice(4, -1)} rect`) as SVGRectElement;
  const n = (a: string) => Number(rect.getAttribute(a));
  const cl = n('x') - scrollX;
  const ct = n('y') - scrollY;
  const l = Math.max(r.left, cl);
  const t = Math.max(r.top, ct);
  const rt = Math.min(r.right, cl + n('width'));
  const b = Math.min(r.bottom, ct + n('height'));
  return l < rt && t < b ? new DOMRect(l, t, rt - l, b - t) : null;
}

const near = (a: DOMRect | null, b: DOMRect, slack = 1.5): boolean =>
  !!a &&
  Math.abs(a.left - b.left) <= slack &&
  Math.abs(a.top - b.top) <= slack &&
  Math.abs(a.width - b.width) <= slack &&
  Math.abs(a.height - b.height) <= slack;

/** Base64 PNG pixels, as RGBA rows, for sampling. */
async function shot(): Promise<{ at(x: number, y: number): number[] }> {
  const b64 = await page.screenshot({ save: false });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d')!;
  g.drawImage(bmp, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  const dpr = devicePixelRatio;
  return {
    at(x, y) {
      const i = (Math.round(y * dpr) * c.width + Math.round(x * dpr)) * 4;
      return [data[i]!, data[i + 1]!, data[i + 2]!];
    },
  };
}
/** The pen colour in the light theme, #1f2a44, and the red of the page text. */
const isInk = (p: number[]) => p[0]! < 70 && p[1]! < 80 && p[2]! < 110 && p[2]! > p[0]!;
const isText = (p: number[]) => p[0]! > 150 && p[1]! < 120 && p[2]! < 120;

group('sections that open and close', () => {
  test('a <details> section: the note hides with it and comes back in place', async () => {
    show(
      '<p>Intro words here.</p><details id="d" open><summary>More</summary><p id="in">Inside a pumpkin field.</p></details><p id="after">After words.</p>',
    );
    const n = noteOver(wordBox($('in'), 'pumpkin'));
    expect(n.anchor.path.css).toContain('in');
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    const open = painted(layer, n.id)!;
    expect(near(open, wordBox($('in'), 'pumpkin'))).toBe(true);
    ($('d') as HTMLDetailsElement).open = false;
    await settle();
    expect(state(placer, n)).toBe('hidden');
    expect(painted(layer, n.id)).toBeNull();
    // Hidden with its content: not missing, so never offered to the tray.
    expect(placer.unplaced()).toEqual([]);
    ($('d') as HTMLDetailsElement).open = true;
    await settle();
    expect(state(placer, n)).toBe('placed');
    expect(near(painted(layer, n.id), open)).toBe(true);
  });

  test('nested sections: the inner note shows only when both are open', async () => {
    show(
      '<details id="o" open><summary>Outer</summary><details id="i" open><summary>Inner</summary><p id="t">Nested walnut text.</p></details></details>',
    );
    const n = noteOver(wordBox($('t'), 'walnut'));
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    const open = painted(layer, n.id)!;
    ($('o') as HTMLDetailsElement).open = false;
    await settle();
    expect(state(placer, n)).toBe('hidden');
    ($('o') as HTMLDetailsElement).open = true;
    await settle();
    expect(near(painted(layer, n.id), open)).toBe(true);
    ($('i') as HTMLDetailsElement).open = false;
    await settle();
    expect(state(placer, n)).toBe('hidden');
    expect(painted(layer, n.id)).toBeNull();
  });

  test('a section deleted while closed: the note becomes missing, not hidden forever', async () => {
    show(
      '<details id="d" open><summary>More</summary><p id="in">Gone soon apricot.</p></details><p>Other text.</p>',
    );
    const n = noteOver(wordBox($('in'), 'apricot'));
    const { placer } = rig();
    placer.setNotes([n]);
    await settle();
    ($('d') as HTMLDetailsElement).open = false;
    await settle();
    expect(state(placer, n)).toBe('hidden');
    $('d').remove();
    await settle();
    expect(state(placer, n)).toBe('unplaced');
  });

  test('a page loaded with the section closed: hidden, then in place when opened', async () => {
    show('<details id="d" open><summary>More</summary><p id="in">Later fennel words.</p></details>');
    const n = noteOver(wordBox($('in'), 'fennel'));
    const want = wordBox($('in'), 'fennel');
    ($('d') as HTMLDetailsElement).open = false;
    dropModel(document);
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    await until(() => placer.waiting!() === 0, 'decided');
    expect(state(placer, n)).toBe('hidden');
    expect(placer.unplaced()).toEqual([]);
    ($('d') as HTMLDetailsElement).open = true;
    await settle();
    expect(near(painted(layer, n.id), want)).toBe(true);
  });

  test('hidden="until-found" content hides the note, and showing it brings it back', async () => {
    show('<p>Lead text.</p><div id="h"><p id="in">Found quince words.</p></div>');
    const n = noteOver(wordBox($('in'), 'quince'));
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    const open = painted(layer, n.id)!;
    $('h').setAttribute('hidden', 'until-found');
    await settle();
    expect(state(placer, n)).toBe('hidden');
    $('h').removeAttribute('hidden');
    await settle();
    expect(near(painted(layer, n.id), open)).toBe(true);
  });

  test('a note below a section follows at once when the section above opens', async () => {
    show(
      '<details id="d"><summary>More</summary><p>One line.</p><p>Two line.</p><p>Three line.</p></details><p id="below">Below the radish section.</p>',
    );
    const n = noteOver(wordBox($('below'), 'radish'));
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    ($('d') as HTMLDetailsElement).open = true;
    // The open is seen from its attribute or its toggle event, with no polling: once the
    // frames, idle callbacks and short timers have run, the note has followed.
    await settle();
    expect(near(painted(layer, n.id), wordBox($('below'), 'radish'))).toBe(true);
  });
});

group('accordions that clip', () => {
  test('a height animation with overflow hidden cuts the ink at the same line as the text, frame by frame', async () => {
    show(
      `<div id="acc" style="overflow:hidden;transition:height 4s linear">
        ${Array.from({ length: 9 }, (_, i) => `<p id="l${i}">Line ${i} carries mango words to sample.</p>`).join('')}
      </div><p>After the accordion.</p>`,
    );
    // The accordion starts at the height of its lines, measured, since line height depends on the
    // font. From auto to a length is no transition.
    const acc = $('acc');
    const full = acc.scrollHeight;
    acc.style.height = `${full}px`;
    // A tall note over three lines, so a cut through it shows.
    const a = wordBox($('l3'), 'mango');
    const b = wordBox($('l5'), 'mango');
    const n = noteOver({ left: a.left, top: a.top, width: a.width, height: b.bottom - a.top });
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    expect(state(placer, n)).toBe('placed');
    acc.style.height = '0px';
    const anim = acc.getAnimations()[0]!;
    anim.pause();
    // Stop half way through the middle line of the note, the height going from full to 0 over 4 s.
    const mid = $('l4').getBoundingClientRect();
    const want = (mid.top + mid.bottom) / 2 - acc.getBoundingClientRect().top;
    anim.currentTime = ((full - want) / full) * 4000;
    await settle();
    const box = acc.getBoundingClientRect();
    expect(Math.abs(box.height - want)).toBeLessThan(2);
    const cut = box.bottom;
    const p = painted(layer, n.id)!;
    expect(p.bottom).toBeCloseTo(cut, 0);
    const px = await shot();
    const x = a.left + 2;
    // Above the cut: ink. Below it, where the ink would run on: the page, not ink.
    expect(isInk(px.at(x, cut - 3))).toBe(true);
    expect(isInk(px.at(x, cut + 3))).toBe(false);
    // The text is cut at the same line: none of it shows below the edge in that column either.
    let textBelow = false;
    for (let dx = 0; dx < 40; dx += 2) if (isText(px.at(a.right + 4 + dx, cut + 3))) textBelow = true;
    expect(textBelow).toBe(false);
    // Fully closed: the note hides with the content.
    anim.finish();
    await settle();
    expect(state(placer, n)).toBe('hidden');
    expect(placer.unplaced()).toEqual([]);
    // Open again: the whole note is back.
    acc.style.transition = 'none';
    acc.style.height = `${full}px`;
    await settle();
    expect(state(placer, n)).toBe('placed');
    expect(painted(layer, n.id)!.height).toBeCloseTo(b.bottom - a.top, 0);
  });

  test('a wrapper with overflow hidden that fits its content does not cut a margin note beside it', async () => {
    show(
      '<div id="w" style="overflow:hidden;width:400px;margin-left:200px"><p id="t">A paragraph of olive text inside a clearfix wrapper.</p></div>',
    );
    const t = wordBox($('t'), 'olive');
    // Written in the left margin, outside the wrapper's box.
    const n = noteOver({ left: 120, top: t.top, width: 60, height: 20 });
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    expect(state(placer, n)).toBe('placed');
    // Whole, and still outside the wrapper's box.
    const p = painted(layer, n.id)!;
    expect(p.width).toBeCloseTo(60, 0);
    expect(p.right).toBeLessThan(200);
  });
});

group('tabs, menus, popovers and dialogs', () => {
  test('tab panels shown with display: the note follows its panel', async () => {
    show(
      '<div id="p1" class="tab">First panel kiwi.</div><div id="p2" class="tab on">Second panel lime.</div>',
      '.tab{display:none}.tab.on{display:block}',
    );
    const n = noteOver(wordBox($('p2'), 'lime'));
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    const open = painted(layer, n.id)!;
    $('p2').classList.remove('on');
    $('p1').classList.add('on');
    await settle();
    expect(state(placer, n)).toBe('hidden');
    $('p1').classList.remove('on');
    $('p2').classList.add('on');
    await settle();
    expect(near(painted(layer, n.id), open)).toBe(true);
  });

  test('a dropdown over the page: ink written on it anchors to it, shows above it, and hides when it closes', async () => {
    show(
      `<div style="position:relative"><button id="b">Menu</button>
        <ul id="m" class="menu open"><li id="i1">Plum settings</li><li id="i2">Fig account</li></ul></div>
        <p id="page">Page text sits under the menu with cherry words and more.</p>`,
      '.menu{position:absolute;top:24px;left:0;z-index:50;background:#fff;margin:0;padding:8px;list-style:none;display:none;width:300px}.menu.open{display:block}#page{margin-top:4px}',
    );
    // The menu covers the page text: the pen is on the menu.
    const n = noteOver(wordBox($('i2'), 'Fig'));
    expect(n.anchor.path.css + n.anchor.path.xpath).toMatch(/li/);
    // A box on the menu's padding, not on any text: still the menu, not the page behind it.
    const m = $('m').getBoundingClientRect();
    const pad = noteOver({ left: m.right - 40, top: m.top + 2, width: 30, height: 10 });
    expect(pad.anchor.path.xpath).toMatch(/ul\[1\]/);
    const { placer, layer } = rig();
    placer.setNotes([n, pad]);
    await settle();
    expect(near(painted(layer, n.id), wordBox($('i2'), 'Fig'))).toBe(true);
    // Painted above the menu: the layer is above any z-index the page uses.
    const px = await shot();
    const f = wordBox($('i2'), 'Fig');
    expect(isInk(px.at(f.left + 2, f.top + f.height / 2))).toBe(true);
    $('m').classList.remove('open');
    await settle();
    expect(state(placer, n)).toBe('hidden');
    expect(state(placer, pad)).toBe('hidden');
    expect(painted(layer, n.id)).toBeNull();
    $('m').classList.add('open');
    await settle();
    expect(state(placer, n)).toBe('placed');
  });

  test('a menu shown by opacity: hidden while transparent, and writing on the page under it anchors to the page', async () => {
    show(
      `<div style="position:relative"><ul id="m" class="menu"><li id="i1">Pear options</li></ul>
        <p id="page">Underneath the menu are banana words for the page.</p></div>`,
      '.menu{position:absolute;top:0;left:0;z-index:5;background:#fff;margin:0;padding:0;list-style:none;width:400px;opacity:0;pointer-events:none;transition:opacity .2s}.menu.open{opacity:1;pointer-events:auto}#page{margin:0}',
    );
    // Closed: the pen on "banana" is on the page, not on the transparent menu over it.
    const under = noteOver(wordBox($('page'), 'banana'));
    expect(under.anchor.path.css + under.anchor.path.xpath).toMatch(/page|p\[/);
    // The menu fades over 0.2 s. Its transitionend starts a pass.
    const faded = (o: string) => until(() => getComputedStyle($('m')).opacity === o, `opacity ${o}`);
    $('m').classList.add('open');
    await faded('1');
    const n = noteOver(wordBox($('i1'), 'Pear'));
    expect(n.anchor.path.xpath).toMatch(/li/);
    const { placer, layer } = rig();
    placer.setNotes([n]);
    await settle();
    expect(state(placer, n)).toBe('placed');
    $('m').classList.remove('open');
    await faded('0');
    await settle();
    expect(state(placer, n)).toBe('hidden');
    expect(painted(layer, n.id)).toBeNull();
    $('m').classList.add('open');
    await faded('1');
    await settle();
    expect(state(placer, n)).toBe('placed');
  });

  test('a popover and a dialog: notes hide when they close and return when they open', async () => {
    show(
      '<div id="pop" popover="manual"><p id="pp">Popover papaya text.</p></div><dialog id="dlg"><p id="dp">Dialog guava text.</p></dialog>',
      '#pop{position:fixed;inset:auto;left:40px;top:40px;margin:0}#dlg{position:absolute;left:40px;top:200px;margin:0}',
    );
    ($('pop') as HTMLElement).showPopover();
    ($('dlg') as HTMLDialogElement).show();
    const np = noteOver(wordBox($('pp'), 'papaya'));
    const nd = noteOver(wordBox($('dp'), 'guava'));
    const { placer, layer } = rig();
    placer.setNotes([np, nd]);
    await settle();
    expect(state(placer, np)).toBe('placed');
    expect(state(placer, nd)).toBe('placed');
    const dOpen = painted(layer, nd.id)!;
    ($('pop') as HTMLElement).hidePopover();
    ($('dlg') as HTMLDialogElement).close();
    await settle();
    expect(state(placer, np)).toBe('hidden');
    expect(state(placer, nd)).toBe('hidden');
    ($('dlg') as HTMLDialogElement).show();
    ($('pop') as HTMLElement).showPopover();
    await settle();
    expect(near(painted(layer, nd.id), dOpen)).toBe(true);
    expect(state(placer, np)).toBe('placed');
  });

  test('writing never anchors to content clipped away under the pen', async () => {
    show(
      `<div id="acc" style="overflow:hidden;height:30px"><p id="a1">Visible first line.</p><p id="a2">Clipped hidden pistachio line.</p></div>
       <p id="page">Page pistachio line below.</p>`,
    );
    // The clipped paragraph's box lies under the page paragraph's; the pen is on the page text.
    const n = noteOver(wordBox($('page'), 'pistachio'));
    expect(n.anchor.quote.exact + n.anchor.path.css).not.toMatch(/Clipped|a2/);
  });
});

group('the top layer: modal dialogs and popovers', () => {
  const hosts = () => document.querySelectorAll('ink-layer').length;

  test('a note on a modal dialog is painted above it, takes no input, and its host goes when the dialog closes', async () => {
    show(
      '<p id="under">Page lime words under the dialog.</p><dialog id="dlg"><p id="dp">Dialog guava text.</p><button id="ok">Fine</button></dialog>',
      '#dlg{margin:0;left:40px;top:120px;border:0;padding:12px;width:400px}',
    );
    const { placer } = rig();
    await settle();
    // Pages that never open one have no second host.
    expect(hosts()).toBe(1);
    ($('dlg') as HTMLDialogElement).showModal();
    const n = noteOver(wordBox($('dp'), 'guava'));
    placer.setNotes([n]);
    await settle();
    expect(state(placer, n)).toBe('placed');
    expect(hosts()).toBe(2);
    const top = [...document.querySelectorAll('ink-layer')].find((h) => h.matches(':popover-open'));
    expect(top).toBeTruthy();
    const g = wordBox($('dp'), 'guava');
    expect(isInk((await shot()).at(g.left + 3, g.top + g.height / 2))).toBe(true);
    // Input still reaches the dialog.
    const b = $('ok').getBoundingClientRect();
    expect(document.elementFromPoint(b.left + 4, b.top + 4)).toBe($('ok'));
    ($('dlg') as HTMLDialogElement).close();
    await settle();
    expect(state(placer, n)).toBe('hidden');
    expect(hosts()).toBe(1);
  });

  test('the page popover stays open, and one opened later with notes gets its ink above it', async () => {
    show(
      `<div id="p1" popover><p id="t1">First quince popover.</p></div>
       <div id="p2" popover="manual"><p id="t2">Second melon popover.</p></div>`,
      '#p1,#p2{margin:0;inset:auto;left:20px;top:40px;width:300px;border:0;padding:8px;background:#fff}',
    );
    ($('p1') as HTMLElement).showPopover();
    const n1 = noteOver(wordBox($('t1'), 'quince'));
    const { placer } = rig();
    placer.setNotes([n1]);
    await settle();
    // Showing our own popover never light-dismisses the page's.
    expect($('p1').matches(':popover-open')).toBe(true);
    const q = wordBox($('t1'), 'quince');
    expect(isInk((await shot()).at(q.left + 3, q.top + q.height / 2))).toBe(true);
    // The page opens a second popover over the first, with a note on it.
    ($('p2') as HTMLElement).showPopover();
    const n2 = noteOver(wordBox($('t2'), 'melon'));
    placer.upsert(n2);
    await settle();
    expect($('p1').matches(':popover-open')).toBe(true);
    const m = wordBox($('t2'), 'melon');
    expect(isInk((await shot()).at(m.left + 3, m.top + m.height / 2))).toBe(true);
  });
});

group('clip-path on an ancestor', () => {
  test('inset: ink is cut where the content is cut, and a note on cut-away content hides', async () => {
    show(
      '<div id="c" style="clip-path:inset(0 0 50% 0);width:400px"><p id="a">Top kiwi line.</p><p id="b">Middle date line.</p><p id="c2">Lower lemon line.</p><p id="d">Bottom lime line.</p></div>',
    );
    const top = noteOver(wordBox($('a'), 'kiwi'));
    const low = noteOver(wordBox($('d'), 'lime'));
    // A note over the middle line reaches past the cut.
    const rb = $('b').getBoundingClientRect();
    const rc = $('c2').getBoundingClientRect();
    const across = noteOver({ left: rb.left, top: rb.top + 2, width: 120, height: rc.bottom - rb.top - 4 });
    const { placer, layer } = rig();
    placer.setNotes([top, low, across]);
    await settle();
    expect(state(placer, top)).toBe('placed');
    expect(state(placer, low)).toBe('hidden');
    const box = $('c').getBoundingClientRect();
    const cut = box.top + box.height / 2;
    const p = painted(layer, across.id);
    expect(p).not.toBeNull();
    expect(p!.bottom).toBeLessThanOrEqual(cut + 1);
    $('c').style.clipPath = 'none';
    await settle();
    expect(state(placer, low)).toBe('placed');
  });

  test('circle and ellipse cut to the box around them; other shapes keep ink inside the element', async () => {
    show(
      `<div id="o" style="clip-path:circle(30px at 50% 50%);width:400px;height:200px"><p id="oa">Corner apricot text.</p></div>
       <div id="g" style="clip-path:polygon(0 0,100% 0,50% 100%);width:400px"><p id="ga">Polygon cherry text.</p></div>`,
    );
    const corner = noteOver(wordBox($('oa'), 'apricot'));
    const inPoly = noteOver(wordBox($('ga'), 'cherry'));
    const { placer, layer } = rig();
    placer.setNotes([corner, inPoly]);
    await settle();
    // The words sit in the top left corner, outside the box around the circle: cut away with them.
    expect(state(placer, corner)).toBe('hidden');
    expect(state(placer, inPoly)).toBe('placed');
    const p = painted(layer, inPoly.id)!;
    const g = $('g').getBoundingClientRect();
    expect(p.left).toBeGreaterThanOrEqual(g.left - 1);
    expect(p.right).toBeLessThanOrEqual(g.right + 1);
  });

  test('a shape as large as its element cuts nothing beside it', async () => {
    show(
      '<div id="w" style="clip-path:inset(0);width:300px;margin-left:100px"><p id="wa">Wrapped plum text.</p></div>',
    );
    const r = wordBox($('wa'), 'plum');
    const w = $('w').getBoundingClientRect();
    const margin = noteOver({ left: w.right + 20, top: r.top, width: 40, height: r.height });
    const { placer, layer } = rig();
    placer.setNotes([margin]);
    await settle();
    expect(state(placer, margin)).toBe('placed');
    expect(painted(layer, margin.id)).not.toBeNull();
  });
});

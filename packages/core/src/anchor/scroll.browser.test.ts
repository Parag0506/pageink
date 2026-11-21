import { afterEach, expect, test } from 'vitest';
import type { AnchorContext } from '../types';
import { describe } from './describe';
import { createResolver } from './resolve';
import { dropModel } from './text';

const ctx = (): AnchorContext => ({ doc: document });

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
  document.body.removeAttribute('style');
  dropModel(document);
});

function page(): HTMLElement {
  const ps = Array.from(
    { length: 40 },
    (_, i) => `<p id="p${i}">Paragraph ${i} has words that say ${'something more '.repeat(6)}here.</p>`,
  ).join('');
  document.body.innerHTML = `<main>${ps}</main>`;
  return document.getElementById('p20')!;
}

function boxOn(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + scrollX + 2, y: r.top + scrollY + 2, w: 60, h: 14 };
}

test('a <body> that scrolls by itself counts as an inner scroller in describe and resolve', () => {
  document.documentElement.style.cssText = 'height:100%;overflow:hidden';
  document.body.style.cssText = 'height:100%;margin:0;overflow:auto';
  const p = page();
  document.body.scrollTop = p.offsetTop - 100;
  expect(window.scrollY).toBe(0);
  const d = describe(ctx(), boxOn(p));
  expect(d.anchor.scroller?.css).toBe('body');
  const r = createResolver(ctx()).resolve(d.anchor, d.frame)!;
  expect(r.scroller).toBe(document.body);
  expect(r.origin.y).toBeCloseTo(d.origin.y, 0);
});

test('a <body> whose overflow passes to the window is not a scroller', () => {
  document.body.style.cssText = 'overflow:auto;margin:0';
  const p = page();
  const d = describe(ctx(), boxOn(p));
  expect(d.anchor.scroller).toBeUndefined();
  expect(createResolver(ctx()).resolve(d.anchor, d.frame)!.scroller).toBeUndefined();
});

test('font size includes CSS zoom, so scale follows zoomed text', () => {
  const p = page();
  const d = describe(ctx(), boxOn(p));
  document.documentElement.style.zoom = '2';
  dropModel(document);
  const r = createResolver(ctx()).resolve(d.anchor, d.frame)!;
  expect(r.scale).toBeCloseTo(2, 2);
});

import { afterEach, expect, test } from 'vitest';
import type { AnchorContext } from '../types';
import { pathOf, resolvePath } from './path';
import { dropModel, getModel, TextModel } from './text';

const ctx = (extra: Partial<AnchorContext> = {}): AnchorContext => ({ doc: document, ...extra });

afterEach(() => {
  dropModel(document);
  document.body.innerHTML = '';
});

test('folds white space and separates blocks', () => {
  document.body.innerHTML =
    '<p>  Hello\n\n   <b>bold</b>   world </p><p>Next<br>line</p><div>a</div><div>b</div>';
  const m = new TextModel(ctx());
  expect(m.text.trim()).toBe('Hello bold world Next line a b');
});

test('skips script, style, noscript, template, hidden content and our layer', () => {
  // Shown, so they are skipped by kind, not only because the browser hides them.
  document.body.innerHTML = `
    <style>script,style,noscript{display:block}</style>
    <p>keep one</p><script>var x = "no";</script><style>p{}</style><noscript>no</noscript>
    <template><p>no</p></template><p hidden>no</p><p style="display:none">no</p>
    <div style="display:none"><p>no</p></div><ink-layer><p>no</p></ink-layer>
    <div style="display:contents"><p>keep two</p></div>`;
  const m = new TextModel(ctx({ isOurs: (el) => el.localName === 'ink-layer' }));
  expect(m.text.trim()).toBe('keep one keep two');
});

test('walks open roots directly and closed roots through the accessor, in slot order', () => {
  document.body.innerHTML =
    '<p>before</p><x-open><span>slotted</span></x-open><x-closed></x-closed><p>after</p>';
  const open = document.querySelector('x-open')!.attachShadow({ mode: 'open' });
  open.innerHTML = '<p>open start</p><slot></slot><p>open end</p>';
  const host = document.querySelector('x-closed')!;
  const closed = host.attachShadow({ mode: 'closed' });
  closed.innerHTML = '<p>closed inside</p>';
  const without = new TextModel(ctx());
  expect(without.text.trim()).toBe('before open start slotted open end after');
  const withAccess = new TextModel(ctx({ shadowRootOf: (el) => (el === host ? closed : null) }));
  expect(withAccess.text.trim()).toBe('before open start slotted open end closed inside after');
});

test('model offsets map to DOM ranges and back', () => {
  document.body.innerHTML = '<p>  alpha   beta\n gamma  </p><p><i>delta</i> epsilon</p>';
  const m = new TextModel(ctx());
  const i = m.text.indexOf('beta gamma');
  const r = m.range(i, i + 'beta gamma'.length)!;
  expect(r.toString().replace(/\s+/g, ' ')).toBe('beta gamma');
  expect(m.offsetOf(r.startContainer, r.startOffset)).toBe(i);
  expect(m.offsetOf(r.endContainer, r.endOffset)).toBe(i + 'beta gamma'.length);
  const j = m.text.indexOf('delta epsilon');
  expect(m.range(j, j + 13)!.toString()).toBe('delta epsilon');
});

test('element spans and blocks', () => {
  document.body.innerHTML =
    '<div id="d"><p id="a">one two</p><p id="b">three <a href="#x">four</a></p></div>';
  const m = new TextModel(ctx());
  const span = m.spanOf(document.getElementById('d')!)!;
  expect(m.text.slice(span.start, span.end).trim()).toBe('one two three four');
  expect(m.blockAt(m.text.indexOf('four'))).toBe(document.getElementById('b'));
  expect(m.blockList.map((e) => e.id)).toEqual(['a', 'b']);
});

test('the cache is shared until dropped, and stale nodes are noticed', () => {
  document.body.innerHTML = '<p>first text</p>';
  const c = ctx();
  const a = getModel(c);
  expect(getModel(c)).toBe(a);
  expect(a.fresh(0, 5)).toBe(true);
  document.querySelector('p')!.firstChild!.textContent = 'changed text here';
  expect(a.fresh(0, 5)).toBe(false);
  dropModel(document);
  expect(getModel(c)).not.toBe(a);
});

test('paths prefer stable ids, survive id changes through the positional path, and cross shadow roots', () => {
  document.body.innerHTML =
    '<main id="content"><section><p>a</p><p id="x-9f3a2b7c">b</p></section></main><x-host></x-host>';
  const p = document.querySelectorAll('p')[1]!;
  const path = pathOf(p);
  expect(path.id).toBeUndefined();
  expect(path.css).toBe('#content > section:nth-of-type(1) > p:nth-of-type(2)');
  expect(path.xpath).toBe('/html[1]/body[1]/main[1]/section[1]/p[2]');
  expect([...resolvePath(ctx(), path)][0]).toBe(p);
  document.querySelector('main')!.id = 'renamed';
  expect([...resolvePath(ctx(), path)]).toEqual([p]);

  const host = document.querySelector('x-host')!;
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<div><span>in</span><span>side</span></div>';
  const inner = root.querySelectorAll('span')[1]!;
  const ip = pathOf(inner);
  expect(ip.css).toContain(' >>> ');
  expect([...resolvePath(ctx(), ip)]).toEqual([]);
  expect([...resolvePath(ctx({ shadowRootOf: () => root }), ip)][0]).toBe(inner);
});

const messy = `
  <article><h1>Title  here</h1><p>One <b>bold</b> line<br>and   more.</p>
  <section><h2>Part</h2><p hidden>gone</p><p style="visibility:hidden">quiet <span style="visibility:visible">back</span></p>
  <ul><li>first</li><li>second <i>item</i></li></ul><table><tr><td>cell a</td><td>cell b</td></tr></table>
  <figure><img alt="x"><figcaption>A caption</figcaption></figure><div style="display:contents"><p>inside contents</p></div>
  <p>last   words</p></section><p>tail</p></article>`;

test('a model built in slices equals one built at once', () => {
  document.body.innerHTML = messy.repeat(30);
  const whole = new TextModel(ctx());
  const sliced = new TextModel(ctx(), { lazy: true });
  let slices = 0;
  // A deadline already past stops the walk at its first check, so each slice is small.
  while (!sliced.step(0)) slices++;
  expect(slices).toBeGreaterThan(5);
  expect(sliced.text).toBe(whole.text);
  expect(sliced.segs.map((s) => [s.start, s.len, s.node.data])).toEqual(
    whole.segs.map((s) => [s.start, s.len, s.node.data]),
  );
  expect([...sliced.blocks.entries()]).toEqual([...whole.blocks.entries()]);
  expect(sliced.media.map((m) => [m.el, m.at])).toEqual(whole.media.map((m) => [m.el, m.at]));
});

test('buildModel finishes the document text over several slices and getModel finishes it at once', async () => {
  const { buildModel, hasModel } = await import('./text');
  document.body.innerHTML = messy.repeat(200);
  const c = ctx();
  let n = 0;
  while (!buildModel(c, 0)) n++;
  expect(n).toBeGreaterThan(0);
  expect(hasModel(c)).toBe(true);
  const done = getModel(c);
  dropModel(document);
  expect(hasModel(c)).toBe(false);
  buildModel(c, 0);
  // A partial build is completed, not restarted, when the full text is needed now.
  expect(getModel(c).text).toBe(done.text);
});

test('a local model of a block, or of a run of sibling blocks, has the full text of those nodes', () => {
  document.body.innerHTML = messy.repeat(3);
  const full = new TextModel(ctx());
  for (const el of Array.from(
    document.querySelectorAll('article, section, p, li, ul, table, figure, h1, h2'),
  )) {
    const span = full.spanOf(el);
    if (!span || !full.blocks.has(el)) continue;
    const vis = (el as Element & { checkVisibility(o: object): boolean }).checkVisibility({
      visibilityProperty: true,
    });
    const local = new TextModel(ctx(), { root: { el, shown: vis } });
    expect(local.text).toBe(full.text.slice(span.start, span.end));
  }
  // A run from one block child to a later sibling.
  const sec = document.querySelector('section')!;
  const kids = Array.from(sec.childNodes);
  const from = kids.indexOf(sec.querySelector('ul')!);
  const nodes = kids.slice(from);
  const run = new TextModel(ctx(), { root: { el: sec, shown: true, nodes } });
  const a = full.spanOf(sec.querySelector('ul')!)!;
  expect(run.text).toBe(full.text.slice(a.start, a.start + run.text.length));
  expect(run.blocks.has(sec)).toBe(false);
});

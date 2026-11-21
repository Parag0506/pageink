import { afterEach, expect, test, vi } from 'vitest';
import { NEEDED, startGuarded, TOO_OLD } from './guard';

/** The parts of the viewer page the guard touches. */
function page(): Document {
  const doc = document.implementation.createHTMLDocument('viewer');
  doc.body.innerHTML = `
    <header id="bar"></header>
    <section id="empty" hidden><h1>Open a PDF</h1><button data-open>Open file</button></section>
    <p id="status">Opening</p>`;
  doc.documentElement.classList.add('loading');
  return doc;
}

/** A window in a frame on a PDF address, with a parent that records messages. */
function framed(hash: string) {
  const sent: [unknown, string][] = [];
  const parent = { postMessage: (m: unknown, o: string) => sent.push([m, o]) };
  const win = { location: { hash }, parent } as unknown as Window;
  return { win, sent };
}

/** A global with every needed built-in. */
function current(): object {
  const g: Record<string, unknown> = {};
  for (const path of NEEDED) {
    const parts = path.split('.');
    let o = g;
    for (const k of parts.slice(0, -1)) {
      o[k] ??= {};
      o = o[k] as Record<string, unknown>;
    }
    o[parts.at(-1)!] = () => undefined;
  }
  return g;
}

afterEach(() => vi.restoreAllMocks());

test('starts the viewer when PDF.js loads on a browser that has what it needs', async () => {
  const doc = page();
  const { win, sent } = framed('#src=https%3A%2F%2Fexample.org%2Fa.pdf');
  const start = vi.fn();
  expect(await startGuarded({ doc, win, global: current(), load: async () => 'app', start })).toBe(true);
  expect(start).toHaveBeenCalledWith('app');
  expect(doc.getElementById('too-old')).toBeNull();
  expect(sent).toEqual([]);
});

test('a chunk that fails to load shows the message and gives the PDF back to the browser', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const doc = page();
  const { win, sent } = framed('#src=https%3A%2F%2Fexample.org%2Fa.pdf');
  const start = vi.fn();
  const load = () => Promise.reject(new SyntaxError('Unexpected token'));
  expect(await startGuarded({ doc, win, global: current(), load, start })).toBe(false);
  expect(start).not.toHaveBeenCalled();
  expect(doc.getElementById('too-old')?.textContent).toBe(TOO_OLD);
  expect(doc.getElementById('empty')?.hidden).toBe(false);
  expect(doc.querySelector('[data-open]')).toBeNull();
  expect(doc.getElementById('bar')?.hidden).toBe(true);
  expect(doc.documentElement.classList.contains('loading')).toBe(false);
  expect(sent).toEqual([[{ ink: 'pdf-unsupported' }, 'https://example.org']]);
});

test('missing built-ins or a throw at start show the message too', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const start = vi.fn();
  const doc = page();
  const { win } = framed('');
  expect(await startGuarded({ doc, win, global: {}, load: async () => 'app', start })).toBe(false);
  expect(start).not.toHaveBeenCalled();
  expect(doc.getElementById('too-old')?.textContent).toBe(TOO_OLD);

  const doc2 = page();
  const boom = () => {
    throw new TypeError('x.getOrInsertComputed is not a function');
  };
  expect(
    await startGuarded({ doc: doc2, win, global: current(), load: async () => 'app', start: boom }),
  ).toBe(false);
  expect(doc2.getElementById('too-old')?.textContent).toBe(TOO_OLD);
});

test('a page opened on its own tells no one', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const doc = page();
  const sent: unknown[] = [];
  const win = { location: { hash: '' } } as unknown as Window & { parent: unknown };
  win.parent = win;
  (win as unknown as { postMessage: (m: unknown) => void }).postMessage = (m) => sent.push(m);
  await startGuarded({ doc, win, global: {}, load: async () => 0, start: () => undefined });
  expect(sent).toEqual([]);
});

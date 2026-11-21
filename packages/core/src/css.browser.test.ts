import { afterEach, describe, expect, test } from 'vitest';
import { addSheet, rootOf, setDecls } from './css';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

function shadow(): ShadowRoot {
  const host = document.createElement('div');
  document.body.append(host);
  cleanups.push(() => host.remove());
  return host.attachShadow({ mode: 'closed' });
}

describe('addSheet', () => {
  test('adopts a sheet on a shadow root, replaces its rules and removes it', () => {
    const root = shadow();
    const p = document.createElement('p');
    root.append(p);
    const s = addSheet(root, 'p{color:rgb(1, 2, 3)}');
    expect(s.adopted).toBe(true);
    expect(root.querySelector('style')).toBeNull();
    expect(getComputedStyle(p).color).toBe('rgb(1, 2, 3)');
    s.set('p{color:rgb(4, 5, 6)}');
    expect(getComputedStyle(p).color).toBe('rgb(4, 5, 6)');
    s.remove();
    expect(root.adoptedStyleSheets.length).toBe(0);
  });

  test('works on a document too', () => {
    const before = document.adoptedStyleSheets.length;
    const s = addSheet(document, '.css-test-x{color:red}');
    expect(document.adoptedStyleSheets.length).toBe(before + 1);
    s.remove();
    expect(document.adoptedStyleSheets.length).toBe(before);
  });

  test('falls back to a style element where adoption is refused', () => {
    const root = shadow();
    // Only this root refuses, the way some content script worlds do.
    Object.defineProperty(root, 'adoptedStyleSheets', { configurable: true, get: () => [], set: () => {} });
    {
      const p = document.createElement('p');
      const mount = document.createElement('div');
      root.append(mount, p);
      const s = addSheet(root, 'p{color:rgb(7, 8, 9)}', mount);
      expect(s.adopted).toBe(false);
      expect(mount.querySelector('style')?.textContent).toBe('p{color:rgb(7, 8, 9)}');
      expect(getComputedStyle(p).color).toBe('rgb(7, 8, 9)');
      s.set('p{color:rgb(1, 1, 1)}');
      expect(getComputedStyle(p).color).toBe('rgb(1, 1, 1)');
      s.remove();
      expect(mount.querySelector('style')).toBeNull();
    }
  });
});

describe('rootOf', () => {
  test('names the shadow root or the document a node lives in', () => {
    const root = shadow();
    const inner = document.createElement('span');
    root.append(inner);
    expect(rootOf(inner)).toBe(root);
    expect(rootOf(document.body)).toBe(document);
    // A detached node falls back to its document.
    expect(rootOf(document.createElement('div'))).toBe(document);
  });
});

describe('setDecls', () => {
  test('writes declarations through the CSSOM, with their priority', () => {
    const el = document.createElement('div');
    setDecls(el, ['position: absolute !important', 'left: 3px', 'bad']);
    expect(el.style.getPropertyValue('position')).toBe('absolute');
    expect(el.style.getPropertyPriority('position')).toBe('important');
    expect(el.style.getPropertyValue('left')).toBe('3px');
    expect(el.style.getPropertyPriority('left')).toBe('');
  });
});

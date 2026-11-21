import { expect, test } from 'vitest';
import { icon, iconNode } from './icons';

test('iconNode builds the same SVG as the markup, without innerHTML', () => {
  for (const name of ['draw', 'lasso', 'tray', 'nothing-by-this-name']) {
    const t = document.createElement('template');
    t.innerHTML = icon(name);
    const want = t.content.firstElementChild as SVGSVGElement;
    const got = iconNode(document, name);
    expect(got.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(got.outerHTML.replace(/\s+/g, ' ')).toBe(want.outerHTML.replace(/\s+/g, ' '));
  }
});

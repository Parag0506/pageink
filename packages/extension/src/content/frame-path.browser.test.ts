import { expect, test } from 'vitest';
import { pathOf } from './frame-path';

test('pathOf gives a CSS path and an XPath that find the element again', () => {
  document.body.innerHTML = '<div><iframe></iframe><p></p><iframe id="f2"></iframe></div>';
  const el = document.querySelectorAll('iframe')[1]!;
  const p = pathOf(el);
  expect(p.id).toBe('f2');
  expect(document.querySelector(p.css)).toBe(el);
  const x = document.evaluate(p.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
  expect(x.singleNodeValue).toBe(el);
  const first = pathOf(document.querySelector('iframe')!);
  expect(first.id).toBeUndefined();
  expect(document.querySelector(first.css)).toBe(document.querySelector('iframe'));
});

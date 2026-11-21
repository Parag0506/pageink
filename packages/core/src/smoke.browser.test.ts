import { expect, test } from 'vitest';

test('browser project runs in a real page', () => {
  const el = document.createElement('ink-layer');
  const root = el.attachShadow({ mode: 'closed' });
  document.documentElement.append(el);
  expect(root.host).toBe(el);
  expect(el.getBoundingClientRect().width).toBeGreaterThanOrEqual(0);
  el.remove();
});

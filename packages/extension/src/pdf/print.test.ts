import { expect, test } from 'vitest';
import { pageRules } from './print';

test('one named sheet per page size, and every page is given its sheet', () => {
  const css = pageRules([
    { w: 612, h: 792 },
    { w: 842, h: 595.276 },
    { w: 612, h: 792 },
  ]);
  expect(css).toContain('@page { size: 612pt 792pt; margin: 0; }');
  expect(css).toContain('@page ink-sheet-0 { size: 612pt 792pt; margin: 0; }');
  expect(css).toContain('@page ink-sheet-1 { size: 842pt 595.28pt; margin: 0; }');
  expect(css).toContain('#ink-pdf-page-1, #ink-pdf-page-3 { page: ink-sheet-0; }');
  expect(css).toContain('#ink-pdf-page-2 { page: ink-sheet-1; }');
});

test('an empty document still gets a sheet size', () => {
  expect(pageRules([])).toContain('@page { size: 612pt 792pt; margin: 0; }');
});

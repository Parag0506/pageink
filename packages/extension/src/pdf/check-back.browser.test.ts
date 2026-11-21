/**
 * Diagnostics builds only: the way back from the PDF viewer to the device check (check-back.ts).
 * The origin is given here; a release build never calls it, and test/diag.test.ts checks that
 * its words are in none of the builds that ship.
 */
import { expect, test } from 'vitest';
import { showCheckBack } from './check-back';

const ORIGIN = 'http://192.168.1.20:8790';

function bar(): { doc: Document; bar: HTMLElement } {
  const doc = document.implementation.createHTMLDocument('viewer');
  doc.body.innerHTML = `<header id="bar"><img class="mark" alt=""><div class="title-box"></div><button data-open>Open file</button></header>`;
  return { doc, bar: doc.getElementById('bar')! };
}

test('opened from the check page, the viewer shows a link back to its PDF step', () => {
  const b = bar();
  const a = showCheckBack(b.doc, b.bar, '?from=check', ORIGIN);
  expect(a?.textContent).toBe('Back to the Pencil check');
  expect(a?.getAttribute('href')).toBe(`${ORIGIN}/s/pdf`);
  // Right after the mark, so it stays in view on a narrow screen.
  expect(b.bar.children[1]).toBe(a);
});

test('opened any other way, or without a check origin, it shows nothing', () => {
  for (const [search, origin] of [
    ['', ORIGIN],
    ['?from=elsewhere', ORIGIN],
    ['?from=check', ''],
  ] as const) {
    const b = bar();
    expect(showCheckBack(b.doc, b.bar, search, origin)).toBeNull();
    expect(b.bar.querySelector('a')).toBeNull();
  }
});

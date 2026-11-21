/**
 * Diagnostics builds only (content/diag.ts). The PDF viewer is called with this only behind
 * `if (__INK_DIAG__)`, so every other build leaves it out, and test/diag.test.ts checks that.
 *
 * The device check sends the person to the viewer to write on a PDF. Safari on iPad may offer
 * no tab or back arrow that leads back, so the viewer shows a button that does.
 */

/**
 * Puts a "Back to the Pencil check" link at the start of the bar when the viewer was opened
 * from the check page. It goes to the check page's PDF step.
 */
export function showCheckBack(
  doc: Document,
  bar: HTMLElement,
  search: string,
  origin: string = __INK_DIAG_ORIGIN__,
): HTMLAnchorElement | null {
  // The check page opens the viewer at pdf.html?from=check.
  if (!origin || new URLSearchParams(search).get('from') !== 'check') return null;
  const a = doc.createElement('a');
  a.id = 'check-back';
  a.href = `${origin}/s/pdf`;
  a.target = '_top';
  a.textContent = 'Back to the Pencil check';
  // Inline, so the viewer's style sheet in every other build stays as it is.
  a.style.cssText =
    'flex:none;padding:8px 14px;border-radius:8px;background:#0a64d8;color:#fff;' +
    'font:600 15px/1.2 system-ui,sans-serif;text-decoration:none;white-space:nowrap';
  const mark = bar.querySelector('.mark');
  if (mark) mark.after(a);
  else bar.prepend(a);
  return a;
}

/**
 * Print is the PDF export (CONTRACT 6). The page list is laid out at 100%
 * with no gaps and no centring, so its layout on screen is the same as on
 * paper, and each sheet takes the size of its own PDF page. The ink layer
 * prints with the page at the same positions, so each sheet shows the PDF
 * page with its ink. Afterwards the viewer goes back to how it was.
 *
 * The bar's Print and Ctrl+P draw every page at a print resolution first.
 * Print from the browser's menu gives no time for that: the browser prints
 * right after the beforeprint event. That path lays the pages out the same
 * way and copies the pages already drawn on screen.
 */
import { pageId } from './geometry';
import type { PdfView } from './view';

export const PRINT_DPI = 150;

export interface PrintDeps {
  doc: Document;
  view: PdfView;
  /** The browser's own print. */
  print: () => void;
  /** Progress text for the reader, empty to clear. */
  status?(text: string): void;
}

const frames = (win: Window, n: number) =>
  new Promise<void>((r) => {
    const step = (k: number) => (k <= 0 ? r() : win.requestAnimationFrame(() => step(k - 1)));
    step(n);
  });

/**
 * One named page per distinct page size, so each sheet is the size of its PDF page.
 * Sizes are in PDF points, which CSS calls pt.
 */
export function pageRules(sizes: { w: number; h: number }[]): string {
  const names = new Map<string, number[]>();
  sizes.forEach((s, i) => {
    const k = `${+s.w.toFixed(2)}pt ${+s.h.toFixed(2)}pt`;
    const list = names.get(k) ?? [];
    list.push(i + 1);
    names.set(k, list);
  });
  const first = sizes[0] ?? { w: 612, h: 792 };
  // Without a sheet size, the browser picks paper and scales the pages to it.
  let css = `@page { size: ${+first.w.toFixed(2)}pt ${+first.h.toFixed(2)}pt; margin: 0; }\n`;
  let i = 0;
  for (const [size, pages] of names) {
    const name = `ink-sheet-${i++}`;
    css += `@page ${name} { size: ${size}; margin: 0; }\n`;
    css += `${pages.map((n) => `#${pageId(n)}`).join(', ')} { page: ${name}; }\n`;
  }
  return css;
}

/** Lay the viewer out for print. Synchronous. Returns the function that undoes it. */
function layOut(doc: Document, view: PdfView): () => void {
  const root = doc.documentElement;
  const zoom = view.zoom();
  const mode = view.mode();
  const page = view.current();
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(pageRules(view.sizes));
  const before = doc.adoptedStyleSheets;
  doc.adoptedStyleSheets = [...before, sheet];
  root.classList.add('printing');
  view.setZoom(1);
  return () => {
    for (const el of doc.querySelectorAll('.print-page')) el.remove();
    doc.adoptedStyleSheets = doc.adoptedStyleSheets.filter((s) => s !== sheet);
    root.classList.remove('printing');
    if (mode === 'custom') view.setZoom(zoom);
    else view.setMode(mode);
    view.goTo(page);
  };
}

let running = false;
let undo: (() => void) | null = null;

export async function printWithInk(d: PrintDeps): Promise<void> {
  if (running) return;
  running = true;
  const { doc, view } = d;
  const win = doc.defaultView ?? window;
  const urls: string[] = [];
  const back = layOut(doc, view);

  const restore = () => {
    win.removeEventListener('afterprint', restore);
    back();
    for (const u of urls) URL.revokeObjectURL(u);
    d.status?.('');
    running = false;
  };

  try {
    for (let n = 1; n <= view.count; n++) {
      d.status?.(`Preparing page ${n} of ${view.count} for print`);
      const blob = await view.pageImage(n, PRINT_DPI);
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const img = doc.createElement('img');
      img.className = 'print-page';
      img.alt = '';
      img.src = url;
      await img.decode().catch(() => {});
      view.pageEl(n)?.append(img);
    }
    d.status?.('');
    // The ink moves with the new layout through its observers. Give it a few frames.
    await frames(win, 4);
    await new Promise((r) => win.setTimeout(r, 150));
    win.addEventListener('afterprint', restore);
    d.print();
  } catch {
    restore();
  }
}

/**
 * Print from the browser's menu. beforeprint lays the pages out as the bar's
 * Print does and copies each drawn page into its sheet; afterprint undoes it.
 * Prints started by printWithInk are already prepared and pass through.
 */
export function watchMenuPrint(doc: Document, view: () => PdfView | null): () => void {
  const win = doc.defaultView ?? window;
  const before = () => {
    const v = view();
    if (running || undo || !v) return;
    undo = layOut(doc, v);
    for (let n = 1; n <= v.count; n++) {
      const el = v.pageEl(n);
      const shown = el?.querySelector<HTMLCanvasElement>('canvas.pc');
      if (!el || !shown?.width) continue;
      const copy = doc.createElement('canvas');
      copy.className = 'print-page';
      copy.width = shown.width;
      copy.height = shown.height;
      copy.getContext('2d')?.drawImage(shown, 0, 0);
      el.append(copy);
    }
  };
  const after = () => {
    const u = undo;
    undo = null;
    u?.();
  };
  win.addEventListener('beforeprint', before);
  win.addEventListener('afterprint', after);
  return () => {
    win.removeEventListener('beforeprint', before);
    win.removeEventListener('afterprint', after);
    after();
  };
}

/** True while the viewer is laid out for print. */
export const printing = (doc: Document): boolean => doc.documentElement.classList.contains('printing');

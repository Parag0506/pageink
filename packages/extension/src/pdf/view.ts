/**
 * The page list of the PDF viewer. Every page has a container sized to the
 * page at the current zoom from the start, marked as an ink media surface, so
 * ink is anchored to the page and scaled by its width (DESIGN 7.5). Canvases
 * are drawn near the viewport and dropped far from it; the containers keep
 * their size, so nothing on the page moves. Text layers stay once built: they
 * are cheap, they let the reader select text, and text marks hold on to them.
 * Zoom changes one CSS variable for the text layers, so their nodes survive.
 */
import { type PDFDocumentProxy, type PDFPageProxy, type RenderTask, TextLayer } from 'pdfjs-dist';
import {
  autoZoom,
  CSS_PER_PT,
  canvasScale,
  clampZoom,
  fitWidth,
  type Layout,
  layout,
  type PageSize,
  pageAt,
  pageId,
  pointAt,
  yOf,
} from './geometry';

export type ZoomMode = 'auto' | 'fit' | 'custom';

export interface PdfViewOptions {
  doc: Document;
  /** The page list element. It holds only the page containers. */
  list: HTMLElement;
  pdf: PDFDocumentProxy;
  /** Height covered by the bar at the top, CSS px. */
  inset(): number;
  /** The page in view changed. Pages count from 1. */
  onPage?(n: number): void;
  onZoom?(zoom: number, mode: ZoomMode): void;
}

export interface PdfView {
  count: number;
  sizes: PageSize[];
  zoom(): number;
  mode(): ZoomMode;
  layout(): Layout;
  /** Set the zoom and keep the point under `at` (client px) where it is. */
  setZoom(z: number, at?: { x: number; y: number }): void;
  setMode(m: 'auto' | 'fit'): void;
  current(): number;
  /** Scroll page n to the top of the view. frac is a point down the page, 0 to 1. */
  goTo(n: number, frac?: number): void;
  /** Container of page n, counting from 1. */
  pageEl(n: number): HTMLElement | undefined;
  /** Build text layers for these pages now, rendered or not. */
  ensureText(pages: number[]): Promise<void>;
  /** The page as a PNG at a print resolution. */
  pageImage(n: number, dpi: number): Promise<Blob>;
  /** Lay out again for the current window size. */
  resized(): void;
  /** Wait until the pages in view are drawn. */
  idle(): Promise<void>;
  destroy(): void;
}

interface Slot {
  n: number;
  el: HTMLDivElement;
  page: PDFPageProxy;
  size: PageSize;
  canvas: HTMLCanvasElement | null;
  /** Zoom the canvas was drawn at. */
  drawn: number;
  task: RenderTask | null;
  text: Promise<void> | null;
  textLayer: TextLayer | null;
  links: Promise<void> | null;
  near: boolean;
}

/** One link from a page's annotations. Areas are fractions of the page box. */
export interface PageLink {
  x: number;
  y: number;
  w: number;
  h: number;
  /** A web or mail address. */
  url?: string;
  /** A place in this document. */
  to?: { page: number; frac: number };
}

/** Only these open in a new tab. Anything else in a PDF is not followed. */
const SAFE_URL = /^(https?:|mailto:)/i;

type Dest = [unknown, { name?: string } | undefined, ...unknown[]];

/** Page number and height on that page for a PDF destination. */
async function resolveDest(
  pdf: PDFDocumentProxy,
  dest: unknown,
  heightOf: (page: number) => number,
): Promise<{ page: number; frac: number } | null> {
  const arr = (typeof dest === 'string' ? await pdf.getDestination(dest) : dest) as Dest | null;
  if (!Array.isArray(arr) || !arr.length) return null;
  const ref = arr[0];
  const index =
    typeof ref === 'number'
      ? ref
      : ref && typeof ref === 'object'
        ? await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0])
        : -1;
  if (!(index >= 0 && index < pdf.numPages)) return null;
  const page = index + 1;
  // XYZ and FitH name the top of the view in page units from the bottom.
  const kind = arr[1]?.name;
  const top = kind === 'XYZ' ? arr[3] : kind === 'FitH' || kind === 'FitBH' ? arr[2] : null;
  const h = heightOf(page);
  const frac = typeof top === 'number' && h > 0 ? Math.min(1, Math.max(0, (h - top) / h)) : 0;
  return { page, frac };
}

/** Link annotations of a page, as areas relative to the page box. Other annotations are left out. */
export async function pageLinks(
  pdf: PDFDocumentProxy,
  page: PDFPageProxy,
  /** Page height in points, by page number. */
  heightOf: (n: number) => number,
): Promise<PageLink[]> {
  const vp = page.getViewport({ scale: 1 });
  const anns = (await page.getAnnotations({ intent: 'display' })) as {
    subtype?: string;
    rect?: number[];
    url?: string;
    dest?: unknown;
  }[];
  const out: PageLink[] = [];
  for (const a of anns) {
    if (a.subtype !== 'Link' || !a.rect || a.rect.length !== 4) continue;
    const [x1, y1] = vp.convertToViewportPoint(a.rect[0]!, a.rect[1]!) as number[];
    const [x2, y2] = vp.convertToViewportPoint(a.rect[2]!, a.rect[3]!) as number[];
    const box = {
      x: Math.min(x1!, x2!) / vp.width,
      y: Math.min(y1!, y2!) / vp.height,
      w: Math.abs(x2! - x1!) / vp.width,
      h: Math.abs(y2! - y1!) / vp.height,
    };
    if (box.w <= 0 || box.h <= 0) continue;
    if (a.url && SAFE_URL.test(a.url)) out.push({ ...box, url: a.url });
    else if (a.dest) {
      const to = await resolveDest(pdf, a.dest, heightOf);
      if (to) out.push({ ...box, to });
    }
  }
  return out;
}

/** Draw pages within this margin of the viewport, drop canvases outside the second. */
const RENDER_MARGIN = '100% 0px';
const KEEP_MARGIN = '300% 0px';

export async function createPdfView(o: PdfViewOptions): Promise<PdfView> {
  const { doc, list, pdf } = o;
  const win = doc.defaultView ?? window;
  const count = pdf.numPages;

  // Page sizes up front, so every container has its real size before any ink is placed.
  const pages = await Promise.all(Array.from({ length: count }, (_, i) => pdf.getPage(i + 1)));
  const sizes: PageSize[] = pages.map((p) => {
    const v = p.getViewport({ scale: 1 });
    return { w: v.width, h: v.height };
  });

  let mode: ZoomMode = 'auto';
  // The list is as wide as its widest page, so the view width comes from the document.
  const viewW = () => doc.documentElement.clientWidth || win.innerWidth;
  let zoom = autoZoom(sizes, viewW());
  let lay = layout(sizes, zoom);
  let destroyed = false;

  const slots: Slot[] = pages.map((page, i) => {
    const el = doc.createElement('div');
    const n = i + 1;
    el.className = 'page';
    el.id = pageId(n);
    el.dataset.inkMedia = pageId(n);
    el.dataset.page = String(n);
    el.setAttribute('role', 'group');
    // The media anchor keeps this as its label, and the Markdown export shows it in place of a quote.
    el.setAttribute('aria-label', `Page ${n}`);
    return {
      n,
      el,
      page,
      size: sizes[i]!,
      canvas: null,
      drawn: 0,
      task: null,
      text: null,
      textLayer: null,
      links: null,
      near: false,
    };
  });

  const cssScale = (s: Slot) => zoom * CSS_PER_PT * (s.page.userUnit || 1);

  /** All writes in one pass. */
  const applySizes = () => {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      s.el.style.width = `${lay.widths[i]}px`;
      s.el.style.height = `${lay.heights[i]}px`;
      s.el.style.setProperty('--total-scale-factor', String(cssScale(s)));
    }
  };
  applySizes();
  list.replaceChildren(...slots.map((s) => s.el));

  // ---- rendering --------------------------------------------------------------

  let busy = false;
  let idleWaiters: (() => void)[] = [];

  const listTop = () => list.getBoundingClientRect().top + win.scrollY;

  /** Next page to draw: the nearest page to the middle of the view that needs it. */
  const nextSlot = (): Slot | null => {
    const mid = win.scrollY + win.innerHeight / 2 - listTop();
    let best: Slot | null = null;
    let bd = Number.POSITIVE_INFINITY;
    for (const s of slots) {
      if (!s.near || (s.canvas && s.drawn === zoom)) continue;
      const i = s.n - 1;
      const d = Math.abs(lay.tops[i]! + lay.heights[i]! / 2 - mid);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  };

  const pump = async (): Promise<void> => {
    if (busy || destroyed) return;
    const s = nextSlot();
    if (!s) {
      const w = idleWaiters;
      idleWaiters = [];
      for (const f of w) f();
      return;
    }
    busy = true;
    try {
      await draw(s);
    } catch {
      // A cancelled or failed page stays blank. The next pass tries again if still needed.
    }
    busy = false;
    void pump();
  };

  async function draw(s: Slot): Promise<void> {
    const z = zoom;
    const vp = s.page.getViewport({ scale: z * CSS_PER_PT });
    const i = s.n - 1;
    const w = lay.widths[i]!;
    const h = lay.heights[i]!;
    const k = canvasScale(w, h, win.devicePixelRatio || 1);
    const c = doc.createElement('canvas');
    c.className = 'pc';
    c.width = Math.max(1, Math.floor(w * k));
    c.height = Math.max(1, Math.floor(h * k));
    const sx = c.width / vp.width;
    const sy = c.height / vp.height;
    const task = s.page.render({ canvas: c, viewport: vp, transform: [sx, 0, 0, sy, 0, 0] });
    s.task = task;
    if (!s.text) s.text = buildText(s);
    if (!s.links) s.links = buildLinks(s);
    await task.promise;
    s.task = null;
    if (destroyed || !s.near || zoom !== z) {
      c.width = 0;
      return;
    }
    // Swap in one write. The old canvas, stretched by CSS, stayed until now.
    if (s.canvas) {
      s.canvas.replaceWith(c);
      s.canvas.width = 0;
    } else s.el.prepend(c);
    s.canvas = c;
    s.drawn = z;
  }

  function buildText(s: Slot): Promise<void> {
    const box = doc.createElement('div');
    box.className = 'textLayer';
    const tl = new TextLayer({
      textContentSource: s.page.streamTextContent({ includeMarkedContent: false }),
      container: box,
      viewport: s.page.getViewport({ scale: zoom * CSS_PER_PT }),
    });
    s.textLayer = tl;
    return tl.render().then(
      () => {
        if (!destroyed) s.el.append(box);
      },
      () => {
        // A page without text still takes ink.
      },
    );
  }

  /**
   * Links as plain anchors over the page. Web addresses open in a new tab and
   * are never read by the extension. Links inside the document scroll to their page.
   */
  function buildLinks(s: Slot): Promise<void> {
    return pageLinks(pdf, s.page, (n) => sizes[n - 1]?.h ?? 0).then(
      (links) => {
        if (destroyed || !links.length) return;
        const box = doc.createElement('div');
        box.className = 'linkLayer';
        for (const l of links) {
          const a = doc.createElement('a');
          a.style.setProperty('left', `${l.x * 100}%`);
          a.style.setProperty('top', `${l.y * 100}%`);
          a.style.setProperty('width', `${l.w * 100}%`);
          a.style.setProperty('height', `${l.h * 100}%`);
          if (l.url) {
            a.href = l.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = l.url;
          } else if (l.to) {
            const to = l.to;
            a.href = `#${pageId(to.page)}`;
            a.title = `Page ${to.page}`;
            a.addEventListener('click', (e) => {
              e.preventDefault();
              goTo(to.page, to.frac);
            });
          }
          box.append(a);
        }
        s.el.append(box);
      },
      () => {
        // A page whose annotations cannot be read has no links.
      },
    );
  }

  const release = (s: Slot) => {
    s.task?.cancel();
    s.task = null;
    if (s.canvas) {
      s.canvas.remove();
      s.canvas.width = 0;
      s.canvas = null;
    }
    s.drawn = 0;
    s.page.cleanup();
  };

  const bySlot = new Map<Element, Slot>(slots.map((s) => [s.el, s]));
  const near = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const s = bySlot.get(e.target);
        if (s && e.isIntersecting) s.near = true;
      }
      void pump();
    },
    { rootMargin: RENDER_MARGIN },
  );
  const keep = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const s = bySlot.get(e.target);
        if (s && !e.isIntersecting) {
          s.near = false;
          release(s);
        }
      }
    },
    { rootMargin: KEEP_MARGIN },
  );
  for (const s of slots) {
    near.observe(s.el);
    keep.observe(s.el);
  }

  // ---- page in view --------------------------------------------------------------

  let shown = 0;
  let frame = 0;
  const current = (): number => {
    const y = win.scrollY + o.inset() + 8 - listTop();
    return pageAt(lay, y) + 1;
  };
  const report = () => {
    frame = 0;
    const n = current();
    if (n !== shown) {
      shown = n;
      o.onPage?.(n);
    }
  };
  const onScroll = () => {
    if (!frame) frame = win.requestAnimationFrame(report);
  };
  win.addEventListener('scroll', onScroll, { passive: true });
  report();

  function goTo(n: number, frac = 0): void {
    const i = Math.min(count, Math.max(1, Math.round(n))) - 1;
    const pad = frac > 0 ? 0 : 8;
    win.scrollTo(win.scrollX, lay.tops[i]! + frac * lay.heights[i]! + listTop() - o.inset() - pad);
  }

  // ---- zoom --------------------------------------------------------------------------

  function setZoom(z: number, at?: { x: number; y: number }, m: ZoomMode = 'custom'): void {
    const nz = clampZoom(z);
    mode = m;
    if (Math.abs(nz - zoom) < 1e-4) {
      o.onZoom?.(zoom, mode);
      return;
    }
    // Reads first.
    const top = listTop();
    const cx = at?.x ?? win.innerWidth / 2;
    const cy = at?.y ?? o.inset() + (win.innerHeight - o.inset()) / 2;
    const pt = pointAt(lay, win.scrollY + cy - top);
    const docW = Math.max(1, doc.documentElement.scrollWidth);
    const fx = (win.scrollX + cx) / docW;
    // Then writes.
    zoom = nz;
    lay = layout(sizes, zoom);
    applySizes();
    for (const s of slots)
      s.textLayer?.update({ viewport: s.page.getViewport({ scale: zoom * CSS_PER_PT }) });
    const newW = doc.documentElement.scrollWidth;
    win.scrollTo(Math.max(0, fx * newW - cx), Math.max(0, yOf(lay, pt.page, pt.frac) + top - cy));
    o.onZoom?.(zoom, mode);
    void pump();
  }

  const fitFor = (m: 'auto' | 'fit') => {
    const w = viewW();
    return m === 'auto' ? autoZoom(sizes, w) : fitWidth(sizes, w);
  };

  return {
    count,
    sizes,
    zoom: () => zoom,
    mode: () => mode,
    layout: () => lay,
    setZoom: (z, at) => setZoom(z, at, 'custom'),
    setMode: (m) => setZoom(fitFor(m), undefined, m),
    current,
    goTo,
    pageEl: (n) => slots[n - 1]?.el,
    async ensureText(nums) {
      await Promise.all(
        nums
          .map((n) => slots[n - 1])
          .filter((s): s is Slot => !!s)
          .map((s) => {
            s.text ??= buildText(s);
            return s.text;
          }),
      );
    },
    async pageImage(n, dpi) {
      const s = slots[n - 1];
      if (!s) throw new Error(`no page ${n}`);
      const vp = s.page.getViewport({ scale: dpi / 72 });
      const c = doc.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      await s.page.render({ canvas: c, viewport: vp, intent: 'print' }).promise;
      const blob = await new Promise<Blob>((ok, no) =>
        c.toBlob((b) => (b ? ok(b) : no(new Error('page image failed'))), 'image/png'),
      );
      c.width = 0;
      return blob;
    },
    resized() {
      if (mode !== 'custom') setZoom(fitFor(mode), undefined, mode);
    },
    idle() {
      if (!busy && !nextSlot()) return Promise.resolve();
      return new Promise((r) => {
        idleWaiters.push(r);
        void pump();
      });
    },
    destroy() {
      destroyed = true;
      near.disconnect();
      keep.disconnect();
      win.removeEventListener('scroll', onScroll);
      if (frame) win.cancelAnimationFrame(frame);
      for (const s of slots) {
        release(s);
        s.textLayer?.cancel();
      }
      for (const f of idleWaiters) f();
      idleWaiters = [];
      list.replaceChildren();
    },
  };
}

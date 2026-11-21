/**
 * The PDF viewer page. It opens a PDF handed over by the content script on a
 * PDF address, or a file the reader picks or drops, shows it with PDF.js and
 * runs the ink viewer over it with a fixed identity (DESIGN 7.5, 7.6).
 */
// First, so the stand-ins are in place before PDF.js runs.
import './compat';
import { createStore } from 'pageink-core/store';
import type { HostHooks, KV, PageIdentity, Viewer } from 'pageink-core/types';
import { createViewer } from 'pageink-core/view';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { localKV } from '../adapters/kv';
import type { Api } from '../api';
import { probeFor } from '../content/diag';
import type { ToBackground } from '../messages';
import { showCheckBack } from './check-back';
import { pageOfAnchor, stepZoom } from './geometry';
import { bytesFrom, type FromViewer, originOf, sourceOf } from './handoff';
import { arxivHtml, fileTitle, pdfIdentity } from './identity';
import { openPdf } from './pdfjs';
import { printWithInk, watchMenuPrint } from './print';
import { createPdfView, type PdfView } from './view';

export interface AppDeps {
  api: Api;
  doc?: Document;
  /** KV for the notes. Default: extension storage. */
  kv?: KV;
}

export interface PdfApp {
  /** Open PDF bytes. url is the web address they came from, when there is one. */
  open(bytes: ArrayBuffer, src: { url?: string; name?: string }): Promise<void>;
  identity(): PageIdentity | null;
  view(): PdfView | null;
  viewer(): Viewer | null;
}

const $ = <T extends HTMLElement>(doc: Document, id: string) => doc.getElementById(id) as T;

export function startApp(deps: AppDeps): PdfApp {
  const { api } = deps;
  const doc = deps.doc ?? document;
  const win = (doc.defaultView ?? window) as Window & typeof globalThis;
  const kv = deps.kv ?? localKV(api);
  const store = createStore(kv);

  const bar = $<HTMLElement>(doc, 'bar');
  const list = $<HTMLElement>(doc, 'pages');
  const empty = $<HTMLElement>(doc, 'empty');
  const title = $<HTMLElement>(doc, 'title');
  const htmlLink = $<HTMLAnchorElement>(doc, 'html-version');
  const pageInput = $<HTMLInputElement>(doc, 'page');
  const pageCount = $<HTMLElement>(doc, 'count');
  const zoomLabel = $<HTMLElement>(doc, 'zoom');
  const fileInput = $<HTMLInputElement>(doc, 'file');
  const status = $<HTMLElement>(doc, 'status');

  let pdf: PDFDocumentProxy | null = null;
  let view: PdfView | null = null;
  let viewer: Viewer | null = null;
  let id: PageIdentity | null = null;
  let generation = 0;

  const framed = win.parent !== win;
  const src = sourceOf(win.location.hash);
  const toParent = (m: FromViewer) => {
    const o = src ? originOf(src) : null;
    if (framed && o) win.parent.postMessage(m, o);
  };

  // The device check opened this viewer: a sure way back to it. Diagnostics builds only.
  if (__INK_DIAG__) showCheckBack(doc, bar, win.location.search);

  // The bar sits in the top layer, above the ink, so ink never draws over it.
  try {
    bar.showPopover();
  } catch {
    // Older browsers: the bar stays a fixed element in the page.
  }
  const inset = () => bar.getBoundingClientRect().bottom;

  const say = (t: string) => {
    status.textContent = t;
    status.hidden = !t;
  };

  const setBusy = (on: boolean) => doc.documentElement.classList.toggle('loading', on);

  // ---- open --------------------------------------------------------------------

  async function open(bytes: ArrayBuffer, from: { url?: string; name?: string }): Promise<void> {
    const gen = ++generation;
    close();
    setBusy(true);
    say('');
    try {
      const doc0 = await openPdf(bytes);
      if (gen !== generation) {
        void doc0.loadingTask.destroy();
        return;
      }
      pdf = doc0;
      const meta = await pdf.getMetadata().catch(() => null);
      const metaTitle = (meta?.info as { Title?: unknown } | undefined)?.Title;
      const name =
        (typeof metaTitle === 'string' && metaTitle.trim()) ||
        from.name ||
        (from.url ? fileTitle(from.url) : 'PDF');
      id = pdfIdentity({ url: from.url, fingerprint: pdf.fingerprints[0] ?? '' });
      doc.title = name;
      title.textContent = name;
      title.title = from.url ?? from.name ?? name;
      toParent({ ink: 'pdf-title', title: name });
      const html = from.url ? arxivHtml(from.url) : null;
      htmlLink.hidden = !html;
      if (html) htmlLink.href = html;

      empty.hidden = true;
      view = await createPdfView({
        doc,
        list,
        pdf,
        inset,
        onPage: (n) => {
          if (doc.activeElement !== pageInput) pageInput.value = String(n);
        },
        onZoom: (z) => {
          zoomLabel.textContent = `${Math.round(z * 100)}%`;
        },
      });
      zoomLabel.textContent = `${Math.round(view.zoom() * 100)}%`;
      pageCount.textContent = `of ${view.count}`;
      pageInput.max = String(view.count);
      pageInput.value = String(view.current());
      doc.documentElement.classList.add('has-doc');

      // Text marks hold on to the text layer, so their pages get one before the ink is placed.
      const rec = await store.load(id).catch(() => null);
      const textPages = new Set<number>();
      for (const n of rec?.notes ?? []) {
        if (n.kind !== 'textmark') continue;
        const p = pageOfAnchor(n.anchor);
        if (p) textPages.add(p);
      }
      await view.ensureText([...textPages]);
      if (gen !== generation) return;

      const hooks: HostHooks = {
        captureVisible: () =>
          (
            api.runtime.sendMessage({ ink: 'capture' } satisfies ToBackground) as Promise<string | undefined>
          ).catch(() => undefined),
        ...(__INK_DIAG__ ? { probe: probeFor(api, 'pdf') } : {}),
      };
      viewer = await createViewer({
        doc,
        kv,
        identity: id,
        hooks,
        // A stroke must start on a page. The gaps and the bar scroll and click as usual.
        ignore: (el) => !el.closest('.page'),
        // The off switch is for sites. PDFs have their own setting.
        hideSiteOff: true,
        // Pages are white paper in both themes, so the ink uses its light colours.
        config: { theme: 'light' },
        // The bar matches the viewer's own chrome, which follows the reader's setting.
        uiTheme: 'auto',
      });
      if (gen !== generation) {
        viewer.destroy();
        return;
      }
      // The ink bar is part of this page, so the tools load now.
      await viewer.tools();
    } catch (e) {
      if (gen !== generation) return;
      close();
      empty.hidden = false;
      say(`This file could not be opened as a PDF. ${e instanceof Error ? e.message : ''}`.trim());
      toParent({ ink: 'pdf-failed' });
    } finally {
      if (gen === generation) setBusy(false);
    }
  }

  function close(): void {
    viewer?.destroy();
    viewer = null;
    view?.destroy();
    view = null;
    void pdf?.loadingTask.destroy();
    pdf = null;
    id = null;
    doc.documentElement.classList.remove('has-doc');
    htmlLink.hidden = true;
  }

  // ---- files -------------------------------------------------------------------

  const openFile = async (f: File) => {
    const name = f.name.replace(/\.pdf$/i, '');
    await open(await f.arrayBuffer(), { name });
  };
  for (const b of doc.querySelectorAll<HTMLButtonElement>('[data-open]'))
    b.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void openFile(f);
  });
  const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
  win.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    doc.documentElement.classList.add('dropping');
  });
  win.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) doc.documentElement.classList.remove('dropping');
  });
  win.addEventListener('drop', (e) => {
    doc.documentElement.classList.remove('dropping');
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const f = [...(e.dataTransfer?.files ?? [])].find(
      (x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name),
    );
    if (f) void openFile(f);
    else say('Drop a PDF file.');
  });

  // ---- bar ------------------------------------------------------------------------

  const zoomBy = (dir: 1 | -1) => view?.setZoom(stepZoom(view.zoom(), dir));
  $<HTMLButtonElement>(doc, 'zoom-in').addEventListener('click', () => zoomBy(1));
  $<HTMLButtonElement>(doc, 'zoom-out').addEventListener('click', () => zoomBy(-1));
  $<HTMLButtonElement>(doc, 'fit').addEventListener('click', () => view?.setMode('fit'));
  $<HTMLButtonElement>(doc, 'prev').addEventListener('click', () => view?.goTo(view.current() - 1));
  $<HTMLButtonElement>(doc, 'next').addEventListener('click', () => view?.goTo(view.current() + 1));
  const jump = () => {
    const n = Number(pageInput.value);
    if (view && Number.isFinite(n)) view.goTo(n);
  };
  pageInput.addEventListener('change', jump);
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      jump();
      pageInput.blur();
    }
  });

  // ---- keys, wheel and resize --------------------------------------------------------

  win.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      win.print();
      return;
    }
    if (mod && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      fileInput.click();
      return;
    }
    if (!view) return;
    if (mod && (e.key === '+' || e.key === '=')) {
      e.preventDefault();
      zoomBy(1);
    } else if (mod && (e.key === '-' || e.key === '_')) {
      e.preventDefault();
      zoomBy(-1);
    } else if (mod && e.key === '0') {
      e.preventDefault();
      view.setMode('fit');
    } else if (mod || e.altKey) {
      return;
    } else if ((e.target as Element | null)?.closest?.('input, select, textarea')) {
      return;
    } else if (e.key === 'PageDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      view.goTo(view.current() + 1);
    } else if (e.key === 'PageUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      view.goTo(view.current() - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      view.goTo(1);
    } else if (e.key === 'End') {
      e.preventDefault();
      view.goTo(view.count);
    }
  });

  // A pinch on a trackpad arrives as a wheel with Control. Zoom around the pointer.
  let wheelZoom = 1;
  let wheelAt = { x: 0, y: 0 };
  let wheelFrame = 0;
  win.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || !view) return;
      e.preventDefault();
      wheelZoom *= Math.exp(-e.deltaY / 300);
      wheelAt = { x: e.clientX, y: e.clientY };
      if (!wheelFrame)
        wheelFrame = win.requestAnimationFrame(() => {
          wheelFrame = 0;
          if (view) view.setZoom(view.zoom() * wheelZoom, wheelAt);
          wheelZoom = 1;
        });
    },
    { passive: false },
  );

  let resizeTimer = 0;
  win.addEventListener('resize', () => {
    win.clearTimeout(resizeTimer);
    resizeTimer = win.setTimeout(() => view?.resized(), 100);
  });

  // ---- print -------------------------------------------------------------------------

  // The ink bar and the keyboard both call window.print. Pages are drawn first.
  const nativePrint = win.print.bind(win);
  win.print = () => {
    if (!view) return nativePrint();
    void printWithInk({ doc, view, print: nativePrint, status: say });
  };
  // Print from the browser's menu lays the pages out the same way.
  watchMenuPrint(doc, () => view);

  // ---- hand-off from the content script --------------------------------------------------

  if (src && framed) {
    say('Opening…');
    win.addEventListener('message', (e) => {
      const bytes = bytesFrom(e, win.parent, src);
      if (bytes) void open(bytes, { url: src });
    });
    toParent({ ink: 'pdf-ready' });
  }

  return {
    open,
    identity: () => id,
    view: () => view,
    viewer: () => viewer,
  };
}

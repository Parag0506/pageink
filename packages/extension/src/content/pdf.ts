/**
 * The PDF chunk. The stub loads it in the top frame of a document whose type
 * is application/pdf. It reads the same address once more (served from the
 * cache), swaps the built-in viewer for a full-size frame of the extension's
 * viewer page and hands the bytes over (CONTRACT 6). The address bar keeps
 * the PDF address, so reload and history work as before.
 * When the reader turned this off, or the read fails, the built-in viewer
 * stays and a small button offers the extension's viewer.
 */
import type { Api } from '../api';
import { NAME } from '../brand';
import { type CfgWithPdf, pdfOn } from '../pdf/cfg';
import { fromViewer, looksLikePdf, type ToViewer, viewerAddress } from '../pdf/handoff';

export interface PdfStart {
  api: Api;
  cfg?: CfgWithPdf;
}

/** The viewer must say it is ready within this long, or the built-in viewer comes back. */
const READY_MS = 15_000;

let started = false;

export function start({ api, cfg }: PdfStart): void {
  if (started) return;
  started = true;
  const go = () => (pdfOn(cfg) ? void take(api) : offer(`Open with ${NAME}`, () => take(api)));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
  else go();
}

/** The one network read in the product: this same address again. */
async function read(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { cache: 'force-cache', credentials: 'include' });
  if (!res.ok) throw new Error(`read failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (!looksLikePdf(buf)) throw new Error('not a PDF');
  return buf;
}

async function take(api: Api): Promise<void> {
  removeOffer();
  const url = location.href;
  let bytes: ArrayBuffer;
  try {
    bytes = await read(url);
  } catch {
    // Local files and some servers refuse a second read. The viewer page can still open the file.
    offer(`Open in ${NAME}`, () => {
      window.open(api.runtime.getURL('/pdf.html'), '_blank', 'noopener');
    });
    return;
  }
  mount(api, url, bytes);
}

function mount(api: Api, url: string, bytes: ArrayBuffer): void {
  const doc = document;
  const extOrigin = new URL(api.runtime.getURL('/')).origin;
  const old = doc.body;
  const oldTitle = doc.title;
  const frame = doc.createElement('iframe');
  frame.src = viewerAddress(api.runtime.getURL('/pdf.html'), url);
  frame.title = `${NAME} PDF viewer`;
  frame.allow = 'clipboard-write; fullscreen';
  Object.assign(frame.style, {
    position: 'fixed',
    inset: '0',
    width: '100%',
    height: '100%',
    border: '0',
    margin: '0',
    display: 'block',
  });
  const body = doc.createElement('body');
  Object.assign(body.style, { margin: '0', overflow: 'hidden', background: '#525659' });
  body.append(frame);

  let pending: ArrayBuffer | null = bytes;
  /** Puts the built-in viewer back. The offer is left out when the viewer cannot run here at all. */
  const restore = (again = true) => {
    removeEventListener('message', onMsg);
    clearTimeout(timer);
    if (body.isConnected && old) body.replaceWith(old);
    doc.title = oldTitle;
    if (!again) return;
    offer(`Open in ${NAME}`, () => {
      window.open(api.runtime.getURL('/pdf.html'), '_blank', 'noopener');
    });
  };
  const onMsg = (e: MessageEvent) => {
    const m = fromViewer(e, frame.contentWindow, extOrigin);
    if (!m) return;
    if (m.ink === 'pdf-ready') {
      clearTimeout(timer);
      if (!pending || !frame.contentWindow) return;
      const msg: ToViewer = { ink: 'pdf-bytes', url, bytes: pending };
      frame.contentWindow.postMessage(msg, extOrigin, [pending]);
      pending = null;
      frame.focus();
    } else if (m.ink === 'pdf-title') {
      if (m.title) doc.title = m.title;
    } else restore(m.ink !== 'pdf-unsupported');
  };
  addEventListener('message', onMsg);
  const timer = setTimeout(() => restore(), READY_MS);
  if (old) old.replaceWith(body);
  else doc.documentElement.append(body);
}

let button: HTMLElement | null = null;

function removeOffer(): void {
  button?.remove();
  button = null;
}

/** A small button in the corner, in its own shadow root so page styles do not reach it. */
function offer(label: string, act: () => void): void {
  removeOffer();
  const host = document.createElement('ink-pdf-offer');
  const root = host.attachShadow({ mode: 'open' });
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  Object.assign(b.style, {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: '2147483647',
    font: '13px/1.2 system-ui, sans-serif',
    padding: '8px 12px',
    borderRadius: '8px',
    border: '1px solid rgba(0,0,0,.2)',
    background: '#ffffff',
    color: '#1d1d1f',
    boxShadow: '0 2px 8px rgba(0,0,0,.25)',
    cursor: 'pointer',
    opacity: '0.92',
  });
  b.addEventListener('click', () => {
    removeOffer();
    act();
  });
  root.append(b);
  document.documentElement.append(host);
  button = host;
}

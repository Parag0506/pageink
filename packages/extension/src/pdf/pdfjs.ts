/**
 * PDF.js set up for an extension page that may not use the network.
 * The worker, the cmaps, the standard fonts and the image decoders are files
 * in the extension (build/pdfjs.ts). The page cannot fetch them, even from
 * itself, because its policy is connect-src 'none', so the data files are
 * small modules that it imports.
 */
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist';

const ROOT = '/pdf/';
const SAFE_NAME = /^[\w.+-]+\.(?:bcmap|pfb)$/;

function fromBase64(s: string): Uint8Array {
  const from = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64;
  if (from) return from(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hands the worker cmaps and fonts by import. PDF.js calls this method `fetch`;
 * the build renames that method to inkReadObj (build/pdfjs.ts), so this class
 * uses the new name.
 */
export class BundledData {
  async inkReadObj({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const dir = kind === 'cMapUrl' ? 'cmaps' : kind === 'standardFontDataUrl' ? 'fonts' : null;
    if (!dir || !SAFE_NAME.test(filename)) throw new Error(`No bundled data for ${kind} ${filename}`);
    const mod = (await import(/* @vite-ignore */ `${ROOT}${dir}/${filename}.js`)) as { default: string };
    return fromBase64(mod.default);
  }
}

let worker: Worker | null = null;

function ensureWorker(): void {
  if (worker) return;
  worker = new Worker(`${ROOT}worker.js`, { type: 'module' });
  GlobalWorkerOptions.workerPort = worker;
}

/** Open a PDF from its bytes. The buffer is handed to the worker and becomes empty here. */
export function openPdf(bytes: ArrayBuffer | Uint8Array): Promise<PDFDocumentProxy> {
  ensureWorker();
  const base = new URL(ROOT, location.href).href;
  const task = getDocument({
    data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}fonts/`,
    wasmUrl: `${base}wasm/`,
    useWorkerFetch: false,
    // The page policy has no wasm-unsafe-eval. The worker uses the plain script decoders.
    useWasm: false,
    BinaryDataFactory: BundledData,
    isOffscreenCanvasSupported: true,
    enableXfa: false,
  });
  return task.promise;
}

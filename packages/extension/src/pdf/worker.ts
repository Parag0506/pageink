/**
 * The PDF.js worker. build/pdfjs.ts builds it into pdf/worker.js and points
 * the import at the PDF.js build the target ships. The stand-ins load first.
 */
import './compat';

// @ts-expect-error The worker build has no type declarations. Nothing here reads its exports.
export * from 'pdfjs-dist/build/pdf.worker.mjs';

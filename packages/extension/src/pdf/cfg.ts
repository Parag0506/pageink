/**
 * The PDF setting. It lives in the shared `cfg` record as an optional field
 * next to InkConfig, so older builds and other devices keep it untouched.
 */
import type { InkConfig } from 'pageink-core/types';

export interface PdfCfg {
  /** False: PDFs stay in the browser's own viewer with a button to open them in the extension's viewer. Default true. */
  pdf?: boolean;
}

export type CfgWithPdf = Partial<InkConfig> & PdfCfg;

/** True unless the reader turned "Open PDFs with ink" off. */
export const pdfOn = (cfg: CfgWithPdf | undefined): boolean => cfg?.pdf !== false;

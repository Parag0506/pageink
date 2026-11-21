import type { SvgToPng } from '../types';

/** Rasterise a stand-alone SVG through an image and a canvas. Nothing leaves the page. */
export const svgToPng: SvgToPng = async (svg, w, h, scale = 1) => {
  const doc = globalThis.document;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The SVG could not be read as an image.'));
      img.src = url;
    });
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas.');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed.'))), 'image/png');
    });
  } finally {
    URL.revokeObjectURL(url);
  }
};

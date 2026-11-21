import type { InkColor, StrokeTool, Theme } from '../types';

export interface Palette {
  'ink-1': string;
  'ink-2': string;
  'hi-1': string;
  'hi-2': string;
  lead: string;
  sel: string;
  badgeBg: string;
  badgeFg: string;
  /** How highlighter ink mixes with the page so text stays readable. */
  blend: 'multiply' | 'screen';
}

export const PALETTES: Record<Theme, Palette> = {
  light: {
    'ink-1': '#1f2a44',
    'ink-2': '#d03a2f',
    'hi-1': '#ffe14d',
    'hi-2': '#8fe3a1',
    lead: '#8a8f98',
    sel: '#9a5530',
    badgeBg: '#2f241c',
    badgeFg: '#ffffff',
    blend: 'multiply',
  },
  dark: {
    'ink-1': '#e8ecf4',
    'ink-2': '#ff8a7a',
    'hi-1': '#8c7a00',
    'hi-2': '#1f7a3c',
    lead: '#9aa3b2',
    sel: '#e0a77b',
    badgeBg: '#f3ebdd',
    badgeFg: '#2f241c',
    blend: 'screen',
  },
};

const SEMANTIC = new Set(['ink-1', 'ink-2', 'hi-1', 'hi-2']);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Real colour for a stored colour. Only semantic names and hex colours are
 * accepted, because the value comes from synced storage and must never carry
 * a url() or other CSS into the page.
 */
export function realColor(theme: Theme, c: InkColor, tool: StrokeTool): string {
  const p = PALETTES[theme];
  if (SEMANTIC.has(c)) return p[c as 'ink-1'];
  if (HEX.test(c)) return c;
  return tool === 'hi' ? p['hi-1'] : p['ink-1'];
}

/** CSS value used inside the layer, so a theme switch needs no repaint by script. */
export function varColor(c: InkColor, tool: StrokeTool): string {
  if (SEMANTIC.has(c)) return `var(--c-${c})`;
  if (HEX.test(c)) return c;
  return tool === 'hi' ? 'var(--c-hi-1)' : 'var(--c-ink-1)';
}

export function themeVars(t: Theme): Record<string, string> {
  const p = PALETTES[t];
  return {
    '--c-ink-1': p['ink-1'],
    '--c-ink-2': p['ink-2'],
    '--c-hi-1': p['hi-1'],
    '--c-hi-2': p['hi-2'],
    '--c-lead': p.lead,
    '--c-sel': p.sel,
    '--c-badge-bg': p.badgeBg,
    '--c-badge-fg': p.badgeFg,
    '--hi-blend': p.blend,
  };
}

/** Parse a computed colour into sRGB and alpha. Null when it is not rgb(). */
export function parseRgb(s: string): [number, number, number, number] | null {
  const m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (!m) return null;
  let a = 1;
  if (m[4] !== undefined) a = m[4].endsWith('%') ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

/** Any CSS colour to sRGB through a 1 px canvas, for oklch() and friends. */
function viaCanvas(doc: Document, s: string): [number, number, number, number] | null {
  const c = doc.createElement('canvas');
  c.width = 1;
  c.height = 1;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.fillStyle = s;
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
}

export function luminance(r: number, g: number, b: number): number {
  const ch = (v: number): number => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

/**
 * Theme of the page as the reader sees it: the first opaque background of
 * body or html, then the page's color-scheme, then the system preference.
 */
export function detectTheme(doc: Document): Theme {
  const win = doc.defaultView;
  if (!win) return 'light';
  for (const el of [doc.body, doc.documentElement]) {
    if (!el) continue;
    const bg = win.getComputedStyle(el).backgroundColor;
    const rgb = parseRgb(bg) ?? viaCanvas(doc, bg);
    if (rgb && rgb[3] > 0.5) return luminance(rgb[0], rgb[1], rgb[2]) < 0.2 ? 'dark' : 'light';
  }
  const scheme = win.getComputedStyle(doc.documentElement).colorScheme || '';
  if (!/dark/.test(scheme)) return 'light';
  if (!/light/.test(scheme)) return 'dark';
  return win.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Inline icons on a 24 unit grid, drawn with the current text colour.
// Dots are zero length lines with round caps, which keeps the paths short.
const P: Record<string, string> = {
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  draw: 'M4 20l1.2-4.6L15.6 5a2.1 2.1 0 0 1 3 0l.4.4a2.1 2.1 0 0 1 0 3L8.6 18.8zM13.5 7l3.5 3.5',
  hi: 'M15.5 3.5l5 5-8.5 8.5-5-5zM7 12l-2.5 5 2.5 2.5 5-2.5',
  eraser: 'M8 20h12M4.6 15.4l9.8-9.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 19H8.2zM9 11l5 5',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  tray: 'M3 13h5l1.5 2.5h5L16 13h5M5.5 5h13L21 13v6H3v-6z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'M6 6l12 12M18 6L6 18',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9h.01',
  doc: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  chat: 'M4 5h16v11H9l-5 4z',
  print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  power: 'M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0',
  join: 'M9 7a5 5 0 1 0 0 10M15 7a5 5 0 1 1 0 10M8 12h8',
  split: 'M12 3v18M8 8l-4 4 4 4M16 8l4 4-4 4',
  done: 'M5 12.5l4.5 4.5L19 7.5',
};

const LASSO =
  '<path d="M12 4c4.6 0 8 2.4 8 5.5S16.6 15 12 15s-8-2.4-8-5.5S7.4 4 12 4z" stroke-dasharray="2.6 2.8"/><path d="M8 14.2c-1.4 1.8-.6 4.4 2 5.3"/>';

export const icon = (name: string): string =>
  `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${
    name === 'lasso' ? LASSO : `<path d="${P[name] ?? ''}"/>`
  }</svg>`;

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The same icon built as nodes. Store linters reject markup written through
 * innerHTML, even when it is a constant, so the bar uses this.
 */
export function iconNode(doc: Document, name: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = (d: string, dash?: string) => {
    const p = doc.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    if (dash) p.setAttribute('stroke-dasharray', dash);
    svg.append(p);
  };
  if (name === 'lasso') {
    path('M12 4c4.6 0 8 2.4 8 5.5S16.6 15 12 15s-8-2.4-8-5.5S7.4 4 12 4z', '2.6 2.8');
    path('M8 14.2c-1.4 1.8-.6 4.4 2 5.3');
  } else path(P[name] ?? '');
  return svg;
}

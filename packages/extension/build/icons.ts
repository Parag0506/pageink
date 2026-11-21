/**
 * The extension's icons, in one place. scripts/icons.mjs renders them from brand/, the
 * manifest names them, and the tests check that each file exists at its stated size.
 */
import type { Target } from './targets.ts';

/** Manifest icons. WXT finds icons/<size>.png in public/ and lists them. */
export const ICONS: Record<number, string> = {
  16: 'icons/16.png',
  32: 'icons/32.png',
  48: 'icons/48.png',
  128: 'icons/128.png',
};

/** A toolbar icon file. The name keeps WXT from listing it as a manifest icon. */
export const TOOLBAR = (size: number): string => `icons/toolbar-${size}.png`;

/** Chrome and Edge ask for 16, 24 and 32. Safari draws 19 point toolbar items, so 19 and 38. */
const SIZES: Record<Exclude<Target, 'firefox'>, number[]> = {
  chrome: [16, 24, 32],
  edge: [16, 24, 32],
  safari: [16, 19, 32, 38],
};

/** Every toolbar PNG size the script renders. */
export const TOOLBAR_SIZES = [...new Set(Object.values(SIZES).flat())].sort((a, b) => a - b);

/** The small mark as SVG. Firefox draws an SVG toolbar icon sharp at any scale. */
export const TOOLBAR_SVG = 'icons/mark-small.svg';

/** The toolbar icon map for the manifest's action.default_icon. */
export function toolbarIcons(t: Target): Record<string, string> {
  if (t === 'firefox') return { 16: TOOLBAR_SVG, 32: TOOLBAR_SVG };
  return Object.fromEntries(SIZES[t].map((s) => [String(s), TOOLBAR(s)]));
}

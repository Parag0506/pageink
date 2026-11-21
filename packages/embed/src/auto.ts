import type { InkHandle, MountOptions } from './mount';
import { mount } from './mount';

const bool = (v: string | null): boolean | undefined =>
  v === null ? undefined : v === '' || v === 'true' || v === '1';

/** Options from a script tag's data attributes. */
export function optionsFrom(el: Element): MountOptions {
  const o: MountOptions = {};
  const a = (n: string) => el.getAttribute(`data-${n}`);
  const store = a('store');
  if (store === 'local' || store === 'indexeddb') o.store = store;
  const page = a('page');
  if (page) o.page = page;
  const pen = bool(a('pen-only'));
  if (pen !== undefined) o.penOnly = pen;
  const needs = bool(a('pen-needs-toggle'));
  if (needs !== undefined) o.penNeedsToggle = needs;
  const theme = a('theme');
  if (theme === 'light' || theme === 'dark' || theme === 'auto') o.theme = theme;
  const mod = a('modifier');
  if (mod === 'Alt' || mod === 'Control' || mod === 'Meta' || mod === 'none') o.modifier = mod;
  const hide = Number(a('bar-hide-ms'));
  if (a('bar-hide-ms') !== null && Number.isFinite(hide) && hide >= 0) o.barHideMs = hide;
  const tools = a('tools');
  if (tools === 'lazy' || tools === 'eager') o.tools = tools;
  const legacy = a('legacy');
  if (legacy) o.legacy = legacy;
  const handle = bool(a('handle'));
  if (handle !== undefined) o.handle = handle;
  return o;
}

/** Mounts when the running script tag carries data-ink. */
export function autoMount(script: Element | null): InkHandle | null {
  if (!script?.hasAttribute('data-ink')) return null;
  return mount(optionsFrom(script));
}

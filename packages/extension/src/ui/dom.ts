/** Tiny DOM helpers for the extension pages. No framework. */

type Props = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** Save a file through a download link. */
export function saveFile(name: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function say(text: string): void {
  const s = document.getElementById('status');
  if (!s) return;
  s.textContent = text;
  setTimeout(() => {
    if (s.textContent === text) s.textContent = '';
  }, 4000);
}

export const when = (t: number | undefined): string => (t ? new Date(t).toLocaleString() : 'never');

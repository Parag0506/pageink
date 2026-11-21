import type { ElementPath } from 'pageink-core/types';

/** Structural address of an element in its document: id, a CSS path and an XPath. */
export function pathOf(el: Element): ElementPath {
  const css: string[] = [];
  const xp: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1) {
    const tag = cur.localName;
    let n = 1;
    for (let s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === tag) n++;
    css.unshift(`${tag}:nth-of-type(${n})`);
    xp.unshift(`${tag}[${n}]`);
    cur = cur.parentElement;
  }
  const out: ElementPath = { css: css.join(' > '), xpath: `/${xp.join('/')}` };
  if (el.id) out.id = el.id;
  return out;
}

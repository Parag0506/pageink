/**
 * Style sheets that work under a strict content security policy. Pages and
 * extension pages often send style-src without 'unsafe-inline', which blocks
 * <style> elements and style attributes. Constructed sheets adopted on a shadow
 * root or a document are allowed, and so is the CSSOM (el.style.setProperty).
 * A <style> element is the fallback only where adoption does not work.
 */

export interface Sheet {
  /** Replace the rules. */
  set(css: string): void;
  remove(): void;
  /** True when the rules live in an adopted sheet, false for the <style> fallback. */
  readonly adopted: boolean;
}

type Root = ShadowRoot | Document;

function adopt(root: Root, css: string): CSSStyleSheet | null {
  try {
    const doc = 'ownerDocument' in root && root.ownerDocument ? root.ownerDocument : (root as Document);
    const win = doc.defaultView as (Window & typeof globalThis) | null;
    const list = root.adoptedStyleSheets;
    if (!win || !Array.isArray(list) || typeof win.CSSStyleSheet !== 'function') return null;
    const sheet = new win.CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [...list, sheet];
    // Some content script worlds accept the write and drop it. Read it back.
    if (!root.adoptedStyleSheets.includes(sheet)) return null;
    return sheet;
  } catch {
    return null;
  }
}

/**
 * Add rules to a shadow root or a document. `parent` takes the <style>
 * fallback; it defaults to the root itself, or the head of a document.
 */
export function addSheet(root: Root, css: string, parent?: ParentNode): Sheet {
  const sheet = adopt(root, css);
  if (sheet) {
    return {
      adopted: true,
      set: (next) => sheet.replaceSync(next),
      remove() {
        try {
          root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
        } catch {
          // Nothing to undo.
        }
      },
    };
  }
  const doc = 'ownerDocument' in root && root.ownerDocument ? root.ownerDocument : (root as Document);
  const style = doc.createElement('style');
  style.textContent = css;
  const into = parent ?? ('head' in root ? (root.head ?? root.documentElement) : root);
  into.append(style);
  return {
    adopted: false,
    set(next) {
      if (style.textContent !== next) style.textContent = next;
    },
    remove: () => style.remove(),
  };
}

/** The shadow root or document a node lives in. */
export function rootOf(node: Node): Root {
  const r = node.getRootNode();
  // Checked by shape, not instanceof, so it works across frames and script worlds.
  if (r.nodeType === 9 || (r.nodeType === 11 && 'host' in r)) return r as Root;
  return node.ownerDocument as Document;
}

/** Set declarations through the CSSOM. Each one is "property: value", optionally ending in !important. */
export function setDecls(el: ElementCSSInlineStyle, decls: string[]): void {
  for (const d of decls) {
    const i = d.indexOf(':');
    if (i < 0) continue;
    let v = d.slice(i + 1).trim();
    const imp = /\s*!important$/.test(v);
    if (imp) v = v.replace(/\s*!important$/, '');
    el.style.setProperty(d.slice(0, i).trim(), v, imp ? 'important' : '');
  }
}

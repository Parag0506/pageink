/**
 * In-page navigation (DESIGN 7.5, single-page apps; CONTRACT 6).
 * Calls back once per address change. Where the Navigation API is missing,
 * pushState is caught by an address check after DOM changes.
 */
export function watchNavigation(win: Window, onChange: () => void, debounceMs = 150): () => void {
  let last = win.location.href;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    timer = undefined;
    const now = win.location.href;
    if (now === last) return;
    last = now;
    onChange();
  };
  const offs: (() => void)[] = [];
  const on = (t: EventTarget, type: string) => {
    t.addEventListener(type, check);
    offs.push(() => t.removeEventListener(type, check));
  };
  on(win, 'popstate');
  on(win, 'hashchange');
  const nav = (win as Window & { navigation?: EventTarget }).navigation;
  if (nav) on(nav, 'navigatesuccess');
  else {
    const mo = new MutationObserver(() => {
      if (!timer) timer = setTimeout(check, debounceMs);
    });
    mo.observe(win.document, { childList: true, subtree: true });
    offs.push(() => mo.disconnect());
  }
  return () => {
    if (timer) clearTimeout(timer);
    for (const f of offs) f();
  };
}

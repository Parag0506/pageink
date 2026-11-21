// Bench only. Records, per note id, when its first stroke enters the PageInk layer and the start of the
// next frame after that. The layer is a closed shadow root, which a content script can open with
// chrome.dom.openOrClosedShadowRoot. Nothing here writes to the page, so the measured extension
// sees the same document. The page asks for the data with postMessage({ benchProbe: 'dump' }).
(() => {
  const drawn = {};
  const visible = {};
  const seen = new WeakSet();
  let pending = [];
  const noteOf = (el) => el.closest?.('g[data-note]');
  const take = (el, t) => {
    const g = el.matches?.('g[data-note]') ? el : noteOf(el);
    const list = g ? [g] : [];
    if (el.querySelectorAll) for (const x of el.querySelectorAll('g[data-note]')) list.push(x);
    for (const x of list) {
      const id = x.dataset.note;
      if (!id || drawn[id] !== undefined || !x.querySelector('path')) continue;
      drawn[id] = t;
      pending.push(id);
    }
  };
  const onLayer = (muts) => {
    const t = performance.now();
    for (const m of muts) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1) take(n, t);
        if (m.target.nodeType === 1) take(m.target, t);
      }
    }
    if (pending.length) {
      const ids = pending;
      pending = [];
      requestAnimationFrame((ft) => {
        for (const id of ids) visible[id] = ft;
      });
    }
  };
  const watchHost = (host) => {
    if (seen.has(host)) return;
    const root = chrome.dom.openOrClosedShadowRoot(host);
    if (!root) return;
    seen.add(host);
    new MutationObserver(onLayer).observe(root, { childList: true, subtree: true });
    take(root, performance.now());
  };
  const scan = () => {
    const html = document.documentElement;
    if (!html) return;
    for (const c of html.children) if (c.localName === 'ink-layer') watchHost(c);
  };
  const top = new MutationObserver(scan);
  const start = () => {
    if (document.documentElement) top.observe(document.documentElement, { childList: true });
    scan();
  };
  new MutationObserver(start).observe(document, { childList: true });
  start();
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.benchProbe === 'dump')
      window.postMessage({ benchProbeData: { drawn, visible } }, '*');
  });
})();

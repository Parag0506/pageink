// Bench stand-in for the PageInk stub. It does what the real stub does on a page without ink:
// one storage read of the site index and settings, and one passive pen listener.
// When the index lists this page it draws the stored notes into a closed shadow root,
// so the latency and stress measurements have something to time.
(() => {
  const t0 = performance.now();
  // Same hash as packages/core/src/hash.ts (cyrb53, base36).
  const hashKey = (s) => {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  };
  const addressKey = (href) => {
    const u = new URL(href);
    u.hash = '';
    return u.toString();
  };
  const idx = `idx:${hashKey(location.hostname)}`;
  const buffered = [];
  addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'pen') buffered.push(e);
    },
    { capture: true, passive: true },
  );

  const draw = (rec) => {
    performance.mark('ink:view:start');
    const host = document.createElement('ink-layer');
    host.style.cssText =
      'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    const de = document.documentElement;
    const W = de.scrollWidth;
    const H = de.scrollHeight;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('style', 'position:absolute;left:0;top:0;overflow:visible');
    for (const n of rec.notes) {
      const g = document.createElementNS(ns, 'g');
      const f = n.anchor.frac ?? { x: 0.1, y: 0.1 };
      g.setAttribute('transform', `translate(${Math.round(f.x * W)} ${Math.round(f.y * H)})`);
      for (const s of n.strokes) {
        const p = document.createElementNS(ns, 'path');
        p.setAttribute('d', s.d);
        p.setAttribute('fill', s.tool === 'hi' ? 'rgba(255,220,0,.4)' : '#1a4fd6');
        g.appendChild(p);
      }
      svg.appendChild(g);
    }
    root.appendChild(svg);
    de.appendChild(host);
    performance.mark('ink:svg');
  };

  chrome.storage.local.get([idx, 'cfg']).then((got) => {
    performance.mark('ink:stub:read');
    const m = got[idx]?.m;
    const recHash = m?.[hashKey(addressKey(location.href))];
    if (!recHash) return;
    chrome.storage.local.get([`p:${recHash}`]).then((r) => {
      const rec = r[`p:${recHash}`];
      if (!rec) return;
      if (document.readyState === 'loading')
        addEventListener('DOMContentLoaded', () => draw(rec), { once: true });
      else draw(rec);
    });
  });
  performance.measure('ink:stub', { start: t0, end: performance.now() });
})();

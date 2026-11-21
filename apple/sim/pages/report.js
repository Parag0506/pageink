// Shows what the page itself can see, as one line of text. The UI test reads that line from
// the accessibility tree. The layer sits in a closed shadow root, so the page only knows
// whether the <ink-layer> host exists, not what is inside it.
(() => {
  const out = document.createElement('div');
  out.id = 'report';
  out.style.cssText =
    'position:fixed;left:0;top:0;font:11px/14px monospace;color:#777;background:#fff;' +
    'pointer-events:none;z-index:1;white-space:nowrap;padding:0';
  document.documentElement.append(out);
  // The page's own way back to the top, so tests can bring the marker words into view
  // without a finger stroke, which would write in draw mode.
  const top = document.createElement('button');
  top.type = 'button';
  top.textContent = 'Top';
  top.setAttribute('aria-label', 'Scroll to top');
  top.style.cssText = 'position:fixed;right:8px;top:24px;width:56px;height:44px;z-index:1;font:14px sans-serif';
  top.addEventListener('click', () => window.scrollTo(0, 0));
  document.documentElement.append(top);
  // Site data the page itself keeps. "new" after the test clears website data for the site.
  let ls = 'none';
  try {
    ls = localStorage.getItem('sim-mark') ? 'old' : 'new';
    localStorage.setItem('sim-mark', '1');
  } catch {}
  const ck = document.cookie.includes('sim-mark=1') ? 'old' : 'new';
  document.cookie = 'sim-mark=1; max-age=86400; path=/';
  window.hits = { link: 0, btn: 0 };
  document.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target.closest('a,button') : null;
    if (t?.id === 'link') window.hits.link++;
    if (t?.id === 'btn') window.hits.btn++;
  });
  const rect = (id) => {
    const e = document.getElementById(id);
    if (!e) return '-';
    const r = e.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 10) / 10).join(',');
  };
  const scroller = () => document.getElementById('inner')?.scrollTop ?? 0;
  // The bench build's marks, in ms from the first byte of the page, one decimal. -1 when absent.
  const nav = performance.getEntriesByType('navigation')[0];
  const from = nav ? nav.responseStart : 0;
  const ms = (v) => (v === undefined ? -1 : Math.round(v * 10) / 10);
  const last = (n) => performance.getEntriesByName(n).at(-1);
  const timing = () => [
    // Tells one load from the next.
    `load=${Math.round(performance.timeOrigin)}`,
    // When the stub started: after the browser parsed and ran the whole content script.
    `stubat=${ms(last('ink:stub-start') && last('ink:stub-start').startTime - from)}`,
    // The stub's own work.
    `stubms=${ms(last('ink:stub')?.duration)}`,
    // The first ink on screen.
    `fi=${ms(last('ink:first-ink') && last('ink:first-ink').startTime - from)}`,
    // How often the registered viewer ran at document start, and the last injection's time.
    `boot=${performance.getEntriesByName('ink:boot').length}`,
    `inj=${ms(last('ink:inject')?.duration)}`,
    `dcl=${ms(nav && nav.domContentLoadedEventStart > 0 ? nav.domContentLoadedEventStart - from : undefined)}`,
  ];
  const tick = () => {
    const open = document.querySelector('details')?.open;
    out.textContent = [
      'report',
      `layer=${document.querySelector('ink-layer') ? 1 : 0}`,
      `stub=${performance.getEntriesByName('ink:stub').length}`,
      `sy=${Math.round(scrollY)}`,
      `iw=${innerWidth}`,
      `me=${rect('report')}`,
      `w=${rect('w')}`,
      `ins=${Math.round(scroller())}`,
      `open=${open === undefined ? '-' : open ? 1 : 0}`,
      `link=${window.hits.link}`,
      `btn=${window.hits.btn}`,
      `hash=${location.hash || '-'}`,
      `ls=${ls}`,
      `ck=${ck}`,
      ...timing(),
      'end',
    ].join(' ');
  };
  tick();
  setInterval(tick, 150);
})();

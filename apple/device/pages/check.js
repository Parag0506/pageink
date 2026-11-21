// The device check page. One step per screen, in plain words, for a person with an iPad and
// an Apple Pencil. Each step has its own address, so every step starts on a fresh page and its
// ink stays with it. The diagnostics build of the extension reports here what capture saw for
// each stroke; the page adds what it saw itself and posts each step's result to the Mac.
// Test only: nothing here ships.
(() => {
  const STEPS = [
    { id: 'start', title: 'Welcome' },
    { id: 'extension', title: 'Switch on the extension' },
    { id: 'hello', title: 'The Pencil writes, first stroke included' },
    { id: 'scroll', title: 'A finger scrolls' },
    { id: 'palm', title: 'A hand on the screen is ignored' },
    { id: 'scribble', title: 'Scribble stays out of the way' },
    { id: 'reload', title: 'Writing comes back after a reload' },
    { id: 'rotate', title: 'Writing stays put when the iPad turns' },
    { id: 'pdf', title: 'A PDF from Files takes ink' },
    { id: 'done', title: 'Finished' },
  ];
  const id = location.pathname.split('/')[2] || 'start';
  const index = Math.max(
    0,
    STEPS.findIndex((s) => s.id === id),
  );
  const step = STEPS[index];
  const loadedAt = Date.now();
  /** The app's name on the iPad. The Mac sends it, from the app's build settings. */
  let NAME = 'the extension';
  const $ = (sel) => document.querySelector(sel);
  const main = $('#main');
  const root = $('#step');
  const statusLine = $('#status');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- talking to the Mac -------------------------------------------------------------

  const post = (path, data) =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
      keepalive: true,
    }).catch(() => {});
  const event = (type, text = '', data) => post('/api/event', { type, text, data });

  // ---- what the extension reports ------------------------------------------------------

  const diag = { hello: null, records: new Map(), subs: new Set() };
  const changed = () => {
    for (const f of [...diag.subs]) f();
  };
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
    const kind = e.data['ink-diag'];
    if (kind === 'hello') {
      const first = !diag.hello;
      diag.hello = e.data;
      if (first) {
        // The extension is listening now. An ask sent before it was may have gone unheard.
        ask('log');
        try {
          if (!sessionStorage.getItem('hello-sent')) {
            sessionStorage.setItem('hello-sent', '1');
            event('hello', '', { build: e.data.build, early: e.data.early });
          }
        } catch {}
      }
    } else if (kind === 'record' && e.data.record?.id) {
      diag.records.set(e.data.record.id, e.data.record);
    } else if (kind === 'log' && Array.isArray(e.data.records)) {
      for (const r of e.data.records) if (r?.id) diag.records.set(r.id, r);
    } else return;
    changed();
  });
  const ask = (kind) => postMessage({ 'ink-check': kind }, location.origin);

  /**
   * What the PDF step must remember while the person is in the viewer. It is kept for the whole
   * site, not per tab: the person may come back to this page in another tab, and Safari may give
   * the page a fresh session on the way back from the viewer. Each value names the run it
   * belongs to, so a value from an earlier run is never read.
   */
  let RUN = '';
  const shared = {
    get(k) {
      try {
        const v = JSON.parse(localStorage.getItem(`check-${k}`) || 'null');
        return v && v.run === RUN ? v.value : null;
      } catch {
        return null;
      }
    },
    set(k, value) {
      try {
        localStorage.setItem(`check-${k}`, JSON.stringify({ run: RUN, value }));
      } catch {}
    },
    clear() {
      try {
        for (const k of Object.keys(localStorage)) if (k.startsWith('check-')) localStorage.removeItem(k);
      } catch {}
    },
  };

  /** Resolves when cond() is true, checked whenever the extension reports and every half second. */
  function until(cond, ms = 600_000) {
    return new Promise((ok) => {
      let done = false;
      const check = () => {
        if (done || !cond()) return;
        done = true;
        diag.subs.delete(check);
        clearInterval(t);
        ok(true);
      };
      const t = setInterval(check, 500);
      diag.subs.add(check);
      setTimeout(() => {
        if (done) return;
        done = true;
        diag.subs.delete(check);
        clearInterval(t);
        ok(false);
      }, ms);
      check();
    });
  }

  // ---- what the page itself sees -----------------------------------------------------------

  const now = () => performance.now();
  const view = {
    scroll: [[now(), scrollX, scrollY]],
    selection: [],
    touches: [],
    field: [],
  };
  addEventListener(
    'scroll',
    () => {
      if (view.scroll.length < 5000) view.scroll.push([now(), Math.round(scrollX), Math.round(scrollY)]);
    },
    { passive: true },
  );
  document.addEventListener('selectionchange', () => {
    const n = (getSelection()?.toString() ?? '').length;
    if (view.selection.length < 2000) view.selection.push([now(), n]);
  });
  // Bubble phase at the window: defaultPrevented tells whether capture cancelled the touch.
  for (const type of ['touchstart', 'touchmove']) {
    addEventListener(
      type,
      (e) => {
        if (view.touches.length >= 5000) return;
        for (const t of e.changedTouches) {
          view.touches.push([now(), type, t.touchType === 'stylus' ? 'stylus' : 'finger', e.defaultPrevented]);
        }
      },
      { passive: true },
    );
  }
  const scrollAt = (t) => {
    let last = view.scroll[0];
    for (const s of view.scroll) {
      if (s[0] > t) break;
      last = s;
    }
    return { x: last[1], y: last[2] };
  };
  const selectedBetween = (a, b) =>
    view.selection.filter(([t, n]) => t >= a && t <= b && n > 0).reduce((m, [, n]) => Math.max(m, n), 0);

  /** The extension's records for this page load, each with what the page saw at that time. */
  function records(filter = (r) => r.where === 'page' && r.page === location.pathname && r.at >= loadedAt - 500) {
    return [...diag.records.values()]
      .filter(filter)
      .sort((a, b) => a.at - b.at)
      .map((r) => {
        if (r.where !== 'page') return r;
        const before = scrollAt(r.t0 - 1);
        const after = scrollAt(r.t1 + 100);
        const touches = view.touches.filter(([t]) => t >= r.t0 - 50 && t <= r.t1 + 50);
        return {
          ...r,
          view: {
            scrollBefore: before,
            scrollAfter: after,
            selected: selectedBetween(r.t0, r.t1 + 500),
            stylusTouches: touches.filter((t) => t[2] === 'stylus').length,
            stylusCancelled: touches.filter((t) => t[2] === 'stylus' && t[3]).length,
            fingerTouches: touches.filter((t) => t[2] === 'finger').length,
          },
        };
      });
  }
  const pen = (rs) => rs.filter((r) => r.pointerType === 'pen');
  const inked = (rs) => rs.filter((r) => r.outcome === 'ink');
  const still = (r) =>
    r.scroll0.x === r.scroll1.x &&
    r.scroll0.y === r.scroll1.y &&
    (!r.view || (r.view.scrollBefore.x === r.view.scrollAfter.x && r.view.scrollBefore.y === r.view.scrollAfter.y));
  const sum = (rs, f) => rs.reduce((n, r) => n + (f(r) || 0), 0);
  const quietFor = (ms) => {
    const last = Math.max(0, ...[...diag.records.values()].map((r) => r.at));
    return Date.now() - last >= ms;
  };

  // ---- drawing the screen -----------------------------------------------------------------

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) el.append(k.nodeType ? k : String(k));
    return el;
  }
  const show = (...kids) => root.replaceChildren(...kids.flat());
  const stage = (name) => main.setAttribute('aria-label', `check ${id} ${name}`);
  const tapWord = (w) => h('span', { class: 'tap' }, w);
  const pad = (words = 'Write here. These grey words are only here so the ink has something to sit on.') =>
    h('div', { class: 'pad', id: 'pad' }, h('p', {}, words), h('p', {}, 'The quick brown fox jumps over the lazy dog.'));

  function setStatus(text) {
    statusLine.hidden = !text;
    statusLine.textContent = text || '';
  }

  function nextUrl() {
    return `/s/${STEPS[Math.min(index + 1, STEPS.length - 1)].id}`;
  }
  const goNext = () => location.assign(nextUrl());
  const nextButton = (label = 'Next') => h('button', { class: 'go', type: 'button', onclick: goNext }, label);

  /** Two big buttons. Resolves true for Yes. */
  function yesNo(question, extra = []) {
    stage('ask');
    return new Promise((ok) => {
      root.append(
        h('p', { class: 'big' }, question),
        h(
          'div',
          { class: 'answers' },
          h('button', { class: 'yes', type: 'button', onclick: () => ok(true) }, 'Yes'),
          h('button', { class: 'no', type: 'button', onclick: () => ok(false) }, 'No'),
        ),
        ...extra,
      );
    });
  }

  /** Posts the result and shows a calm line and the Next button. */
  async function finish(status, why, auto = {}, answers = {}, recs = records(), extra = {}) {
    stage(`result ${status}`);
    const result = {
      id,
      title: step.title,
      status,
      why,
      auto,
      answers,
      records: recs,
      view: { scroll: scrollAt(now()), selection: (getSelection()?.toString() ?? '').length, ...extra },
    };
    await post('/api/step', result);
    try {
      sessionStorage.removeItem(`${id}-phase`);
    } catch {}
    shared.set(`${id}-phase`, '');
    show(
      h('h1', {}, status === 'pass' ? 'That worked.' : status === 'skip' ? 'Skipped.' : 'Thank you.'),
      h(
        'p',
        {},
        status === 'pass'
          ? 'This check passed.'
          : status === 'skip'
            ? 'This check was skipped. That is fine.'
            : status === 'seen'
              ? 'You saw it work. The check got no record of it, and that has been noted.'
              : 'This did not work as it should. It has been noted, so there is nothing more to do here.',
      ),
      nextButton(),
    );
  }

  /** The first failed check, in words, or an empty string. */
  const firstFail = (checks) => {
    const f = Object.entries(checks).find(([, v]) => v === false);
    return f ? f[0] : '';
  };

  /** Waits for Pencil ink on this page, then for the hand to rest. Hints when a finger writes. */
  async function waitForPencil(minInk = 1, quiet = 2500, ms = 120_000) {
    stage('write');
    const hint = setInterval(() => {
      const rs = records();
      if (!pen(rs).length && rs.some((r) => r.pointerType === 'touch')) setStatus('That looked like a finger. Please use the Pencil.');
      else if (pen(rs).some((r) => r.outcome === 'skip') && !inked(pen(rs)).length)
        setStatus('The Pencil was seen, but it did not write. Try again on the grey box.');
      else setStatus('');
    }, 1000);
    const ok = await until(() => inked(pen(records())).length >= minInk && quietFor(quiet), ms);
    clearInterval(hint);
    setStatus('');
    return ok;
  }

  // Every step but the first two needs the extension. Say so when it does not report in.
  if (!['start', 'extension', 'done'].includes(id)) {
    setTimeout(() => {
      if (diag.hello) return;
      setStatus(`${NAME} is not answering on this page.`);
      statusLine.append(
        ' ',
        h('a', { href: '/s/extension' }, 'Go to the step that switches it on'),
      );
    }, 5000);
  }

  // ---- every website --------------------------------------------------------------------------

  /** The Settings path, as words to tap. */
  const settingsPath = () =>
    h(
      'div',
      { class: 'path', 'aria-label': `Settings, Apps, Safari, Extensions, ${NAME}, All Websites` },
      ['Settings', 'Apps', 'Safari', 'Extensions', NAME, 'All Websites'].flatMap((w, i) =>
        i ? [h('b', {}, '›'), h('span', {}, w)] : [h('span', {}, w)],
      ),
    );

  /**
   * After the extension said hello: it must be allowed on every website. With All Websites left
   * on Ask, the Pencil writes only after a tap on the toolbar button, and nothing says why.
   */
  async function allWebsites() {
    const done = (all) =>
      finish('pass', '', { reported: true, build: diag.hello.build, allWebsites: all });
    // An older build does not say. Then there is nothing to check here.
    if (diag.hello.all !== false) return done(diag.hello.all);
    stage('websites');
    let over = false;
    const fail = () => {
      over = true;
      finish('fail', 'All Websites is not set to Allow', { reported: true, build: diag.hello.build, allWebsites: false });
    };
    show(
      h('h1', {}, 'One more switch'),
      h('p', { class: 'big' }, `${NAME} needs permission for websites. Now Safari asks each time, so the Pencil does not write until you tap the ${NAME} button.`),
      h('p', {}, 'Please do this:'),
      settingsPath(),
      h(
        'ol',
        { class: 'steps' },
        h('li', {}, 'Open ', tapWord('Settings'), ', tap ', tapWord('Apps'), ', then ', tapWord('Safari'), ', then ', tapWord('Extensions'), '.'),
        h('li', {}, 'Tap ', tapWord(NAME), '. Under Permissions, tap ', tapWord('All Websites'), ', then tap ', tapWord('Allow'), '.'),
        h('li', {}, 'Come back to Safari. This page checks again by itself.'),
      ),
      h(
        'p',
        { class: 'note' },
        'Or, here in Safari: tap the puzzle piece in the address bar, tap ',
        tapWord(NAME),
        ', then choose ',
        tapWord('Always Allow on Every Website'),
        '.',
      ),
      h('button', { class: 'plain', type: 'button', onclick: fail }, 'I cannot change it'),
    );
    const allowed = await until(() => {
      if (over || diag.hello?.all === true) return true;
      ask('hello');
      return false;
    });
    if (allowed && !over) done(true);
  }

  // ---- the steps ----------------------------------------------------------------------------

  const steps = {
    async start() {
      stage('intro');
      event('open', 'start', { ua: navigator.userAgent, screen: `${screen.width}x${screen.height}`, dpr: devicePixelRatio });
      show(
        h('h1', {}, 'Check Apple Pencil on this iPad'),
        h('p', {}, 'This takes about ten minutes. Keep your Apple Pencil close.'),
        h('p', {}, 'Each screen asks for one thing. Do it, then tap Next.'),
        h('p', { class: 'note' }, 'Nothing you write here leaves this iPad and the computer that sent this page.'),
        h(
          'button',
          {
            class: 'go',
            type: 'button',
            onclick: () => {
              // A fresh start: forget strokes kept from an earlier run.
              if (diag.hello) ask('clear');
              try {
                sessionStorage.clear();
              } catch {}
              shared.clear();
              setTimeout(goNext, 300);
            },
          },
          'Start',
        ),
      );
    },

    async extension() {
      stage('wait');
      show(h('h1', {}, `Switch on ${NAME}`), h('p', {}, `Checking whether ${NAME} is on…`));
      if (await until(() => diag.hello, 3000)) return allWebsites();
      stage('instructions');
      show(
        h('h1', {}, `Switch on ${NAME}`),
        h('p', {}, `${NAME} is not on yet. Please do this:`),
        h(
          'div',
          { class: 'path', 'aria-label': `Settings, Apps, Safari, Extensions, ${NAME}` },
          h('span', {}, 'Settings'),
          h('b', {}, '›'),
          h('span', {}, 'Apps'),
          h('b', {}, '›'),
          h('span', {}, 'Safari'),
          h('b', {}, '›'),
          h('span', {}, 'Extensions'),
          h('b', {}, '›'),
          h('span', {}, NAME),
        ),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, 'Swipe up from the bottom edge of the screen to go to the Home Screen.'),
          h('li', {}, 'Open ', tapWord('Settings'), '.'),
          h('li', {}, 'Tap ', tapWord('Apps'), '. Then find and tap ', tapWord('Safari'), '.'),
          h('li', {}, 'Tap ', tapWord('Extensions'), '. Then tap ', tapWord(NAME), '.'),
          h('li', {}, 'Switch on ', tapWord('Allow Extension'), '.'),
          h('li', {}, 'Under Permissions, tap ', tapWord('All Websites'), ', then tap ', tapWord('Allow'), '.'),
          h('li', {}, 'Come back to Safari. This page checks again by itself.'),
        ),
        h('p', { class: 'note' }, `If ${NAME} is not in the list, open the ${NAME} app on the Home Screen once, then look again.`),
        h('button', { class: 'plain', type: 'button', onclick: () => location.reload() }, 'Check again'),
      );
      // Safari adds the extension to pages loaded after it was allowed, so reload on return.
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState !== 'visible' || diag.hello) return;
        ask('hello');
        await wait(1500);
        if (!diag.hello) location.reload();
      });
      const giveUp = h(
        'button',
        {
          class: 'plain',
          type: 'button',
          onclick: () => finish('fail', 'The extension never reported in', { reported: false }),
        },
        'I cannot find it',
      );
      setTimeout(() => root.append(giveUp), 60_000);
      if (await until(() => diag.hello)) allWebsites();
    },

    async hello() {
      show(
        h('h1', {}, 'Write with the Pencil'),
        h('p', { class: 'big' }, 'Write the word hello on the grey box with your Pencil.'),
        pad(),
      );
      const stuck = h(
        'button',
        { class: 'plain', type: 'button', onclick: () => helloDone(false) },
        'I wrote, but nothing showed',
      );
      let done = false;
      let wrote = false;
      setTimeout(() => !wrote && !done && root.append(stuck), 45_000);
      async function helloDone(answer) {
        if (done) return;
        done = true;
        const rs = records();
        const p = pen(rs);
        const ink = inked(p);
        const first = p.find((r) => r.outcome !== 'skip') ?? p[0];
        const checks = {
          'No Pencil stroke became ink': ink.length > 0,
          'Draw mode was on, so this does not test the Pencil alone': ink.every((r) => !r.draw),
          'The first stroke after the page loaded did not become ink': !!first && first.outcome === 'ink',
          'The page scrolled while the Pencil wrote': ink.every(still),
          'Text got selected while the Pencil wrote': ink.every((r) => !r.view?.selected),
          'A finger made ink with draw mode off': !inked(rs.filter((r) => r.pointerType === 'touch')).length,
        };
        const auto = {
          checks,
          strokes: ink.length,
          firstStroke: first
            ? { outcome: first.outcome, bufferedByStub: first.replayed, stub: first.stub ?? null, firstPaintMs: first.firstPaintMs }
            : null,
          stylusTouches: sum(p, (r) => r.stylusTouches) + (first?.stub?.stylus ?? 0),
          stylusCancelled: sum(p, (r) => r.stylusCancelled) + (first?.stub?.stylusCancelled ?? 0),
          pressure: ink.length
            ? { min: Math.min(...ink.map((r) => r.pressure.min)), max: Math.max(...ink.map((r) => r.pressure.max)) }
            : null,
        };
        const why = firstFail(checks) || (answer ? '' : 'You said the writing did not appear as ink');
        finish(why ? 'fail' : 'pass', why, auto, { 'Did your writing appear as ink?': answer }, rs);
      }
      if (!(await waitForPencil())) return;
      if (done) return;
      wrote = true;
      stuck.remove();
      helloDone(await yesNo('Did your writing appear as ink?'));
    },

    async scroll() {
      stage('scroll');
      const filler = [];
      for (let i = 1; i <= 30; i++) {
        filler.push(h('p', {}, `Line ${i}. This is plain text to scroll past. Keep going with one finger.`));
      }
      show(
        h(
          'div',
          { class: 'sticky' },
          h('h1', {}, 'Scroll with one finger'),
          h('p', { class: 'big' }, 'Now scroll this page down with one finger.'),
        ),
        h('div', { class: 'filler' }, filler),
      );
      const y0 = scrollY;
      const hint = setInterval(() => {
        setStatus(pen(records()).length ? 'Please use one finger for this step, not the Pencil.' : '');
      }, 1000);
      const stuck = h(
        'button',
        { class: 'plain', type: 'button', onclick: () => end(false) },
        'The page does not move',
      );
      setTimeout(() => root.append(stuck), 45_000);
      let done = false;
      const end = async (moved) => {
        if (done) return;
        done = true;
        clearInterval(hint);
        setStatus('');
        const rs = records();
        const checks = {
          'The page did not scroll': moved,
          'The finger made ink': !inked(rs.filter((r) => r.pointerType === 'touch')).length,
        };
        const auto = { checks, scrolledBy: Math.round(scrollY - y0) };
        const why = firstFail(checks);
        window.scrollTo(0, 0);
        await wait(200);
        finish(why ? 'fail' : 'pass', why, auto, {}, rs);
      };
      await until(() => scrollY - y0 > 300 || done);
      await wait(800);
      end(true);
    },

    async palm() {
      show(
        h('h1', {}, 'Hand on the screen'),
        h(
          'p',
          { class: 'big' },
          'Rest the side of your hand on the screen, the way you would on paper. Keep it there and write a line on the grey box with your Pencil.',
        ),
        pad(),
      );
      if (!(await waitForPencil())) return finish('fail', 'No Pencil stroke came through', {}, {}, records());
      const answer = await yesNo('Did only your Pencil line appear, with no marks from your hand?');
      const rs = records();
      const ink = inked(pen(rs));
      const checks = {
        'No Pencil stroke became ink': ink.length > 0,
        'The hand made ink': !inked(rs.filter((r) => r.pointerType === 'touch')).length,
        'The page scrolled while the Pencil wrote': ink.every(still),
      };
      const auto = {
        checks,
        handTouchesWhilePen: sum(ink, (r) => r.fingersWhilePen),
        handTouchesKeptFromPage: sum(ink, (r) => r.fingersBlocked),
        fingerTouchesSeenByPage: sum(ink, (r) => r.view?.fingerTouches),
      };
      const why = firstFail(checks) || (answer ? '' : 'You saw marks from your hand');
      finish(why ? 'fail' : 'pass', why, auto, { 'Did only your Pencil line appear?': answer }, rs);
    },

    async scribble() {
      const field = h('input', { class: 'field', id: 'field', type: 'text', placeholder: 'Tap here first', autocomplete: 'off' });
      const log = (e) => view.field.push([now(), e.type, e.inputType ?? '', e.data ?? '', field.value.length]);
      for (const t of ['focus', 'blur', 'beforeinput', 'input', 'change']) field.addEventListener(t, log);
      show(
        h('h1', {}, 'Text box and Pencil'),
        h('p', { class: 'big' }, 'Tap the white box with your finger. Then write a word over the grey paragraph below it with your Pencil.'),
        field,
        pad('Write over these words with your Pencil. Typed letters should not appear in the white box.'),
      );
      stage('tap');
      await until(() => view.field.some((f) => f[1] === 'focus'), 120_000);
      if (!(await waitForPencil(1, 3000))) return finish('fail', 'No Pencil stroke came through', {}, {}, records(), { field: view.field });
      const typed = field.value;
      field.blur();
      const answer = await yesNo('Did your writing stay as ink, with no letters typed into the white box?');
      const rs = records();
      const ink = inked(pen(rs));
      const checks = {
        'No Pencil stroke became ink': ink.length > 0,
        'Scribble typed text into the box': typed === '' && !view.field.some((f) => f[1] === 'input'),
        'Text got selected while the Pencil wrote': ink.every((r) => !r.view?.selected),
        'The page scrolled while the Pencil wrote': ink.every(still),
      };
      const auto = { checks, typed, fieldEvents: view.field.length };
      const why = firstFail(checks) || (answer ? '' : 'You saw typed letters or no ink');
      finish(why ? 'fail' : 'pass', why, auto, { 'Did your writing stay as ink?': answer }, rs, { field: view.field });
    },

    async reload() {
      const nav = performance.getEntriesByType('navigation')[0];
      let phase = '';
      try {
        phase = sessionStorage.getItem('reload-phase') || '';
      } catch {}
      if (phase === 'wrote' && nav?.type === 'reload') {
        stage('after');
        show(h('h1', {}, 'Reload the page'), h('p', { class: 'big' }, 'Checking…'), pad());
        await wait(2500);
        const layer = !!document.querySelector('ink-layer');
        let before = [];
        try {
          before = JSON.parse(sessionStorage.getItem('reload-records') || '[]');
        } catch {}
        const answer = await yesNo('Is your line still on the grey box?');
        const checks = { 'The ink layer did not come back after the reload': layer };
        const why = firstFail(checks) || (answer ? '' : 'You did not see your line after the reload');
        try {
          sessionStorage.removeItem('reload-phase');
        } catch {}
        return finish(why ? 'fail' : 'pass', why, { checks, layer }, { 'Is your line still there?': answer }, before);
      }
      show(h('h1', {}, 'Reload the page'), h('p', { class: 'big' }, 'Write a short line on the grey box with your Pencil.'), pad());
      if (!(await waitForPencil(1, 1500))) return;
      try {
        sessionStorage.setItem('reload-phase', 'wrote');
        sessionStorage.setItem('reload-records', JSON.stringify(records()));
      } catch {}
      stage('reload');
      show(
        h('h1', {}, 'Reload the page'),
        h('p', { class: 'big' }, 'Now reload this page: tap the round arrow ↻ in the address bar at the top of the screen.'),
        h('p', { class: 'note' }, 'If you cannot find it, tap this button instead.'),
        h('button', { class: 'plain', type: 'button', onclick: () => location.reload() }, 'Reload'),
        pad(),
      );
    },

    async rotate() {
      const wide = () => innerWidth > innerHeight;
      show(h('h1', {}, 'Turn the iPad'), h('p', { class: 'big' }, 'Write a short line on the grey box with your Pencil.'), pad());
      if (!(await waitForPencil(1, 1500))) return;
      const was = wide();
      stage('turn');
      show(
        h('h1', {}, 'Turn the iPad'),
        h('p', { class: 'big' }, was ? 'Now turn the iPad upright.' : 'Now turn the iPad sideways.'),
        pad(),
      );
      let locked = false;
      const lockButton = h(
        'button',
        {
          class: 'plain',
          type: 'button',
          onclick: () => {
            locked = true;
          },
        },
        'The screen does not turn',
      );
      setTimeout(() => root.append(lockButton), 30_000);
      await until(() => wide() !== was || locked);
      if (locked) {
        return finish('skip', 'The screen did not turn. Rotation lock may be on', { turned: false }, {}, records());
      }
      await wait(1500);
      const layer = !!document.querySelector('ink-layer');
      lockButton.remove();
      const answer = await yesNo('Is your line still on the same words?');
      const checks = { 'The ink layer was gone after turning': layer };
      const why = firstFail(checks) || (answer ? '' : 'You saw the line move away from its words');
      root.prepend(h('p', { class: 'note' }, 'You can turn the iPad back now.'));
      finish(why ? 'fail' : 'pass', why, { checks, turned: true, wideBefore: was }, { 'Is your line still on the same words?': answer }, records());
    },

    async pdf() {
      // Kept for the whole site, so it holds however the person comes back (see shared).
      const phase = shared.get('pdf-phase') || '';
      // Strokes in the viewer count from the first time this step was shown in this run.
      // Nothing later moves it, so a stroke made before the person found the way back counts.
      let since = Number(shared.get('pdf-since') || 0);
      if (!since) {
        since = loadedAt;
        shared.set('pdf-since', since);
      }
      // Coming back with the back arrow can show the page as it was, and the viewer may have
      // opened in its own tab. Either way, start this page again once it is seen.
      addEventListener('pageshow', (e) => {
        if (e.persisted) location.reload();
      });
      document.addEventListener('visibilitychange', () => {
        const now = shared.get('pdf-phase') || '';
        if (document.visibilityState === 'visible' && now === 'opened' && phase !== 'opened') location.reload();
      });
      if (phase === 'opened') {
        stage('back');
        show(h('h1', {}, 'Write on a PDF'), h('p', { class: 'big' }, 'Welcome back. Checking…'));
        const pdfRecords = () => records((r) => r.where === 'pdf' && r.at >= since);
        // Ask until a stroke from the viewer is in, for a few seconds at most.
        await until(() => {
          if (inked(pen(pdfRecords())).length) return true;
          ask('log');
          return false;
        }, 5000);
        const rs = pdfRecords();
        const ink = inked(pen(rs));
        const later = h(
          'button',
          {
            class: 'plain',
            type: 'button',
            onclick: () => {
              shared.set('pdf-phase', 'saved');
              location.reload();
            },
          },
          'I have not done it yet',
        );
        const answer = await yesNo('Did test.pdf open, and did your writing show on page 1?', [later]);
        const answers = { 'Did the PDF open and take ink?': answer };
        if (!answer) return finish('fail', 'You did not see the PDF or your writing on it', { strokes: ink.length }, answers, rs);
        // The person saw the ink, so the product worked. Without a record that is all we know.
        if (!ink.length) return finish('seen', 'You saw the ink; the tool got no record of it', { strokes: 0 }, answers, rs);
        return finish('pass', '', { strokes: ink.length }, answers, rs);
      }
      if (phase !== 'saved') {
        stage('save');
        show(
          h('h1', {}, 'Write on a PDF'),
          h('p', { class: 'big' }, 'First, save the test file. Tap Save test.pdf. If Safari asks, tap Download.'),
          h(
            'a',
            {
              class: 'go',
              href: '/test.pdf',
              download: 'test.pdf',
              onclick: () => {
                shared.set('pdf-phase', 'saved');
                setTimeout(() => location.reload(), 2500);
              },
            },
            'Save test.pdf',
          ),
        );
        return;
      }
      stage('open');
      const viewer = diag.hello?.viewer || (await until(() => diag.hello, 3000), diag.hello?.viewer);
      const opened = () => shared.set('pdf-phase', 'opened');
      show(
        h('h1', {}, 'Write on a PDF'),
        h(
          'ol',
          { class: 'steps' },
          h('li', {}, 'Tap ', tapWord('Open the PDF viewer'), ' below.'),
          h('li', {}, 'In the viewer, tap ', tapWord('Open file'), '. If a menu opens, tap ', tapWord('Choose File'), '.'),
          h(
            'li',
            {},
            'This opens Files. Find ',
            tapWord('test.pdf'),
            ' and tap it. It is in ',
            tapWord('Downloads'),
            ', under iCloud Drive or On My iPad. Recents may show it too.',
          ),
          h('li', {}, 'Write on page 1 with your Pencil.'),
          h('li', {}, 'Tap ', tapWord('Back to the Pencil check'), ' at the top of the viewer.'),
        ),
        viewer
          ? h(
              'a',
              {
                class: 'go',
                // The viewer shows the way back only when it was opened from here.
                href: `${viewer}?from=check`,
                onclick: opened,
              },
              'Open the PDF viewer',
            )
          : null,
        h(
          'p',
          { class: 'note' },
          viewer
            ? `If the viewer does not open: tap the puzzle piece in the address bar, tap ${NAME}, tap Settings, then tap Open a PDF.`
            : `Tap the puzzle piece in the address bar, tap ${NAME}, tap Settings, then tap Open a PDF.`,
        ),
        h(
          'button',
          {
            class: 'plain',
            type: 'button',
            onclick: () => {
              opened();
              location.reload();
            },
          },
          'I have written on the PDF',
        ),
      );
    },

    async done() {
      stage('done');
      // Read the results first: the Mac stops serving once it hears that the check is done.
      let steps = {};
      try {
        steps = (await (await fetch('/api/state')).json()).steps;
      } catch {}
      // A tab left on this page by an earlier check has no results in this one. Start again.
      if (!Object.keys(steps).length) return location.replace('/s/start');
      await post('/api/done', {});
      show(
        h('h1', {}, 'All done. Thank you.'),
        h('p', {}, 'You can put the iPad down. The results are on the computer.'),
        h(
          'ul',
          { class: 'results' },
          STEPS.filter((s) => !['start', 'done'].includes(s.id)).map((s) => {
            const r = steps[s.id];
            const mark = !r ? '○' : r.status === 'pass' || r.status === 'seen' ? '✓' : r.status === 'skip' ? '○' : '✗';
            const good = r?.status === 'pass' || r?.status === 'seen';
            return h('li', { class: good ? 'ok' : r?.status === 'fail' ? 'bad' : '' }, `${mark}  ${s.title}`);
          }),
        ),
      );
    },
  };

  const shown = STEPS.filter((s) => !['start', 'done'].includes(s.id));
  const n = shown.findIndex((s) => s.id === id);
  $('#progress').textContent = n >= 0 ? `Step ${n + 1} of ${shown.length}` : id === 'done' ? 'Finished' : 'Pencil check';
  if (id !== 'start') event('page', '', { step: id });
  // The extension says hello on its own at load. Ask again in case this script ran later.
  ask('hello');
  ask('log');
  fetch('/api/state')
    .then((r) => r.json())
    .then((st) => {
      if (st.name) NAME = st.name;
      if (st.started) RUN = st.started;
    })
    .catch(() => {})
    .finally(() => steps[id]?.());
})();

import { NAME } from '../brand';
import { addSheet, rootOf } from '../css';
import type { CreateUi, InkColor, InkState, Tool, TrayItem, Ui, UiHost } from '../types';
import { iconNode } from './icons';
import { createRoom } from './room';
import { CSS } from './style';
import { inkThumb } from './thumb';

export type Edge = 'bottom' | 'top' | 'left' | 'right';
const EDGES: Edge[] = ['bottom', 'left', 'top', 'right'];

// The chosen edge lasts for this page session only. Nothing is stored.
let sessionEdge: Edge | undefined;

/** Forget the remembered edge. For tests. */
export const resetUiSession = (): void => {
  sessionEdge = undefined;
};

type Action = (byKey: boolean) => void;

const SHORTCUTS: Record<string, Tool> = { p: 'pen', h: 'hi', e: 'eraser', l: 'lasso' };
const isInk = (c: InkColor) => c === 'ink-1' || c === 'ink-2';
const isHi = (c: InkColor) => c.startsWith('hi');

function setA(el: Element, name: string, v: string | null): void {
  if (v === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

function editable(n: EventTarget | null | undefined): boolean {
  if (!(n instanceof Element)) return false;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)) return true;
  return n instanceof HTMLElement && n.isContentEditable;
}

function deepActive(doc: Document): Element | null {
  let a = doc.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

/**
 * Bottom centre on coarse pointers, where the thumb reaches and the reading
 * column is untouched. Right edge on fine pointers, beside the scrollbar and
 * clear of text that usually runs left to right.
 */
const defaultEdge = (win: Window): Edge =>
  win.matchMedia?.('(pointer: coarse)').matches ? 'bottom' : 'right';

export const createUi: CreateUi = (host: UiHost): Ui => {
  const doc = host.mount.ownerDocument;
  const win = doc.defaultView ?? window;
  const actions = new Map<Element, Action>();
  let edge: Edge = sessionEdge ?? defaultEdge(win);

  const mk = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls = '',
    text = '',
  ): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const btn = (
    label: string,
    title: string,
    ic: string,
    act: Action,
    cls = '',
    text = '',
  ): HTMLButtonElement => {
    const b = mk('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = title;
    if (ic) b.append(iconNode(doc, ic));
    if (text) b.append(mk('span', '', text));
    actions.set(b, act);
    return b;
  };

  const root = mk('div', 'iu');
  root.setAttribute('data-edge', edge);

  // Bar
  const bar = mk('div', 'bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', `${NAME} tools`);
  const grip = btn('Move the bar', 'Drag to another edge', 'grip', () => moveTo(nextEdge()), 'grip');
  const drawB = btn('Draw', 'Draw (Esc to stop)', 'draw', () => host.cmd.setDraw(!host.state().draw), 'draw');
  const pickPen = (c: InkColor) => () => {
    host.cmd.setTool('pen');
    host.cmd.setColor(c);
  };
  const pen1 = btn('Pen, first colour', 'Pen (P)', '', pickPen('ink-1'), 'swb');
  const pen2 = btn('Pen, second colour', 'Pen, second colour', '', pickPen('ink-2'), 'swb');
  const sw1 = mk('span', 'sw');
  const sw2 = mk('span', 'sw');
  pen1.append(sw1);
  pen2.append(sw2);
  const hiB = btn('Highlighter', 'Highlighter (H)', 'hi', () => pickTool('hi'));
  const hiSw = mk('span', 'hib');
  hiB.append(hiSw);
  const erB = btn('Eraser', 'Eraser (E)', 'eraser', () => pickTool('eraser'));
  const laB = btn('Lasso', 'Lasso to move, split or join (L)', 'lasso', () => pickTool('lasso'));
  const undoB = btn('Undo', 'Undo (Ctrl Z)', 'undo', () => host.cmd.undo());
  const redoB = btn('Redo', 'Redo (Ctrl Shift Z)', 'redo', () => host.cmd.redo());
  const trayB = btn('Moved notes', 'Moved notes', 'tray', (k) => toggleTray(k));
  const cnt = mk('span', 'cnt');
  cnt.setAttribute('aria-hidden', 'true');
  trayB.append(cnt);
  trayB.setAttribute('aria-haspopup', 'dialog');
  const moreB = btn('More', 'More', 'more', (k) => (menuOpen ? closeMenu(false) : openMenu(k)));
  moreB.setAttribute('aria-haspopup', 'menu');
  const sep = () => {
    const s = mk('span', 'sep');
    s.setAttribute('aria-hidden', 'true');
    return s;
  };
  // A quiet mark for a problem such as a failed save. The text is in its label and tooltip.
  const wn = mk('span', 'wn', '!');
  wn.setAttribute('role', 'status');
  wn.hidden = true;
  bar.append(grip, drawB, sep(), pen1, pen2, hiB, erB, laB, sep(), undoB, redoB, sep(), trayB, moreB, wn);
  const toolBtns: [HTMLButtonElement, (s: InkState) => boolean][] = [
    [pen1, (s) => s.tool === 'pen' && s.color === 'ink-1'],
    [pen2, (s) => s.tool === 'pen' && s.color === 'ink-2'],
    [hiB, (s) => s.tool === 'hi'],
    [erB, (s) => s.tool === 'eraser'],
    [laB, (s) => s.tool === 'lasso'],
  ];

  // More menu, with a confirm step for clearing the page.
  const menu = mk('div', 'pop menu');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'More');
  menu.id = 'iu-menu';
  moreB.setAttribute('aria-controls', menu.id);
  const run = (f: () => unknown) => () => {
    closeMenu(true);
    void Promise.resolve()
      .then(f)
      .catch(() => {});
  };
  const mItem = (text: string, ic: string, act: Action, cls = '') => {
    const b = btn(text, text, ic, act, cls, text);
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    return b;
  };
  const main = [
    mItem(
      'Save as image',
      'image',
      run(() => host.cmd.exportImage()),
    ),
    mItem(
      'Save notes as Markdown',
      'doc',
      run(() => host.cmd.exportMarkdown()),
    ),
    mItem(
      'Copy for chat',
      'chat',
      run(() => host.cmd.copyForChat()),
    ),
    mItem(
      'Print',
      'print',
      run(() => host.cmd.print()),
    ),
    mItem('Clear page', 'trash', () => confirmClear(true), 'bad'),
  ];
  const siteB = mItem(
    'Turn ink off for this site',
    'power',
    run(() => host.cmd.setSiteOff(!host.state().off)),
  );
  // A host page that owns the on and off choice leaves this entry out.
  if (!host.hideSiteOff) main.push(siteB);
  const warn = mk('p', 'warn', 'Remove all ink on this page? This cannot be undone.');
  warn.id = 'iu-warn';
  const yes = mItem(
    'Remove',
    'trash',
    run(() => host.cmd.clearPage()),
    'bad',
  );
  yes.setAttribute('aria-describedby', warn.id);
  const no = mItem('Cancel', 'close', () => confirmClear(false));
  const ask = [warn, yes, no];
  menu.append(...main, ...ask);
  menu.hidden = true;
  bar.append(menu);

  // Selection actions
  const sel = mk('div', 'pop sel');
  sel.setAttribute('role', 'toolbar');
  sel.setAttribute('aria-label', 'Selection');
  sel.append(
    btn('Join', 'Join into one note', 'join', () => host.cmd.joinSelected(), '', 'Join'),
    btn('Split', 'Split into a new note', 'split', () => host.cmd.splitSelected(), '', 'Split'),
    btn(
      'Delete',
      'Delete selected ink',
      'trash',
      () => host.cmd.deleteNotes([...host.state().selected]),
      '',
      'Delete',
    ),
    btn('Done', 'Clear the selection', 'done', () => host.cmd.clearSelection(), '', 'Done'),
  );
  sel.hidden = true;
  bar.append(sel);

  // A one-line note beside the bar: a problem, or a hint until the reader does anything.
  // A quiet second line says when nothing is saved, in a private window.
  const note = mk('div', 'pop note');
  const noteMsg = mk('p', 'msg');
  noteMsg.setAttribute('role', 'status');
  const notePv = mk('p', 'pv', 'Not saved in private windows');
  note.append(noteMsg, notePv);
  note.hidden = true;
  bar.append(note);

  // Handle shown while the bar is hidden.
  const hdl = btn('Show ink tools', 'Show ink tools', '', () => wake(), 'hdl');
  hdl.append(mk('i'));

  // Tray panel
  const tray = mk('div', 'tray');
  tray.setAttribute('role', 'dialog');
  tray.setAttribute('aria-label', 'Moved notes');
  tray.id = 'iu-tray';
  trayB.setAttribute('aria-controls', tray.id);
  const hd = mk('div', 'hd');
  const trayClose = btn('Close', 'Close', 'close', () => closeTray(true));
  hd.append(mk('h2', '', 'Moved notes'), trayClose);
  const list = mk('ul');
  const empty = mk('p', 'empty', 'No moved notes.');
  // Notes held while the browser shows a translation: listed apart, under a quiet line.
  const heldHd = mk('p', 'sub', 'Hidden while the page is translated');
  const heldList = mk('ul', 'held');
  heldHd.hidden = heldList.hidden = true;
  tray.append(hd, list, heldHd, heldList, empty);
  tray.hidden = true;

  // Placing banner
  const ban = mk('div', 'ban');
  ban.setAttribute('role', 'status');
  ban.append(
    mk('span', '', 'Tap where this note belongs'),
    btn('Cancel', 'Cancel', '', () => host.cmd.place(null), 'pri', 'Cancel'),
  );
  ban.hidden = true;

  root.append(bar, hdl, tray, ban);
  host.mount.append(root);
  // An adopted sheet, so the bar is styled under a strict style-src too.
  const sheet = addSheet(rootOf(host.mount), CSS, host.mount);

  // ---------------------------------------------------------------------------
  // Bar behaviour

  function pickTool(t: Tool): void {
    host.cmd.setTool(t);
    const c = host.state().color;
    if (t === 'pen' && !isInk(c)) host.cmd.setColor('ink-1');
    if (t === 'hi' && !isHi(c)) host.cmd.setColor('hi-1');
  }

  function nextEdge(): Edge {
    return EDGES[(EDGES.indexOf(edge) + 1) % EDGES.length] as Edge;
  }

  function moveTo(e: Edge): void {
    edge = e;
    sessionEdge = e;
    setA(root, 'data-edge', e);
    setA(bar, 'aria-orientation', e === 'left' || e === 'right' ? 'vertical' : 'horizontal');
    wake();
    fitRoom();
  }

  // Roving focus inside the toolbar: one tab stop, arrows move between buttons.
  const barBtns = () =>
    [...bar.children].filter((c): c is HTMLButtonElement => c instanceof HTMLButtonElement && !c.hidden);
  let rove: HTMLButtonElement = drawB;
  function setRove(b: HTMLButtonElement): void {
    rove = b;
    for (const c of barBtns()) c.tabIndex = c === b ? 0 : -1;
  }

  let dead = false;
  let menuOpen = false;
  let trayOpen = false;
  let hidden = false;
  let hover = false;
  let dragging = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // A bar shown at the bottom edge covers the end of the page, so the page gets room to scroll on.
  const room = createRoom(host.mount, bar);
  const fitRoom = (): void => room.set(edge === 'bottom' && !hidden);

  function confirmClear(on: boolean): void {
    for (const m of main) m.hidden = on;
    for (const m of ask) m.hidden = !on;
    (on ? no : (main[4] as HTMLButtonElement)).focus();
  }

  function openMenu(byKey: boolean): void {
    closeTray(false);
    menuOpen = true;
    menu.hidden = false;
    for (const m of main) m.hidden = false;
    for (const m of ask) m.hidden = true;
    setA(moreB, 'aria-expanded', 'true');
    // Focus moves into the menu only for keyboard users, so a tap never takes
    // focus away from the page.
    if (byKey) (main[0] as HTMLButtonElement).focus();
    wake();
  }

  function closeMenu(refocus: boolean): void {
    if (!menuOpen) return;
    const had = menu.contains(activeIn());
    menuOpen = false;
    menu.hidden = true;
    setA(moreB, 'aria-expanded', 'false');
    if (refocus && had) moreB.focus();
    arm();
  }

  function activeIn(): Element | null {
    const r = root.getRootNode() as Document | ShadowRoot;
    return r.activeElement;
  }

  function toggleTray(byKey: boolean): void {
    if (trayOpen) closeTray(false);
    else openTray(byKey);
  }

  function openTray(byKey = false, focusId?: string): void {
    closeMenu(false);
    trayOpen = true;
    tray.hidden = false;
    setA(trayB, 'aria-expanded', 'true');
    fillTray();
    const r = focusId ? rows.get(focusId) : undefined;
    for (const x of rows.values()) x.li.toggleAttribute('data-on', x === r);
    if (r) {
      r.li.scrollIntoView?.({ block: 'nearest' });
      // Keyboard readers land on the note's first action. A tap leaves focus alone.
      if (byKey) r.li.querySelector('button')?.focus();
    } else if (byKey) trayClose.focus();
    wake();
  }

  function closeTray(refocus: boolean): void {
    if (!trayOpen) return;
    const had = tray.contains(activeIn());
    trayOpen = false;
    tray.hidden = true;
    setA(trayB, 'aria-expanded', 'false');
    if (had && refocus) (host.state().tray ? trayB : moreB).focus();
    trayB.hidden = host.state().tray === 0 && !host.state().held;
    arm();
  }

  // ---------------------------------------------------------------------------
  // Auto hide

  function canHide(): boolean {
    const s = host.state();
    const focusIn = root.contains(activeIn());
    return (
      !s.draw &&
      !s.placing &&
      s.selected.length === 0 &&
      !menuOpen &&
      !trayOpen &&
      !hover &&
      !dragging &&
      !focusIn
    );
  }

  function setHidden(h: boolean): void {
    if (h === hidden) return;
    hidden = h;
    root.classList.toggle('hid', h);
    setA(hdl, 'aria-hidden', h ? null : 'true');
    hdl.tabIndex = h ? 0 : -1;
    fitRoom();
  }

  // One timer, restarted by activity. Nothing polls: if the bar cannot hide
  // when the timer fires, the next change that allows it calls arm() again.
  function arm(): void {
    if (dead) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const ms = host.barHideMs;
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (canHide()) setHidden(true);
    }, ms);
  }

  function wake(): void {
    setHidden(false);
    arm();
  }

  // ---------------------------------------------------------------------------
  // Tray content

  const rows = new Map<string, { li: HTMLLIElement; meta: HTMLElement; item: TrayItem }>();
  const where = (y: number) => (y < 0.33 ? 'near the top' : y < 0.67 ? 'near the middle' : 'near the end');

  function row(it: TrayItem): HTMLLIElement {
    const li = mk('li');
    const pic = mk('div', 'pic');
    pic.setAttribute('role', 'img');
    pic.setAttribute('aria-label', 'Picture of the note');
    if (it.thumb && /^data:image\//i.test(it.thumb)) {
      // Only inline data images. A remote address would be a network read.
      const img = mk('img');
      img.alt = '';
      img.src = it.thumb;
      pic.append(img);
    }
    pic.append(inkThumb(doc, it.note, host.cssColor));
    const body = mk('div');
    const q = mk('p', 'q', it.quote ? `“${it.quote}”` : 'No saved words.');
    const meta = mk('p', 'meta');
    body.append(q, meta);
    if (it.link) {
      const safe = /^https?:\/\//i.test(it.link);
      const a = mk(safe ? 'a' : 'span', 'lnk', it.link);
      if (a instanceof HTMLAnchorElement) {
        a.href = it.link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      body.append(a);
    }
    const acts = mk('div', 'acts');
    const id = it.note.id;
    acts.append(
      btn('Place this note', 'Place this note', '', () => startPlace(id), 'pri', 'Place'),
      btn('Delete this note', 'Delete this note', '', () => host.cmd.deleteNotes([id]), '', 'Delete'),
    );
    body.append(acts);
    li.append(pic, body);
    rows.set(id, { li, meta, item: it });
    return li;
  }

  function fillTray(): void {
    const all = host.tray();
    const seen = new Set<string>();
    const put = (items: TrayItem[], into: HTMLUListElement) =>
      items.forEach((it, i) => {
        const id = it.note.id;
        seen.add(id);
        let r = rows.get(id);
        if (r && r.item.note !== it.note) {
          dropRow(id);
          r = undefined;
        }
        const li = r?.li ?? row(it);
        const meta = rows.get(id)?.meta as HTMLElement;
        const state =
          it.state === 'waiting'
            ? 'Waiting for the page'
            : it.state === 'translated'
              ? 'Back with the original'
              : 'Passage not found';
        const text = `${state}, ${where(it.relY)}.`;
        if (meta.textContent !== text) meta.textContent = text;
        if (into.children[i] !== li) into.insertBefore(li, into.children[i] ?? null);
      });
    const held = all.filter((it) => it.state === 'translated');
    put(
      all.filter((it) => it.state !== 'translated'),
      list,
    );
    put(held, heldList);
    for (const id of [...rows.keys()]) if (!seen.has(id)) dropRow(id);
    heldHd.hidden = heldList.hidden = held.length === 0;
    empty.hidden = all.length > 0;
  }

  function dropRow(id: string): void {
    const r = rows.get(id);
    if (!r) return;
    for (const b of r.li.querySelectorAll('button')) actions.delete(b);
    r.li.remove();
    rows.delete(id);
  }

  function startPlace(id: string): void {
    closeTray(false);
    host.cmd.place(id);
  }

  // ---------------------------------------------------------------------------
  // Render from state. Attributes only; nodes are built once above.

  let prev: InkState | undefined;
  let swTheme = '';
  let hiColor = '';

  // The bar and tray follow the ink's theme unless the host gives them their own.
  const schemeMq = host.uiTheme === 'auto' ? win.matchMedia?.('(prefers-color-scheme: dark)') : undefined;
  const barTheme = (s: InkState): string =>
    host.uiTheme === 'light' || host.uiTheme === 'dark'
      ? host.uiTheme
      : schemeMq
        ? schemeMq.matches
          ? 'dark'
          : 'light'
        : s.theme;

  function render(s: InkState): void {
    setA(root, 'data-theme', barTheme(s));
    const hc = isHi(s.color) ? s.color : 'hi-1';
    if (swTheme !== s.theme || hiColor !== hc) {
      swTheme = s.theme;
      hiColor = hc;
      sw1.style.background = host.cssColor('ink-1', 'pen');
      sw2.style.background = host.cssColor('ink-2', 'pen');
      hiSw.style.background = host.cssColor(hc, 'hi');
      // Thumbnails carry theme colours, so they are rebuilt.
      for (const id of [...rows.keys()]) dropRow(id);
      if (trayOpen && prev) fillTray();
    }
    setA(drawB, 'aria-pressed', String(s.draw));
    for (const [b, on] of toolBtns) setA(b, 'aria-pressed', String(on(s)));
    setA(undoB, 'aria-disabled', String(!s.canUndo));
    setA(redoB, 'aria-disabled', String(!s.canRedo));
    const n = s.tray;
    trayB.hidden = n === 0 && !s.held && !trayOpen;
    if (trayB.hidden && rove === trayB) setRove(drawB);
    const ct = n > 99 ? '99+' : String(n);
    if (cnt.textContent !== ct) cnt.textContent = ct;
    cnt.hidden = n === 0;
    setA(trayB, 'aria-label', n ? `Moved notes, ${n}` : 'Moved notes');
    const site = s.off ? 'Turn ink on for this site' : 'Turn ink off for this site';
    setA(siteB, 'aria-label', site);
    setA(siteB, 'title', site);
    const st = siteB.lastElementChild as HTMLElement;
    if (st.textContent !== site) st.textContent = site;
    sel.hidden = s.selected.length === 0;
    ban.hidden = !s.placing;
    wn.hidden = !s.warn;
    setA(wn, 'aria-label', s.warn ?? null);
    setA(wn, 'title', s.warn ?? null);
    if (s.warn && s.warn !== prev?.warn) wake();
    const tip = s.tip && s.tip !== tipGone ? s.tip : undefined;
    const line = s.warn ?? tip;
    if (noteMsg.textContent !== (line ?? '')) noteMsg.textContent = line ?? '';
    noteMsg.hidden = !line;
    notePv.hidden = !s.memoryOnly;
    note.hidden = !line && !s.memoryOnly;
    if (tip && tip !== prev?.tip) wake();
    if (s.placing && trayOpen) closeTray(false);
    // Rows are reused, so a refill is cheap. It also picks up waiting notes that are now missing.
    if (trayOpen) fillTray();

    // Showing the bar never moves focus.
    const busy = s.draw || !!s.placing || s.selected.length > 0;
    const was = prev ? prev.draw || !!prev.placing || prev.selected.length > 0 : false;
    if (busy) setHidden(false);
    if (!prev || busy !== was) arm();
    prev = s;
  }

  // ---------------------------------------------------------------------------
  // Input

  /** Set while an event from the host's front listener is handled: the element under it in our root. */
  let frontAt: Element | null = null;
  const btnOf = (e: Event) => {
    const t = frontAt ?? e.target;
    return t instanceof Element ? t.closest('button') : null;
  };
  let down: HTMLButtonElement | null = null;
  let downAt = { x: 0, y: 0 };
  let eatClick: HTMLButtonElement | null = null;
  let eatUntil = 0;

  /** The hint shown now is gone for good once the reader does anything with the bar. */
  let tipGone: string | undefined;
  function dropTip(): void {
    const t = host.state().tip;
    if (!t || t === tipGone) return;
    tipGone = t;
    render(host.state());
  }

  function activate(b: HTMLButtonElement, byKey: boolean): void {
    const a = actions.get(b);
    if (!a || b.getAttribute('aria-disabled') === 'true') return;
    dropTip();
    a(byKey);
  }

  const onDown = (e: PointerEvent) => {
    const b = btnOf(e);
    down = b && e.pointerType !== 'mouse' ? b : null;
    downAt = { x: e.clientX, y: e.clientY };
    if (b && b !== hdl) wake();
  };
  // Pen and touch act on pointerup so a tap never waits for a click.
  const onUp = (e: PointerEvent) => {
    const b = btnOf(e);
    // A finger that moved was scrolling the list, not tapping.
    const still = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 10;
    if (b && b === down && still && b !== grip && e.pointerType !== 'mouse') {
      eatClick = b;
      eatUntil = performance.now() + 700;
      activate(b, false);
    }
    down = null;
  };
  const onClick = (e: MouseEvent) => {
    const b = btnOf(e);
    if (!b || !root.contains(b)) return;
    if (b === eatClick && performance.now() < eatUntil) {
      eatClick = null;
      return;
    }
    if (b === grip && dragMoved) {
      dragMoved = false;
      return;
    }
    activate(b, e.detail === 0);
  };
  // Pressing a button with a mouse must not take focus from the page.
  const onMouseDown = (e: MouseEvent) => {
    if (btnOf(e)) e.preventDefault();
  };

  let handled: Event | undefined;
  const onRootKey = (e: KeyboardEvent) => {
    const t = e.target as Element;
    if (e.key === 'Escape') {
      handled = e;
      closeTop(true);
      return;
    }
    if (menu.contains(t)) {
      const items = [...menu.querySelectorAll('button')].filter((b) => !b.hidden);
      const i = items.indexOf(t as HTMLButtonElement);
      const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      if (step) {
        e.preventDefault();
        items[(i + step + items.length) % items.length]?.focus();
      } else if (e.key === 'Tab') {
        closeMenu(true);
      }
      handled = e;
      return;
    }
    if (t.parentElement === bar && t instanceof HTMLButtonElement) {
      const bs = barBtns();
      const i = bs.indexOf(t);
      let j = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % bs.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + bs.length) % bs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = bs.length - 1;
      if (j >= 0) {
        e.preventDefault();
        const b = bs[j] as HTMLButtonElement;
        setRove(b);
        b.focus();
        handled = e;
      }
    }
  };

  /** Escape closes the innermost thing that is open. Returns true when it did something. */
  function closeTop(fromUi: boolean): boolean {
    if (menuOpen) {
      closeMenu(true);
      return true;
    }
    if (trayOpen) {
      closeTray(true);
      return true;
    }
    const s = host.state();
    if (s.placing) {
      host.cmd.place(null);
      return true;
    }
    if (s.draw) {
      host.cmd.setDraw(false);
      return true;
    }
    if (fromUi && s.selected.length) {
      host.cmd.clearSelection();
      return true;
    }
    return false;
  }

  const onDocKey = (e: KeyboardEvent) => {
    if (e === handled || e.isComposing) return;
    if (editable(e.composedPath()[0]) || editable(deepActive(doc))) return;
    if (e.key === 'Escape') {
      dropTip();
      if (closeTop(false)) e.preventDefault();
      return;
    }
    const s = host.state();
    if (!s.draw) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        if (s.canRedo) host.cmd.redo();
      } else if (s.canUndo) host.cmd.undo();
      return;
    }
    if (mod || e.altKey) return;
    const t = SHORTCUTS[k];
    if (t) {
      e.preventDefault();
      pickTool(t);
    }
  };

  // Drag the grip to another edge. The bar follows the pointer and never leaves the screen:
  // `lim` is how far it can go each way from where the drag began.
  let dragMoved = false;
  let start = { x: 0, y: 0 };
  let lim = { l: 0, r: 0, t: 0, b: 0 };
  const onGripDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    start = { x: e.clientX, y: e.clientY };
    const r = bar.getBoundingClientRect();
    lim = { l: -r.left, r: win.innerWidth - r.right, t: -r.top, b: win.innerHeight - r.bottom };
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic or already released pointers cannot be captured.
    }
  };
  const onGripMove = (e: PointerEvent) => {
    if (!dragging) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragMoved && Math.hypot(dx, dy) < 6) return;
    dragMoved = true;
    bar.classList.add('drag');
    const x = Math.max(lim.l, Math.min(lim.r, dx));
    const y = Math.max(lim.t, Math.min(lim.b, dy));
    bar.style.transform = `translate(${x}px,${y}px)`;
  };
  const onGripUp = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('drag');
    bar.style.transform = '';
    // A drag the browser took over ends where the bar was. Its last point says nothing.
    if (e.type === 'pointercancel') return;
    if (!dragMoved) {
      // A tap on the grip with a pen or finger moves the bar to the next edge.
      if (e.pointerType !== 'mouse' && e.type === 'pointerup') {
        eatClick = grip;
        eatUntil = performance.now() + 700;
        moveTo(nextEdge());
      }
      return;
    }
    const w = win.innerWidth;
    const h = win.innerHeight;
    const d: [Edge, number][] = [
      ['left', e.clientX],
      ['right', w - e.clientX],
      ['top', e.clientY],
      ['bottom', h - e.clientY],
    ];
    d.sort((a, b) => a[1] - b[1]);
    moveTo((d[0] as [Edge, number])[0]);
  };

  const onEnter = () => {
    hover = true;
    setHidden(false);
    if (timer !== undefined) clearTimeout(timer);
  };
  const onLeave = () => {
    hover = false;
    arm();
  };

  // Only input the browser made counts. A page script can make a click or a key press,
  // never a trusted one, so it cannot press our buttons or undo the reader's ink.
  const real = host.real ?? ((e: Event) => e.isTrusted);
  const gate =
    (fn: EventListener): EventListener =>
    (e) => {
      if (real(e)) fn(e);
    };

  // Each event is handled once, from the front or from our own listeners.
  const doneEvents = new WeakSet<Event>();
  const once =
    (fn: EventListener): EventListener =>
    (e) => {
      if (doneEvents.has(e) || !real(e)) return;
      doneEvents.add(e);
      fn(e);
    };
  /** Front events arrive at the window, aimed at the layer's host. Find our element under them. */
  const fromFront =
    (fn: EventListener) =>
    (e: Event): void => {
      if (doneEvents.has(e) || !real(e)) return;
      const sr = rootOf(host.mount);
      if (!('host' in sr) || e.target !== sr.host) return;
      const m = e as MouseEvent;
      // A click from the keyboard has no position. It is on the focused element.
      const inner =
        e.type === 'click' && m.detail === 0 ? sr.activeElement : sr.elementFromPoint(m.clientX, m.clientY);
      if (!inner || !root.contains(inner)) return;
      doneEvents.add(e);
      frontAt = inner;
      try {
        fn(e);
      } finally {
        frontAt = null;
      }
    };

  type L = [EventTarget, string, EventListener, boolean?];
  const ls: L[] = [
    [root, 'pointerdown', once(onDown as EventListener)],
    [root, 'pointerup', once(onUp as EventListener)],
    [root, 'click', once(onClick as EventListener)],
    [root, 'mousedown', gate(onMouseDown as EventListener)],
    [root, 'keydown', gate(onRootKey as EventListener)],
    [root, 'focusout', () => queueMicrotask(arm)],
    [
      bar,
      'focusin',
      ((e: FocusEvent) => {
        const t = e.target;
        if (t instanceof HTMLButtonElement && t.parentElement === bar) setRove(t);
      }) as EventListener,
    ],
    [bar, 'pointerenter', onEnter],
    [bar, 'pointerleave', onLeave],
    [hdl, 'pointerenter', onEnter],
    [hdl, 'pointerleave', onLeave],
    [tray, 'pointerenter', onEnter],
    [tray, 'pointerleave', onLeave],
    [grip, 'pointerdown', gate(onGripDown as EventListener)],
    [grip, 'pointermove', gate(onGripMove as EventListener)],
    [grip, 'pointerup', gate(onGripUp as EventListener)],
    [grip, 'pointercancel', gate(onGripUp as EventListener)],
    [doc, 'keydown', gate(onDocKey as EventListener)],
  ];
  if (schemeMq) ls.push([schemeMq, 'change', () => render(host.state())]);
  // On pages that stop events at the window, the bar still gets them from the front.
  const offFront = host.front
    ? [
        host.front.on('pointerdown', fromFront(onDown as EventListener)),
        host.front.on('pointerup', fromFront(onUp as EventListener)),
        host.front.on('click', fromFront(onClick as EventListener)),
      ]
    : [];
  for (const [t, n, f] of ls) t.addEventListener(n, f);

  moveTo(edge);
  setRove(drawB);
  hdl.tabIndex = -1;
  hdl.setAttribute('aria-hidden', 'true');
  setA(moreB, 'aria-expanded', 'false');
  setA(trayB, 'aria-expanded', 'false');
  render(host.state());
  const unsub = host.subscribe(render);

  return {
    wake: () => {
      if (!dead) wake();
    },
    openTray: (noteId, byKey) => {
      if (!dead) openTray(byKey ?? false, noteId);
    },
    destroy: () => {
      if (dead) return;
      dead = true;
      unsub();
      if (timer !== undefined) clearTimeout(timer);
      for (const [t, n, f] of ls) t.removeEventListener(n, f);
      for (const f of offFront) f();
      actions.clear();
      rows.clear();
      room.destroy();
      root.remove();
      sheet.remove();
    },
  };
};

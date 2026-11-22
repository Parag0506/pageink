import { rootOf } from '../css';

/**
 * Room at the end of the page. A bar at the bottom edge covers the last lines of a page that
 * is scrolled to its end, and the reader cannot scroll further. While the bar is shown there,
 * one empty box below the page's content lets the page scroll on by the height the bar covers.
 *
 * The box is ours: absolute, hidden, with no input, in the layer's shadow root. No box or
 * style of the page is touched, so the page's layout is the same with the bar shown or
 * hidden. Two kinds of page get no room. A page that locks the document's scrolling is left
 * alone. A page that does not scroll yet gets room only where a new scrollbar takes no
 * space, because a scrollbar that appears would make the page narrower. Where one does
 * appear, the room is taken away again at once and not tried again.
 *
 * Nothing runs on scroll and nothing polls. The box is fitted again when the page, the bar or
 * the window changes size, and when the box itself scrolls into or out of view. The last one
 * covers pages whose own boxes keep their size while the content in them grows.
 */
export interface Room {
  /** True while the bar is shown at the bottom edge. */
  set(on: boolean): void;
  destroy(): void;
}

/** Air between the last line and the bar, in px. */
const GAP = 8;

export function createRoom(mount: HTMLElement, bar: HTMLElement): Room {
  const doc = mount.ownerDocument;
  const win = doc.defaultView ?? window;
  const html = doc.documentElement;
  const box = doc.createElement('div');
  box.className = 'iu-room';
  box.hidden = true;
  // The mount is fixed to the screen. The box must scroll with the page, so it sits beside it.
  const sr = rootOf(mount);
  ('host' in sr ? sr : mount).append(box);
  let on = false;
  /** The page's scrollbar takes space, so room on a page that does not scroll would move its layout. */
  let narrows = false;
  /** Set while a page that does not scroll has room: the space its scrollbar took before. */
  let gutter = -1;

  const fit = (): void => {
    if (!on) return;
    const se = doc.scrollingElement ?? html;
    const y = win.scrollY;
    const taken = (): number => win.innerWidth - se.clientWidth;
    // Some browsers show a new scrollbar a moment after the layout that needs it.
    if (gutter >= 0 && taken() > gutter) narrows = true;
    // Write: park the box where it adds nothing, so the page is measured as it is without it.
    box.hidden = false;
    box.style.top = box.style.height = '0';
    // Read.
    const own = se.scrollHeight;
    const view = se.clientHeight;
    const now = win.scrollY;
    const at = box.getBoundingClientRect().top + now;
    // A bar with no box, as in print, covers nothing.
    const b = bar.getBoundingClientRect();
    const cover = b.height ? view - b.top : 0;
    const flow = (el: Element) => win.getComputedStyle(el).overflowY;
    const of = doc.body && flow(html) === 'visible' ? flow(doc.body) : flow(html);
    const still = own <= view;
    let end = own;
    let room = cover > 0 && of !== 'hidden' && of !== 'clip';
    if (room && still) {
      // A page that does not scroll ends where its content does. Its body is often as tall
      // as the screen whatever it holds, so the boxes inside the body are what counts.
      const all = doc.createRange();
      all.selectNodeContents(doc.body ?? html);
      end = Math.min(own, all.getBoundingClientRect().bottom + now);
      room = !narrows && end + cover + GAP > view;
    }
    gutter = room && still ? taken() : -1;
    // Write.
    if (room) {
      box.style.top = `${end - at}px`;
      box.style.height = `${cover + GAP}px`;
      // The page scrolls now. If that brought a scrollbar that takes space, the room goes.
      if (still && taken() > gutter) narrows = true;
    }
    if (!room || (narrows && still)) {
      box.hidden = true;
      gutter = -1;
    }
    // A reader at the very end is moved up while the box is parked. Put the page back.
    if (win.scrollY !== y) win.scrollTo({ left: win.scrollX, top: y, behavior: 'instant' });
  };

  const Win = win as Window & typeof globalThis;
  const ro = Win.ResizeObserver ? new Win.ResizeObserver(fit) : undefined;
  // One screen of margin: a page that changed without a change of size is measured again
  // before the reader reaches its end.
  const io = Win.IntersectionObserver
    ? new Win.IntersectionObserver(fit, { rootMargin: '100% 0px' })
    : undefined;

  const set = (next: boolean): void => {
    if (next === on) return;
    on = next;
    if (on) {
      win.addEventListener('resize', fit);
      // The body's children too: on a page whose body has a fixed height, they are what grows.
      for (const el of [html, doc.body, ...(doc.body?.children ?? []), bar]) if (el) ro?.observe(el);
      io?.observe(box);
      fit();
    } else {
      win.removeEventListener('resize', fit);
      ro?.disconnect();
      io?.disconnect();
      box.hidden = true;
      gutter = -1;
    }
  };

  return {
    set,
    destroy() {
      set(false);
      box.remove();
    },
  };
}

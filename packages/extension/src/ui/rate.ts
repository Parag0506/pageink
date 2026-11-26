/**
 * The rating line and the plain "Rate PageInk" link in the popup (src/rate.ts has the rule).
 * The line is one quiet sentence with a link and a "No thanks" button, inside the popup only:
 * never on the page being read, never a dialog. It waits while the popup already asks
 * something else, such as the backup prompt. The plain link at the foot of the popup is always
 * there and is not a prompt; while the line shows, the line holds it. Both open this browser's
 * store page in a new tab, and only from the reader's click.
 */
import { NAME } from '../brand';
import { markRate, noteFirst, RATE_PAGES, rateDue, readRate, usage } from '../rate';

export const RATE_TEXT = `Using ${NAME} a lot? A rating helps other people find it.`;

export interface RateView {
  /** The one-time line. */
  line: HTMLElement;
  text: HTMLElement;
  go: HTMLButtonElement;
  no: HTMLButtonElement;
  /** The plain link that is always there. */
  link: HTMLButtonElement;
  /** Holds the plain link; hidden where the build has no store page. */
  foot: HTMLElement;
}

export interface RateDeps {
  area: Pick<chrome.storage.StorageArea, 'get' | 'set'>;
  /** This browser's store page. Empty: no link and no line (Safari). */
  url: string;
  /** The store's page list. Read only when the answer could be yes. */
  pages: () => Promise<readonly { notes: number; updatedAt: number }[]>;
  /** Open the store page in a new tab. */
  open: (url: string) => Promise<unknown>;
  /** Close the popup after the tab opens. */
  close: () => void;
  /** True while the popup shows another ask. The line then waits for a later opening. */
  busy?: () => boolean;
  now?: () => number;
}

/** Wire the link, and show the line when the rule is met. Resolves to whether it shows. */
export async function showRate(v: RateView, d: RateDeps): Promise<boolean> {
  v.line.hidden = true;
  v.foot.hidden = !d.url;
  if (!d.url) return false;
  v.text.textContent = RATE_TEXT;
  const rate = async () => {
    // Recorded first: the popup can close as soon as the tab opens.
    await markRate(d.area, 'rated').catch(() => {});
    v.line.hidden = true;
    await d.open(d.url).catch(() => {});
    d.close();
  };
  v.link.onclick = rate;
  v.go.onclick = rate;
  v.no.onclick = async () => {
    v.line.hidden = true;
    v.foot.hidden = false;
    await markRate(d.area, 'declined').catch(() => {});
  };

  let st = await readRate(d.area).catch(() => ({ done: 'declined' as const }));
  if (st.done) return false;
  const now = (d.now ?? Date.now)();
  const use = usage(await d.pages().catch(() => []));
  if (use.pages > 0 && st.first === undefined) st = await noteFirst(d.area, now).catch(() => st);
  if (use.pages < RATE_PAGES) return false;
  const due = rateDue({ ...use, st, now }) && !d.busy?.();
  v.line.hidden = !due;
  // The line holds the same link, so the plain one steps aside while it shows.
  v.foot.hidden = due;
  return due;
}

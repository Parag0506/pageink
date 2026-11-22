/**
 * The first-run guide opens once per install, at the first moment the reader can see it, and
 * never again.
 *
 * The browser's installed event alone cannot promise that. Chrome, Edge and Firefox send
 * `runtime.onInstalled` with reason "install" once, when the reader adds the extension. Safari
 * decides the reason each time it loads the extension (CONTRACT 4.2): "update" when the version
 * changed, "install" when the extension is loaded while Safari is already running, and no
 * installed event at all when it is loaded as Safari starts. So a reader who turns the
 * extension on in Settings and then opens Safari got no guide, and it came later on top of
 * their page, when Safari loaded the extension again for a change of setting. Turning the
 * extension off and on sent "install" again each time.
 *
 * The rule:
 * 1. A flag in the extension's storage says the guide was shown. It is written before the tab
 *    is opened, so nothing can open the guide a second time. If storage cannot be read or
 *    written, no guide opens.
 * 2. An installed event with reason "install" opens the guide if the flag is not set. Any other
 *    reason is an install that is in use already: the flag is set and nothing opens.
 * 3. Safari only: each start of the background reads the flag. If it is not set, the start
 *    waits a moment for an installed event, then opens the guide itself.
 * 4. The guide never covers a page the reader is using. In Chrome, Edge and Firefox the event
 *    comes as the reader adds the extension, so the guide opens in front. In Safari, and on a
 *    start with no event, it opens in front only when the tab in front is blank. Otherwise it
 *    opens as a tab in the background and the page in front stays.
 */
import type { Api } from '../api';

/** Storage key: `{ at }`, the time the guide was shown or found not to be needed. */
export const WELCOME_KEY = 'welcomed';
export const WELCOME_PAGE = '/options.html#welcome';
/** How long a start waits for the installed event before it decides without one. */
export const WELCOME_GRACE_MS = 2000;

/** Addresses of a tab that shows no page. A tab whose address is hidden counts as a page. */
const BLANK = /^(|about:(blank|newtab|home)|(chrome|edge):\/\/newtab\/?)$/;

export interface FirstRunOpts {
  /** Safari: the installed event does not say when the reader turned the extension on. */
  safari: boolean;
  /** The wait before a start decides by itself. Tests pass their own. */
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Adds the installed listener, and on Safari checks the flag for this start. The listener is
 * added at once, in the first turn of the background, or the browser does not deliver the event.
 * Returns a promise that settles when this start has decided, for tests.
 */
export function keepFirstRun(api: Api, o: FirstRunOpts): Promise<void> {
  const area = api.storage.local;
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const shown = async (): Promise<boolean> => (await area.get(WELCOME_KEY))[WELCOME_KEY] !== undefined;
  const mark = (): Promise<void> => area.set({ [WELCOME_KEY]: { at: (o.now ?? Date.now)() } });
  /** One decision per life of the background, whoever asks first. */
  let decided = false;

  const pageInFront = async (): Promise<boolean> => {
    try {
      const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
      return !!tab && !BLANK.test(tab.url ?? 'hidden');
    } catch {
      return true;
    }
  };

  const open = async (front: boolean): Promise<void> => {
    if (decided) return;
    decided = true;
    try {
      if (await shown()) return;
      await mark();
    } catch {
      return;
    }
    try {
      const active = front || !(await pageInFront());
      await api.tabs.create({ url: api.runtime.getURL(WELCOME_PAGE), active });
    } catch {
      // No window to open it in. The next start tries again.
      await area.remove(WELCOME_KEY).catch(() => {});
    }
  };

  const skip = async (): Promise<void> => {
    if (decided) return;
    decided = true;
    try {
      if (!(await shown())) await mark();
    } catch {
      // Nothing was opened, and nothing will be in this life of the background.
    }
  };

  api.runtime.onInstalled.addListener((d) => {
    void (d.reason === 'install' ? open(!o.safari) : skip());
  });

  if (!o.safari) return Promise.resolve();
  return (async () => {
    try {
      if (await shown()) {
        decided = true;
        return;
      }
    } catch {
      return;
    }
    await wait(WELCOME_GRACE_MS);
    await open(false);
  })();
}

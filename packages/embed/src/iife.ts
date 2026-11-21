// The one-script build. Everything is included and the global is GLOBAL from pageink-core/brand.
// A tag with data-ink mounts at once: <script src="pageink.js" data-ink></script>
import { FORMER_GLOBALS, GLOBAL } from 'pageink-core/brand';
import { autoMount } from './auto';
import type { InkHandle } from './mount';

export { optionsFrom } from './auto';
export * from './index';

/** A function the browser provides, such as Chromium's own `Ink` interface. */
const isNative = (v: unknown): boolean =>
  typeof v === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(v));

/**
 * Old global names still work. Each reads the current global, so it follows a reload
 * of the script. The old build replaced a browser interface of the same name, and so does
 * this. A page that set the old name to something of its own keeps it.
 * Deprecated: the first read logs a note once.
 */
function aliasFormerGlobals(): void {
  const w = window as unknown as Record<string, unknown>;
  for (const old of FORMER_GLOBALS) {
    if (old === GLOBAL) continue;
    const had = Object.getOwnPropertyDescriptor(w, old);
    // An accessor is this alias from an earlier load, or the page's own: leave either.
    if (had?.get || had?.set) continue;
    if (had ? !had.configurable || !isNative(had.value) : old in w) continue;
    let told = false;
    Object.defineProperty(w, old, {
      configurable: true,
      enumerable: false,
      get() {
        if (!told) {
          told = true;
          console.warn(`window.${old} is deprecated. Use window.${GLOBAL}.`);
        }
        return w[GLOBAL];
      },
      set(v: unknown) {
        Object.defineProperty(w, old, { configurable: true, writable: true, value: v });
      },
    });
  }
}
aliasFormerGlobals();

/** The handle made from the script tag, or null when the tag has no data-ink. */
export const auto: InkHandle | null = autoMount(document.currentScript);

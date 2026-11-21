/**
 * The view chunk entry. Loaded when the host has ink, on pen-down or on the
 * draw toggle. Builds ViewerOptions for this frame and keeps the viewer in
 * step with in-page navigation (CONTRACT 6).
 */
import { pageIdentity } from 'pageink-core/anchor';
import { acceptRecord, showsInk } from 'pageink-core/store';
import type {
  HostHooks,
  InkState,
  KV,
  PageIdentity,
  PageRecord,
  Viewer,
  ViewerOptions,
} from 'pageink-core/types';
import { createInkViewer, type InkViewer } from 'pageink-core/view';
import { localKV } from '../adapters/kv';
import type { Api } from '../api';
import type { FramePathReply, ToBackground, TopReply } from '../messages';
import { probeFor } from './diag';
import { pathOf } from './frame-path';
import { type LoaderStart, world } from './modules';
import { watchNavigation } from './nav';

// The first read lives in boot.js, which runs before this file (./boot.ts). Kept here for tests.
export { boot, bootKeys } from './boot';
export { pathOf };

const send = <R>(api: Api, m: ToBackground) => api.runtime.sendMessage(m) as Promise<R>;

/** Closed shadow roots are open to extensions. Chromium and Firefox name it differently. */
export function shadowAccessor(api: Api): (el: Element) => ShadowRoot | null {
  const dom = (api as { dom?: { openOrClosedShadowRoot?(el: HTMLElement): ShadowRoot | null } }).dom;
  return (el) => {
    try {
      const fx = (el as Element & { openOrClosedShadowRoot?(): ShadowRoot | null }).openOrClosedShadowRoot;
      if (fx) return fx.call(el);
      if (dom?.openOrClosedShadowRoot) return dom.openOrClosedShadowRoot(el as HTMLElement);
    } catch {
      // Not an element that can host a shadow root.
    }
    return el.shadowRoot;
  };
}

export function hooksFor(api: Api): HostHooks {
  return {
    captureVisible: () => send<string | undefined>(api, { ink: 'capture' }).catch(() => undefined),
  };
}

/** Options for a subframe: the top page's identity and this frame's place in its parent. */
export async function frameOptions(api: Api): Promise<Pick<ViewerOptions, 'identity' | 'frame'>> {
  const top = await send<TopReply | undefined>(api, { ink: 'top' });
  if (!top?.url) return {};
  const path = await send<FramePathReply>(api, { ink: 'framePath', frameId: top.frameId }).catch(
    () => undefined,
  );
  const url = location.href.split('#')[0]!;
  return { identity: pageIdentity(top.url), frame: { url, path: path ?? { css: '', xpath: '' } } };
}

/** True in a private (incognito) window. Content scripts can read this in every browser that has it. */
export const inPrivate = (api: Api): boolean =>
  !!(api as { extension?: { inIncognitoContext?: boolean } }).extension?.inIncognitoContext;

/** True when the record has notes written inside frames. */
export const hasFrameNotes = (rec: PageRecord | null): boolean => !!rec?.notes.some((n) => n.anchor.frame);

/** Notes on the page, frames included. A note the merge left with no strokes shows nothing. */
const total = (v: InkViewer | undefined, s: InkState): number => {
  const rec = v?.record();
  return rec ? rec.notes.filter(showsInk).length : s.notes;
};

/**
 * A KV that answers a read from items already read, once per key, when it holds every key
 * asked for. Anything else, and every key after its first use or a change, goes to storage.
 */
export function primedKV(kv: KV, items: Record<string, unknown>): KV {
  const known = new Map(Object.entries(items));
  kv.onChange?.((c) => {
    for (const k of Object.keys(c)) known.delete(k);
  });
  return {
    ...kv,
    get(keys) {
      if (!keys.length || !keys.every((k) => known.has(k))) return kv.get(keys);
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const v = known.get(k);
        known.delete(k);
        if (v !== undefined) out[k] = v;
      }
      return Promise.resolve(out);
    },
    set(items) {
      for (const k of Object.keys(items)) known.delete(k);
      return kv.set(items);
    },
    remove(keys) {
      for (const k of keys) known.delete(k);
      return kv.remove(keys);
    },
  };
}

/** True when the check left out a note or a tombstone of the raw record. */
const lostParts = (raw: unknown, rec: PageRecord): boolean => {
  const r = raw as Partial<PageRecord>;
  return r.notes?.length !== rec.notes.length || r.deleted?.length !== rec.deleted.length;
};

/**
 * The stub read these items straight from storage. A page record among them is handed on only
 * as the clean copy the store's own check returns for this page; otherwise it is left out, so
 * the viewer reads it again through the store, which reports it and leaves it alone.
 * Settings and the site index are not passed through raw either: the store checks them on read.
 */
export function checkedPre(pre: Record<string, unknown>, id: PageIdentity): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pre)) {
    if (k.startsWith('p:') && v !== undefined) {
      const rec = acceptRecord(v, id);
      // A record that lost a part in the check goes through the store, which reports it once.
      if (rec && !lostParts(v, rec)) out[k] = rec;
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Timing marks for the bench. Release builds leave them out. */
const benchMarks = (): HostHooks['onTiming'] => {
  if (!__INK_BENCH__) return undefined;
  const p = performance;
  // Measures take times, not mark names: looking a mark up by name walks the page's whole
  // timeline, which would add to the time the bench measures.
  let start = 0;
  return (name, ms) => {
    if (name === 'view.start') start = p.mark('ink:view-start').startTime;
    // Pen-down to the first pixel of the live stroke.
    else if (name === 'live.first') p.measure('ink:pen-first-pixel', { start: p.now() - ms, duration: ms });
    else if (name === 'view.first-ink' || name === 'view.placed') {
      const m = name === 'view.placed' ? 'ink:placed' : 'ink:first-ink';
      p.measure(m, { start, end: p.mark(m).startTime });
    }
  };
};

export async function start(ctx: LoaderStart): Promise<Viewer> {
  const { api, top } = ctx;
  const got = await ctx.pre?.catch(() => undefined);
  // The stub passes on the keys it knows. When it used the boot read, the other keys that read
  // holds come too, so the viewer's first load goes to storage for none of them.
  const early = world().early;
  const raw =
    got && early && early.key in got ? { ...(await early.items.catch(() => undefined)), ...got } : got;
  const pre = raw ? checkedPre(raw, pageIdentity(location.href, document)) : undefined;
  const kv: KV = pre ? primedKV(localKV(api), pre) : localKV(api);
  let viewer: InkViewer | undefined;
  let shown = 0;
  // The action badge. Sent only when the count changes, so a page that never
  // has ink never wakes the background for it.
  const badge = (n: number) => {
    if (!top || n === shown) return;
    shown = n;
    void send(api, { ink: 'badge', n }).catch(() => {});
  };
  const hooks: HostHooks = {
    ...hooksFor(api),
    onTiming: benchMarks(),
    ...(__INK_DIAG__ ? { probe: probeFor(api, 'page') } : {}),
    onState(s) {
      if (s.off) {
        badge(0);
        ctx.off?.();
        return;
      }
      if (viewer) badge(total(viewer, s));
    },
  };
  const opts: ViewerOptions = {
    kv,
    shadowRootOf: shadowAccessor(api),
    hooks,
  };
  // A private window: the viewer keeps ink in memory unless the reader chose to keep it.
  if (inPrivate(api)) opts.private = true;
  if (ctx.front) opts.front = ctx.front;
  if (!top) Object.assign(opts, await frameOptions(api));
  const v = await createInkViewer(opts);
  viewer = v;
  if (!top) return v;

  badge(total(v, v.state()));
  const stops: (() => void)[] = [];
  let waking = false;
  // Frames stay asleep unless this page has notes inside them.
  const frames = () => {
    if (waking || !hasFrameNotes(v.record())) return;
    waking = true;
    stops.push(wakeFrames(api, document));
  };
  frames();
  stops.push(
    watchNavigation(window, () => {
      void v.reload().then(() => {
        frames();
        badge(total(v, v.state()));
      });
    }),
  );
  // A frame note written in another tab arrives through storage.
  const off = kv.onChange?.((c) => {
    if (!waking && Object.keys(c).some((k) => k.startsWith('p:'))) frames();
  });
  if (off) stops.push(off);
  return {
    ...v,
    state: () => {
      const s = v.state();
      return { ...s, notes: total(v, s) };
    },
    destroy() {
      for (const f of stops.splice(0)) f();
      badge(0);
      v.destroy();
    },
  };
}

/**
 * Frames load nothing until the top page with ink wakes them. A frame that
 * is still loading misses the first wake, so each frame load sends another.
 * Frames already awake ignore it.
 */
export function wakeFrames(api: Api, doc: Document): () => void {
  const wake = () => void send(api, { ink: 'wakeFrames' }).catch(() => {});
  if (doc.querySelector('iframe,frame')) wake();
  const onLoad = (e: Event) => {
    const n = (e.target as Element | null)?.localName;
    if (n === 'iframe' || n === 'frame') wake();
  };
  // Frame load events do not bubble, so listen in the capture phase.
  const cap = { capture: true };
  doc.addEventListener('load', onLoad, cap);
  return () => doc.removeEventListener('load', onLoad, cap);
}

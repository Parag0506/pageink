// Chrome trace capture through the DevTools protocol, and the questions the bench asks of it:
// how much main-thread time ran extension script, and which long tasks contained any.
import type { CDPSession } from 'playwright';
import { EXPLAIN_CATEGORIES } from './explain.ts';

export interface TraceEvent {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: {
    name?: string;
    data?: { url?: string; scriptName?: string; functionName?: string; frame?: string };
    beginData?: { frame?: string };
    chrome_extension_id?: { extension_id?: string };
  };
}

// "extensions" carries ScriptInjection::InjectJs and the bindings calls, tagged with the extension id.
// That is the full cost of injecting a content script, world setup included, not only its own code.
const CATEGORIES = [
  'devtools.timeline',
  'extensions',
  'disabled-by-default-devtools.timeline',
  'v8.execute',
  'toplevel',
  '__metadata',
].join(',');

/**
 * What a profile adds: the script stack of each forced layout, sampled script stacks, user timing
 * marks and the frames the compositor asked for. Open the saved file in the DevTools performance panel.
 */
const PROFILE = [
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  'loading',
  'v8',
].join(',');

/**
 * Only the tasks of each thread and the thread names: enough to time every task, and so light
 * that it barely slows the page, unlike the timeline, which stretches long tasks.
 */
const TASKS = ['toplevel', '__metadata'].join(',');

/**
 * The longest task on any renderer main thread of a trace taken with 'tasks', ms. The page's own
 * renderer is the only one doing work during a load; the extension's background is a worker.
 */
export function longestRendererTask(events: TraceEvent[]): number {
  const main = mainThreads(events);
  let worst = 0;
  for (const e of events)
    if (
      e.ph === 'X' &&
      (e.name === 'ThreadControllerImpl::RunTask' || e.name === 'RunTask') &&
      main.has(`${e.pid}:${e.tid}`)
    )
      worst = Math.max(worst, (e.dur ?? 0) / 1000);
  return Math.round(worst * 10) / 10;
}

/** What a timeline adds: user timing marks, paint timing and the frames the compositor asked for. Cheap. */
const TIMELINE = ['disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'loading'].join(',');

/**
 * `stacks` adds the script stack of each forced layout, for finding a cause; `profile` adds sampled
 * script stacks and frames as well. Both slow the page, so measured runs leave them off.
 * `timeline` adds marks and frames only.
 */
export async function startTrace(
  cdp: CDPSession,
  stacks: boolean | 'profile' | 'timeline' | 'tasks' | 'explain' = false,
): Promise<() => Promise<TraceEvent[]>> {
  const events: TraceEvent[] = [];
  const onData = (e: { value: unknown[] }) => {
    events.push(...(e.value as TraceEvent[]));
  };
  cdp.on('Tracing.dataCollected', onData);
  const categories =
    stacks === 'explain'
      ? EXPLAIN_CATEGORIES
      : stacks === 'tasks'
        ? TASKS
        : stacks === 'profile'
          ? `${CATEGORIES},${PROFILE}`
          : stacks === 'timeline'
            ? `${CATEGORIES},${TIMELINE}`
            : stacks
              ? `${CATEGORIES},disabled-by-default-devtools.timeline.stack`
              : CATEGORIES;
  await cdp.send('Tracing.start', { categories, transferMode: 'ReportEvents' });
  return async () => {
    const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    return events;
  };
}

const SCRIPT_EVENTS = new Set([
  'FunctionCall',
  'EvaluateScript',
  'v8.compile',
  'v8.callFunction',
  'TimerFire',
  'EventDispatch',
  'FireAnimationFrame',
  'v8.run',
]);

function urlOf(e: TraceEvent): string {
  return e.args?.data?.url ?? e.args?.data?.scriptName ?? '';
}

/** Main threads of renderer processes. */
function mainThreads(events: TraceEvent[]): Set<string> {
  const s = new Set<string>();
  for (const e of events)
    if (e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
      s.add(`${e.pid}:${e.tid}`);
  return s;
}

export interface Attribution {
  /** Main-thread ms in the extension's script and injection work, overlapping events counted once. */
  inkMs: number;
  /**
   * The part of inkMs on the page's own main thread: the renderer of the top frame, with any frames
   * that share its process. Frames from other sites run in their own processes, on their own main
   * threads, beside the page. NaN when the top frame was not given or not found.
   */
  pageMs: number;
  /** Stub injections into frames in other processes than the page. */
  otherFrames: number;
  inkEvents: number;
  /** Long tasks (over 50 ms) on the main thread that ran extension work. */
  inkLongTasks: number[];
  /** Longest main-thread task of any length that ran extension work, ms. */
  longestInkTask: number;
  /** Time inside the extension's calls in that task, ms, layout they forced included. The rest is the page's own work. */
  longestInkTaskInk: number;
  /** Every long task on the main thread, ms. */
  longTasks: number[];
  /** Every task that ran extension work: its length and the time inside extension calls, ms. */
  inkTasks: { ms: number; inkMs: number }[];
  /** Longest task of any kind on the page's own main thread (every renderer main thread when the page was not given), ms. */
  longestTask: number;
  /** Extension ms per event name, for finding the cause of a cost. */
  byName: Record<string, number>;
  /** Extension ms per script address. */
  byUrl: Record<string, number>;
}

/** Who to count: scripts whose address starts with prefix, and work tagged with the extension id. */
export interface Owner {
  prefix: string;
  id?: string;
}

const isOwn = (e: TraceEvent, o: Owner): boolean => {
  if (SCRIPT_EVENTS.has(e.name) && urlOf(e).startsWith(o.prefix)) return true;
  return !!o.id && e.args?.chrome_extension_id?.extension_id === o.id;
};

/** Owner of the extension whose service worker or page has this address. */
export function ownerOf(url: string): Owner {
  const m = /^chrome-extension:\/\/([^/]+)\//.exec(url);
  return m ? { prefix: m[0], id: m[1] } : { prefix: 'chrome-extension://' };
}

/** Attribute main-thread work to the extension, inside [from, to] (trace µs). */
export function attribute(
  events: TraceEvent[],
  owner: Owner | string = 'chrome-extension://',
  opts: { from?: number; to?: number; mainFrame?: string } = {},
): Attribution {
  const from = opts.from ?? 0;
  const to = opts.to ?? Number.POSITIVE_INFINITY;
  const o: Owner = typeof owner === 'string' ? { prefix: owner } : owner;
  const mains = mainThreads(events);
  const onMain = (e: TraceEvent) => mains.has(`${e.pid}:${e.tid}`) && e.ts >= from && e.ts <= to;
  const ink = events.filter((e) => e.ph === 'X' && onMain(e) && isOwn(e, o)).sort((a, b) => a.ts - b.ts);
  // Union of intervals per thread, so nested and overlapping events count once.
  let inkUs = 0;
  const perThread = new Map<string, number>();
  const ends = new Map<string, number>();
  for (const e of ink) {
    const key = `${e.pid}:${e.tid}`;
    const end = e.ts + (e.dur ?? 0);
    const last = ends.get(key) ?? -1;
    if (end <= last) continue;
    const d = end - Math.max(e.ts, last);
    inkUs += d;
    perThread.set(key, (perThread.get(key) ?? 0) + d);
    ends.set(key, end);
  }
  // The page's thread is the main thread that last parsed or ran script for the top frame. The top
  // frame can move to another process during navigation (a redirect to another site), and it keeps
  // its id, so the first thread that saw it is not always the one that holds the page.
  let pageEv: TraceEvent | undefined;
  if (opts.mainFrame)
    for (const e of events)
      if (
        mains.has(`${e.pid}:${e.tid}`) &&
        (e.args?.data?.frame === opts.mainFrame || e.args?.beginData?.frame === opts.mainFrame) &&
        (!pageEv || e.ts > pageEv.ts)
      )
        pageEv = e;
  const pageKey = pageEv ? `${pageEv.pid}:${pageEv.tid}` : null;
  const otherFrames = ink.filter(
    (e) => e.name === 'ScriptInjection::InjectJs' && pageKey && `${e.pid}:${e.tid}` !== pageKey,
  ).length;
  const byName: Record<string, number> = {};
  const byUrl: Record<string, number> = {};
  for (const e of ink) {
    byName[e.name] = Math.round(((byName[e.name] ?? 0) + (e.dur ?? 0) / 1000) * 100) / 100;
    const u = urlOf(e);
    if (u) byUrl[u] = Math.round(((byUrl[u] ?? 0) + (e.dur ?? 0) / 1000) * 100) / 100;
  }
  // A task can show as two nested events (RunTask inside ThreadControllerImpl::RunTask). Keep the outer one.
  const all = events
    .filter(
      (e) =>
        e.ph === 'X' && (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') && onMain(e),
    )
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  const tasks: TraceEvent[] = [];
  const until = new Map<string, number>();
  for (const t of all) {
    const k = `${t.pid}:${t.tid}`;
    if (t.ts < (until.get(k) ?? -1)) continue;
    tasks.push(t);
    until.set(k, t.ts + (t.dur ?? 0));
  }
  const long = tasks.filter((t) => (t.dur ?? 0) > 50000);
  const runsInk = (t: TraceEvent) =>
    ink.some((e) => e.pid === t.pid && e.tid === t.tid && e.ts >= t.ts && e.ts <= t.ts + (t.dur ?? 0));
  const inkTasks = tasks.filter(runsInk);
  const inkLong = inkTasks.filter((t) => (t.dur ?? 0) > 50000);
  const longest = inkTasks.reduce<TraceEvent | undefined>(
    (m, t) => (!m || (t.dur ?? 0) > (m.dur ?? 0) ? t : m),
    undefined,
  );
  // Extension time inside a task, nested events counted once. Layout an extension call forced
  // runs inside that call, so it is counted with it.
  const inkIn = (t: TraceEvent): number => {
    let us = 0;
    let end = -1;
    for (const e of ink) {
      if (e.pid !== t.pid || e.tid !== t.tid) continue;
      if (e.ts < t.ts || e.ts > t.ts + (t.dur ?? 0)) continue;
      const stop = Math.min(e.ts + (e.dur ?? 0), t.ts + (t.dur ?? 0));
      if (stop <= end) continue;
      us += stop - Math.max(e.ts, end);
      end = stop;
    }
    return us;
  };
  const inLongest = longest ? inkIn(longest) : 0;
  const pageTasks = pageKey ? tasks.filter((t) => `${t.pid}:${t.tid}` === pageKey) : tasks;
  return {
    inkMs: Math.round(inkUs / 10) / 100,
    pageMs: pageKey ? Math.round((perThread.get(pageKey) ?? 0) / 10) / 100 : Number.NaN,
    otherFrames,
    inkEvents: ink.length,
    inkLongTasks: inkLong.map((t) => Math.round((t.dur ?? 0) / 100) / 10),
    longestInkTask: Math.round(inkTasks.reduce((m, t) => Math.max(m, (t.dur ?? 0) / 1000), 0) * 10) / 10,
    longestInkTaskInk: Math.round(inLongest / 100) / 10,
    longTasks: long.map((t) => Math.round((t.dur ?? 0) / 100) / 10),
    inkTasks: inkTasks.map((t) => ({
      ms: Math.round((t.dur ?? 0) / 100) / 10,
      inkMs: Math.round(inkIn(t) / 100) / 10,
    })),
    longestTask: Math.round(pageTasks.reduce((m, t) => Math.max(m, (t.dur ?? 0) / 1000), 0) * 10) / 10,
    byName,
    byUrl,
  };
}

/** Trace timestamp (µs) of the first event, to align windows. */
export function traceStart(events: TraceEvent[]): number {
  return events.reduce((m, e) => (e.ts > 0 && e.ts < m ? e.ts : m), Number.POSITIVE_INFINITY);
}

// What a page load spent its time on before its first contentful paint, from a trace of the whole
// browser. Used when a quick run finds a page painting later with the extension than with the
// control extension: the report then says where the time went, in every process, not only in
// the extension's script on the page's main thread.
import type { TraceEvent } from './trace.ts';

type Ev = TraceEvent & { args?: TraceEvent['args'] & { data?: Record<string, unknown> } };

export interface TaskInfo {
  name: string;
  /** ms from navigation start. */
  start: number;
  ms: number;
  /** The longest events inside the task, with their length in ms. */
  top: string[];
}

export interface ThreadTime {
  process: string;
  thread: string;
  /** ms the thread spent in tasks between navigation start and the first contentful paint. */
  ms: number;
  tasks: number;
}

export interface Explained {
  /** First contentful paint of the main frame, ms from navigation start. Null when not found. */
  fcp: number | null;
  /** Tasks on the page's main thread from navigation start to the first contentful paint. */
  tasks: TaskInfo[];
  /** Time each thread of each process was running tasks in that window, longest first. */
  threads: ThreadTime[];
  /** When the extension's calls left the page (storage reads, messages), ms from navigation start. */
  requests: number[];
  /** When the extension's service worker ran tasks in the window, first and total ms. */
  worker: { first: number | null; ms: number; tasks: number };
  /** Frames the page's main thread produced before the first contentful paint. */
  framesBefore: number;
}

const TASK = new Set(['ThreadControllerImpl::RunTask', 'RunTask']);
const r1 = (x: number) => Math.round(x * 10) / 10;

export function explain(events: TraceEvent[]): Explained {
  const ev = events as Ev[];
  const procName = new Map<number, string>();
  const threadName = new Map<string, string>();
  for (const e of ev) {
    if (e.ph !== 'M') continue;
    if (e.name === 'process_name') procName.set(e.pid, String(e.args?.name ?? ''));
    if (e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, String(e.args?.name ?? ''));
  }
  // The navigation of the page's main frame, and the renderer main thread it ran on.
  const nav = ev
    .filter((e) => {
      const d = (e.args?.data ?? {}) as { isLoadingMainFrame?: boolean; documentLoaderURL?: string };
      return (
        e.name === 'navigationStart' && !!d.isLoadingMainFrame && /^https?:/.test(d.documentLoaderURL ?? '')
      );
    })
    .sort((a, b) => a.ts - b.ts)
    .at(-1);
  const empty: Explained = {
    fcp: null,
    tasks: [],
    threads: [],
    requests: [],
    worker: { first: null, ms: 0, tasks: 0 },
    framesBefore: 0,
  };
  if (!nav) return empty;
  const t0 = nav.ts;
  const key = `${nav.pid}:${nav.tid}`;
  const at = (e: Ev) => r1((e.ts - t0) / 1000);
  const fcpEv = ev
    .filter((e) => e.name === 'firstContentfulPaint' && e.pid === nav.pid && e.ts >= t0)
    .sort((a, b) => a.ts - b.ts)[0];
  const end = fcpEv ? fcpEv.ts : t0 + 10_000_000;
  const inWindow = (e: Ev) => e.ts >= t0 && e.ts <= end;
  const main = ev.filter((e) => `${e.pid}:${e.tid}` === key);
  const tasks: TaskInfo[] = main
    .filter((e) => e.ph === 'X' && TASK.has(e.name) && inWindow(e) && (e.dur ?? 0) >= 500)
    .sort((a, b) => a.ts - b.ts)
    .filter((e, i, xs) => i === 0 || e.ts >= xs[i - 1]!.ts + (xs[i - 1]!.dur ?? 0))
    .map((t) => {
      const hi = t.ts + (t.dur ?? 0);
      const inner = main
        .filter((e) => e !== t && e.ph === 'X' && !TASK.has(e.name) && e.ts >= t.ts && e.ts <= hi)
        .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
        .slice(0, 3)
        .map((e) => `${e.name} ${r1((e.dur ?? 0) / 1000)}`);
      return { name: t.name, start: at(t), ms: r1((t.dur ?? 0) / 1000), top: inner };
    });
  // Busy time per thread: top-level tasks only, so nested ones are not counted twice.
  const busy = new Map<string, { ms: number; tasks: number; first: number }>();
  const lastEnd = new Map<string, number>();
  for (const e of ev
    .filter((x) => x.ph === 'X' && TASK.has(x.name) && inWindow(x))
    .sort((a, b) => a.ts - b.ts)) {
    const k = `${e.pid}:${e.tid}`;
    if (e.ts < (lastEnd.get(k) ?? 0)) continue;
    lastEnd.set(k, e.ts + (e.dur ?? 0));
    const b = busy.get(k) ?? { ms: 0, tasks: 0, first: e.ts };
    b.ms += (e.dur ?? 0) / 1000;
    b.tasks++;
    busy.set(k, b);
  }
  const threads: ThreadTime[] = [...busy]
    .map(([k, b]) => ({
      process: procName.get(Number(k.split(':')[0])) ?? '?',
      thread: threadName.get(k) ?? '?',
      ms: r1(b.ms),
      tasks: b.tasks,
    }))
    .sort((a, b) => b.ms - a.ms);
  const requests = ev
    .filter(
      (e) => inWindow(e) && /SendRequest|SendMessage|OpenMessageChannel/.test(e.name) && e.pid === nav.pid,
    )
    .map(at)
    .sort((a, b) => a - b);
  const workerKeys = [...threadName].filter(([, n]) => n === 'ServiceWorkerThread').map(([k]) => k);
  let wFirst: number | null = null;
  let wMs = 0;
  let wTasks = 0;
  for (const k of workerKeys) {
    const b = busy.get(k);
    if (!b) continue;
    wMs += b.ms;
    wTasks += b.tasks;
    const f = r1((b.first - t0) / 1000);
    wFirst = wFirst === null ? f : Math.min(wFirst, f);
  }
  const framesBefore = main.filter((e) => e.name === 'BeginMainThreadFrame' && inWindow(e)).length;
  return {
    fcp: fcpEv ? at(fcpEv) : null,
    tasks,
    threads,
    requests,
    worker: { first: wFirst, ms: r1(wMs), tasks: wTasks },
    framesBefore,
  };
}

/** The categories an explaining trace takes: the timeline, every thread's tasks, frames and paint timing. */
export const EXPLAIN_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'extensions',
  'toplevel',
  'loading',
  'blink.user_timing',
  'ServiceWorker',
  '__metadata',
].join(',');

/** Loads per arm when a page is explained, after one discarded load each. */
export const EXPLAIN_LOADS = 3;
/** Raw traces kept beside the report, gzip, at most this many bytes in all. */
export const EXPLAIN_MAX_BYTES = 18 * 2 ** 20;

const med = (xs: number[]): number => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return Number.NaN;
  const i = (s.length - 1) / 2;
  return r1((s[Math.floor(i)]! + s[Math.ceil(i)]!) / 2);
};

/**
 * One table per explained page: per arm, medians over its loads of the first contentful paint,
 * the busy time of the page's main thread, of the browser's threads and of the other busiest
 * threads, the extension worker, frames before the paint and when the first extension call left.
 */
export function explainRows(x: Record<string, Record<string, Explained[]>>): string[] {
  const out: string[] = [];
  for (const [page, arms] of Object.entries(x)) {
    out.push(
      `### ${page}`,
      '',
      '| arm | first contentful paint | page main thread | browser main | browser IO | GPU | other busiest threads | extension worker | frames before | first extension call |',
      '| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
    );
    for (const [arm, loads] of Object.entries(arms)) {
      const thread = (proc: RegExp, name: RegExp) =>
        med(
          loads.map((l) =>
            l.threads
              .filter((t) => proc.test(t.process) && name.test(t.thread))
              .reduce((n, t) => n + t.ms, 0),
          ),
        );
      const others = new Map<string, number[]>();
      for (const l of loads)
        for (const t of l.threads) {
          if (/^(CrRendererMain|CrBrowserMain|Chrome_IOThread|CrGpuMain|VizCompositorThread)$/.test(t.thread))
            continue;
          const k = `${t.process}/${t.thread}`;
          others.set(k, [...(others.get(k) ?? []), t.ms]);
        }
      const top = [...others]
        .map(([k, v]) => [k, med(v)] as const)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k} ${v}`)
        .join('; ');
      out.push(
        `| ${arm} | ${med(loads.map((l) => l.fcp ?? Number.NaN))} | ${thread(/Renderer/, /^CrRendererMain$/)} | ${thread(/Browser/, /^CrBrowserMain$/)} | ${thread(/Browser/, /^Chrome_IOThread$/)} | ${thread(/GPU/, /./)} | ${top || 'none'} | ${med(loads.map((l) => l.worker.ms))} | ${med(loads.map((l) => l.framesBefore))} | ${med(loads.map((l) => l.requests[0] ?? Number.NaN))} |`,
      );
    }
    out.push('');
    // The page's main-thread tasks before the paint, in the first load of each arm.
    for (const [arm, loads] of Object.entries(arms)) {
      const l = loads[0];
      if (!l) continue;
      out.push(
        `- ${arm}: ${l.tasks.map((t) => `${t.start}+${t.ms} (${t.top.join(', ')})`).join('; ') || 'no task over 0.5 ms'}`,
      );
    }
    out.push('');
  }
  return out;
}

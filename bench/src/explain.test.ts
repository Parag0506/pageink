import { describe, expect, test } from 'vitest';
import { explain, explainRows } from './explain.ts';
import type { TraceEvent } from './trace.ts';

const ms = 1000;
const meta = (pid: number, tid: number, name: string, kind: 'process_name' | 'thread_name'): TraceEvent => ({
  name: kind,
  cat: '__metadata',
  ph: 'M',
  ts: 0,
  pid,
  tid,
  args: { name },
});
const task = (pid: number, tid: number, start: number, dur: number): TraceEvent => ({
  name: 'ThreadControllerImpl::RunTask',
  cat: 'toplevel',
  ph: 'X',
  ts: start * ms,
  dur: dur * ms,
  pid,
  tid,
});
const ev = (name: string, pid: number, tid: number, start: number, dur?: number, args?: object): TraceEvent =>
  ({
    name,
    cat: 'x',
    ph: dur === undefined ? 'I' : 'X',
    ts: start * ms,
    dur: dur && dur * ms,
    pid,
    tid,
    args,
  }) as TraceEvent;

/** A page whose renderer main thread runs two tasks before its first paint, and a browser busy beside it. */
function trace(): TraceEvent[] {
  const T = 1000;
  return [
    meta(1, 1, 'Browser', 'process_name'),
    meta(1, 2, 'CrBrowserMain', 'thread_name'),
    meta(2, 1, 'Renderer', 'process_name'),
    meta(2, 10, 'CrRendererMain', 'thread_name'),
    meta(3, 1, 'Renderer', 'process_name'),
    meta(3, 30, 'ServiceWorkerThread', 'thread_name'),
    ev('navigationStart', 2, 10, T, undefined, {
      data: { isLoadingMainFrame: true, documentLoaderURL: 'http://127.0.0.1/page.html' },
    }),
    task(2, 10, T + 5, 12),
    ev('ParseHTML', 2, 10, T + 6, 10),
    ev('NativeExtensionBindingsSystem::SendRequest', 2, 10, T + 8, 0.1),
    task(2, 10, T + 30, 20),
    ev('BeginMainThreadFrame', 2, 10, T + 30),
    ev('Layout', 2, 10, T + 31, 15),
    task(1, 2, T + 2, 40),
    task(3, 30, T + 9, 3),
    ev('firstContentfulPaint', 2, 10, T + 52),
    // After the first paint: left out.
    task(2, 10, T + 60, 30),
  ];
}

describe('where a load spent its time before its first paint', () => {
  test('tasks of the page main thread, with what they held, up to the first contentful paint', () => {
    const x = explain(trace());
    expect(x.fcp).toBe(52);
    expect(x.tasks.map((t) => [t.start, t.ms])).toEqual([
      [5, 12],
      [30, 20],
    ]);
    expect(x.tasks[1]!.top[0]).toBe('Layout 15');
    expect(x.framesBefore).toBe(1);
  });

  test('every thread of every process, the browser and the extension worker included', () => {
    const x = explain(trace());
    expect(x.threads[0]).toEqual({ process: 'Browser', thread: 'CrBrowserMain', ms: 40, tasks: 1 });
    expect(x.threads.find((t) => t.thread === 'CrRendererMain')!.ms).toBe(32);
    expect(x.worker).toEqual({ first: 9, ms: 3, tasks: 1 });
    expect(x.requests).toEqual([8]);
  });

  test('a trace with no navigation explains nothing', () => {
    expect(explain([]).fcp).toBeNull();
  });
});

describe('the summary of an explained page', () => {
  test('one row per arm, with medians over the loads', () => {
    const x = explain(trace());
    const rows = explainRows({ lesson: { pageink: [x, x], control: [x] } });
    expect(rows[0]).toBe('### lesson');
    const pi = rows.find((r) => r.startsWith('| pageink'))!;
    expect(pi).toBe('| pageink | 52 | 32 | 40 | 0 | 0 | Renderer/ServiceWorkerThread 3 | 3 | 1 | 8 |');
    expect(rows.filter((r) => r.startsWith('| control'))).toHaveLength(1);
    expect(rows).toContain(
      '- pageink: 5+12 (ParseHTML 10, NativeExtensionBindingsSystem::SendRequest 0.1); 30+20 (Layout 15)',
    );
  });
});

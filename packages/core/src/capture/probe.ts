import type { PointerKind, Probe, StrokeProbe, Tool } from '../types';

/**
 * Counts what capture sees, one gesture at a time, and hands a StrokeProbe to send when each
 * gesture ends. Capture calls it only when the host passes one (CaptureHost.probe), so a
 * build that never makes a probe does not carry this file.
 */
export function createProbe(win: Window, send: (p: StrokeProbe) => void): Probe {
  interface Cur {
    kind: PointerKind;
    tool: Tool;
    t0: number;
    replay: boolean;
    draw: boolean;
    pmin: number;
    pmax: number;
    moves: number;
    coalesced: number;
    predicted: number;
    fingers: number;
    blocked: number;
    scroll0: { x: number; y: number };
    firstPaint: number | null;
    firstFrame: number | null;
  }
  let cur: Cur | null = null;
  /** Stylus touch events since the last probe, and how many were cancelled. */
  let stylus = 0;
  let cancelled = 0;
  const scroll = () => ({ x: win.scrollX, y: win.scrollY });
  const fresh = (kind: PointerKind, tool: Tool, t0: number, replay: boolean, draw: boolean): Cur => ({
    kind,
    tool,
    t0,
    replay,
    draw,
    pmin: Number.POSITIVE_INFINITY,
    pmax: Number.NEGATIVE_INFINITY,
    moves: 0,
    coalesced: 0,
    predicted: 0,
    fingers: 0,
    blocked: 0,
    scroll0: scroll(),
    firstPaint: null,
    firstFrame: null,
  });

  function emit(
    c: Cur,
    outcome: StrokeProbe['outcome'],
    t1: number,
    pts: readonly { t: number }[],
    reason?: StrokeProbe['reason'],
  ): void {
    const a = pts[0]?.t ?? c.t0;
    const b = pts[pts.length - 1]?.t ?? t1;
    const p: StrokeProbe = {
      pointerType: c.kind,
      tool: c.tool,
      outcome,
      draw: c.draw,
      replayed: c.replay,
      t0: c.t0,
      t1,
      samples: pts.length,
      rate: b > a ? Math.round((pts.length - 1) / ((b - a) / 1000)) : 0,
      pressure: c.pmin <= c.pmax ? { min: c.pmin, max: c.pmax } : { min: 0, max: 0 },
      moves: c.moves,
      coalesced: c.coalesced,
      predicted: c.predicted,
      stylusTouches: stylus,
      stylusCancelled: cancelled,
      fingersWhilePen: c.fingers,
      fingersBlocked: c.blocked,
      scroll0: c.scroll0,
      scroll1: scroll(),
      firstPaintMs: c.firstPaint,
      firstFrameMs: c.firstFrame,
    };
    if (reason) p.reason = reason;
    stylus = 0;
    cancelled = 0;
    const go = () => {
      p.firstFrameMs = c.firstFrame;
      try {
        send(p);
      } catch {
        // A probe must never break input.
      }
    };
    // A short stroke can end before the frame after its first paint. That frame callback was
    // asked for first, so one asked for now runs right after it.
    if (c.firstPaint !== null && c.firstFrame === null) win.requestAnimationFrame(go);
    else go();
  }

  return {
    start(kind, tool, t0, replay, draw) {
      cur = fresh(kind, tool, t0, replay, draw);
    },
    skip(tool, t, reason, draw) {
      emit(fresh('pen', tool, t, false, draw), 'skip', t, [], reason);
    },
    raw(list) {
      if (!cur) return;
      for (const q of list) {
        if (q.pressure < cur.pmin) cur.pmin = q.pressure;
        if (q.pressure > cur.pmax) cur.pmax = q.pressure;
      }
    },
    move(n) {
      if (!cur) return;
      cur.moves++;
      cur.coalesced += n;
    },
    paint(n) {
      const c = cur;
      if (!c) return;
      c.predicted += n;
      if (c.firstPaint !== null) return;
      c.firstPaint = Math.round(win.performance.now() - c.t0);
      win.requestAnimationFrame(() => {
        c.firstFrame = Math.round(win.performance.now() - c.t0);
      });
    },
    palm(kept) {
      if (!cur) return;
      cur.fingers++;
      if (kept) cur.blocked++;
    },
    touch(wasCancelled) {
      stylus++;
      if (wasCancelled) cancelled++;
    },
    end(outcome, t1, pts) {
      const c = cur;
      cur = null;
      if (c) emit(c, outcome, t1, pts);
    },
  };
}

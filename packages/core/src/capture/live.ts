import { outline } from '../strokes';
import type { Sample, StrokeTool, Tool } from '../types';

export interface LiveStyle {
  tool: StrokeTool;
  color: string;
  w: number;
}

interface Done {
  path: Path2D;
  style: LiveStyle;
}

/** Radius of the eraser ring, CSS px. */
const ERASER_RING = 8;

/**
 * The live stroke canvas. Viewport sized, fixed, never takes pointer events.
 * Samples here are client coordinates. Finished strokes stay painted until
 * clear(), so a stroke does not blink out before its SVG is on screen.
 */
export class LiveCanvas {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private done: Done[] = [];
  private w = 0;
  private h = 0;
  private dpr = 1;

  constructor(
    private readonly win: Window,
    mount: ShadowRoot,
  ) {
    const doc = mount.ownerDocument;
    const el = doc.createElement('canvas');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483647;touch-action:none;';
    mount.append(el);
    this.el = el;
  }

  /** Match the viewport and device pixel ratio. Called at the start of a gesture. */
  fit(): void {
    const w = this.win.innerWidth;
    const h = this.win.innerHeight;
    const dpr = this.win.devicePixelRatio || 1;
    if (w === this.w && h === this.h && dpr === this.dpr && this.ctx) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.el.width = Math.max(1, Math.round(w * dpr));
    this.el.height = Math.max(1, Math.round(h * dpr));
    this.el.style.width = `${w}px`;
    this.el.style.height = `${h}px`;
    // desynchronized lets the browser show pixels without waiting for the page compositor.
    this.ctx = this.el.getContext('2d', { desynchronized: true }) ?? this.el.getContext('2d');
    this.wipe();
    this.redrawDone();
  }

  /** Paint the gesture in progress. predicted samples are drawn but never kept. */
  draw(tool: Tool, style: LiveStyle, pts: Sample[], predicted: Sample[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.wipe();
    this.redrawDone();
    const all = predicted.length ? pts.concat(predicted) : pts;
    if (!all.length) return;
    if (tool === 'eraser') {
      const p = all[all.length - 1] as Sample;
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(128,128,128,0.9)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, ERASER_RING, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (tool === 'lasso') {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(90,90,90,0.9)';
      ctx.beginPath();
      for (let i = 0; i < all.length; i++) {
        const p = all[i] as Sample;
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      }
      ctx.stroke();
      ctx.restore();
      return;
    }
    this.fill(new Path2D(outline(all, style)), style);
  }

  /** Keep the finished stroke painted until clear(). */
  finish(tool: Tool, style: LiveStyle, pts: Sample[]): void {
    if (tool === 'pen' || tool === 'hi') {
      if (pts.length) this.done.push({ path: new Path2D(outline(pts, style)), style });
    }
    this.wipe();
    this.redrawDone();
  }

  /** Drop everything. */
  clear(): void {
    this.done = [];
    this.wipe();
  }

  remove(): void {
    this.clear();
    this.el.remove();
  }

  private fill(path: Path2D, style: LiveStyle): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.save();
    ctx.fillStyle = style.color;
    // The highlighter shows the text under it while live, like the committed one.
    if (style.tool === 'hi') ctx.globalAlpha = 0.4;
    ctx.fill(path);
    ctx.restore();
  }

  private wipe(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.el.width, this.el.height);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private redrawDone(): void {
    for (const d of this.done) this.fill(d.path, d.style);
  }
}

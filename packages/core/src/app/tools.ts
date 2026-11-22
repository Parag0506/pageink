/**
 * The tools chunk: capture, the bar and tray, grouping, eraser, lasso, history
 * and the commands. Loaded on a pen touch or the draw toggle.
 */
import { describe, describeRange } from '../anchor/describe';
import { recognizeTextMark } from '../anchor/mark';
import { createCapture } from '../capture/capture';
import { newId } from '../hash';
import { createHistory } from '../notes/history';
import { joinNotes, lassoSelect, moveNote, pickNote, splitNote } from '../notes/index';
import { svgToPng } from '../render/png';
import { toMarkdown } from '../store/markdown';
import { erasePatch } from '../store/patch';
import { decodePts } from '../strokes/codec';
import { hitStroke, makeStroke, strokeBBox } from '../strokes/stroke';
import type {
  Anchor,
  AttachTools,
  Described,
  Gesture,
  GroupCandidate,
  InkColor,
  InkCommands,
  InkConfig,
  LassoItem,
  Note,
  Patch,
  Placed,
  Point,
  Rect,
  Sample,
  Stroke,
  StrokeTool,
  Tool,
} from '../types';
import { createUi } from '../ui/ui';

/** Eraser reach around the pointer, CSS px. Matches the ring drawn by capture. */
const ERASER_R = 8;
/** Thumbnails for viewport anchors stay under this many characters. FORMAT says 8 KB. */
const THUMB_MAX = 8 * 1024;
/** A tap may move this far and still be a tap. */
const TAP_PX = 6;
/** Notes stay grouping candidates this long after their last stroke. */
const RECENT_MS = 3000;
/** Longest text copied for chat. */
const CHAT_TEXT_MAX = 6000;
/** The one-line hint after the reader's first ink. Shown once, ever. */
export const FIRST_HINT = 'Your ink stays on this page. Tap the tray to see moved notes.';

// Tool and colour choices last for the page session, across viewers.
const session: { tool: Tool; pen: InkColor; hi: InkColor } = { tool: 'pen', pen: 'ink-1', hi: 'hi-1' };

/** Forget the session choices. For tests. */
export const resetToolSession = (): void => {
  session.tool = 'pen';
  session.pen = 'ink-1';
  session.hi = 'hi-1';
};

const isHiColor = (c: InkColor): boolean => c.startsWith('hi');

function boxOf(samples: Sample[], pad: number): Rect {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const s of samples) {
    x0 = Math.min(x0, s.x);
    y0 = Math.min(y0, s.y);
    x1 = Math.max(x1, s.x);
    y1 = Math.max(y1, s.y);
  }
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
}

function unionRect(rs: Rect[]): Rect | null {
  if (!rs.length) return null;
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rs) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const inside = (r: Rect, p: Point, pad = 0): boolean =>
  p.x >= r.x - pad && p.x <= r.x + r.w + pad && p.y >= r.y - pad && p.y <= r.y + r.h + pad;

/** Stroke bounding box in document space at a pose. */
function docBox(s: Stroke, pl: Pick<Placed, 'origin' | 'scale'>): Rect {
  const b = strokeBBox(s);
  return {
    x: pl.origin.x + b.x * pl.scale,
    y: pl.origin.y + b.y * pl.scale,
    w: b.w * pl.scale,
    h: b.h * pl.scale,
  };
}

function mergePatch(into: Patch, p: Patch): void {
  if (p.add?.length) into.add = [...(into.add ?? []), ...p.add];
  if (p.addStrokes?.length) into.addStrokes = [...(into.addStrokes ?? []), ...p.addStrokes];
  if (p.update?.length) into.update = [...(into.update ?? []), ...p.update];
  if (p.del?.length) into.del = [...(into.del ?? []), ...p.del];
}

/** Decode a data URL without any network API. */
function dataUrlBlob(url: string): Blob | null {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const type = m[1] ?? 'application/octet-stream';
  if (!m[2]) return new Blob([decodeURIComponent(m[3] ?? '')], { type });
  const bin = atob(m[3] ?? '');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function loadImage(doc: Document, src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = doc.createElement('img');
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The picture could not be read.'));
    img.src = src;
  });
}

export const attachTools: AttachTools = (v) => {
  const { doc, layer, placer, store, config, ctx } = v;
  const win = (doc.defaultView ?? window) as Window & typeof globalThis;
  const hooks = v.opts.hooks ?? {};
  const history = createHistory();
  let dead = false;

  // ---- state helpers -----------------------------------------------------------

  /** Settings this chunk writes. The store keeps only the fields given, so defaults stay out. */
  const saveConfig = (patch: Partial<InkConfig>): Promise<unknown> => store.setConfig(patch);

  const colorFor = (t: Tool): InkColor => (t === 'hi' ? session.hi : session.pen);
  const strokeTool = (t: Tool): StrokeTool => (t === 'hi' ? 'hi' : 'pen');
  v.setState({ tool: session.tool, color: colorFor(session.tool) });

  const notesById = (): Map<string, Note> => new Map(v.record().notes.map((n) => [n.id, n]));
  const withFrame = (a: Anchor): Anchor => (v.opts.frame ? { ...a, frame: v.opts.frame } : a);
  const described = (d: Described): Described => ({ ...d, anchor: withFrame(d.anchor) });

  const syncHistory = (): void => {
    const canUndo = history.canUndo();
    const canRedo = history.canRedo();
    const s = v.state();
    if (s.canUndo !== canUndo || s.canRedo !== canRedo) v.setState({ canUndo, canRedo });
  };

  /** A change the reader can undo. */
  const commit = (patch: Patch, known?: Record<string, { origin: Point; scale: number }>): void => {
    const before = v.record();
    v.commit(patch, known);
    history.record(patch, before);
    syncHistory();
  };

  const clearLiveSoon = (): void => {
    // Two frames: the committed SVG is painted before the live canvas is wiped.
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => capture.clearLive()));
  };

  // ---- selection -----------------------------------------------------------------

  let selNotes: string[] = [];
  let selStrokes = new Set<string>();
  const select = (notes: string[], strokes: Iterable<string>): void => {
    selNotes = notes;
    selStrokes = new Set(strokes);
    layer.setSelected(notes);
    v.setState({ selected: notes });
  };
  const clearSelection = (): void => {
    if (selNotes.length || v.state().selected.length) select([], []);
  };

  // ---- writing ---------------------------------------------------------------------

  /** Notes written lately, for grouping (DESIGN 7.1). lastEnd is performance time. */
  const recent = new Map<string, { lastEnd: number; tool: StrokeTool }>();

  const candidates = (now: number): GroupCandidate[] => {
    const out: GroupCandidate[] = [];
    for (const [id, r] of recent) {
      if (now - r.lastEnd > RECENT_MS) {
        recent.delete(id);
        continue;
      }
      const pl = placer.get(id);
      if (pl) out.push({ id, bbox: pl.bbox, lastEnd: r.lastEnd, tool: r.tool });
    }
    return out;
  };

  const write = (g: Gesture): void => {
    const tool = strokeTool(g.tool);
    const color = colorFor(g.tool);
    const w = tool === 'hi' ? config.hiW : config.penW;
    const samples = g.samples;
    if (!samples.length) return;

    // A straight line over text is a text mark that rewraps with it (DESIGN 7.3).
    const tm = samples.length > 1 ? recognizeTextMark(ctx, samples, tool) : null;
    if (tm) {
      const d = describeRange(ctx, tm.range);
      const now = Date.now();
      const note: Note = {
        id: newId(),
        createdAt: now,
        updatedAt: now,
        device: config.device,
        kind: 'textmark',
        anchor: withFrame(d.anchor),
        frame: d.frame,
        strokes: [],
        mark: { style: tm.style, color },
      };
      commit({ add: [note] });
      clearLiveSoon();
      firstInk();
      return;
    }

    const bbox = boxOf(samples, w / 2);
    const join = pickNote({ t0: g.t0, bbox, tool }, candidates(g.t0));
    const pl = join ? placer.get(join) : undefined;
    if (join && pl) {
      const stroke = makeStroke(samples, pl.origin, { tool, color, w: w / pl.scale }, { scale: pl.scale });
      commit(
        { addStrokes: [{ note: join, strokes: [stroke] }] },
        { [join]: { origin: pl.origin, scale: pl.scale } },
      );
      recent.set(join, { lastEnd: g.t1, tool });
      clearLiveSoon();
      return;
    }

    const d = describe(ctx, bbox, { tool });
    const stroke = makeStroke(samples, d.origin, { tool, color, w });
    const now = Date.now();
    const note: Note = {
      id: newId(),
      createdAt: now,
      updatedAt: now,
      device: config.device,
      kind: 'ink',
      anchor: withFrame(d.anchor),
      frame: d.frame,
      strokes: [stroke],
    };
    commit({ add: [note] }, { [note.id]: { origin: d.origin, scale: 1 } });
    recent.set(note.id, { lastEnd: g.t1, tool });
    clearLiveSoon();
    if (d.anchor.type === 'viewport' && config.thumbs !== false) void addThumb(note.id, bbox);
    firstInk();
  };

  /** The first ink this reader ever writes gets a one-line hint. It is never shown again. */
  let hinted = !!config.hinted;
  const firstInk = (): void => {
    if (hinted) return;
    hinted = true;
    v.setState({ tip: FIRST_HINT });
    void store
      .config()
      .then((c) => (c.hinted ? undefined : saveConfig({ hinted: true })))
      .catch(() => {});
  };

  /** Small picture of what was under a viewport note. At most THUMB_MAX characters. */
  const addThumb = async (noteId: string, box: Rect): Promise<void> => {
    if (!hooks.captureVisible) return;
    try {
      // Wait for the live stroke to clear, so the picture shows the page. The browser can refuse a
      // picture for a moment (Chrome gives two a second), so an empty answer is asked for again.
      let url: string | undefined;
      for (const wait of [120, 600, 1500]) {
        await new Promise((r) => win.setTimeout(r, wait));
        if (dead) return;
        url = await hooks.captureVisible().catch(() => undefined);
        if (url) break;
      }
      if (!url || dead) return;
      const img = await loadImage(doc, url);
      const k = img.naturalWidth / (win.innerWidth || img.naturalWidth || 1);
      const pad = 24;
      const sx = Math.max(0, (box.x - win.scrollX - pad) * k);
      const sy = Math.max(0, (box.y - win.scrollY - pad) * k);
      const sw = Math.min(img.naturalWidth - sx, (box.w + 2 * pad) * k);
      const sh = Math.min(img.naturalHeight - sy, (box.h + 2 * pad) * k);
      if (sw <= 0 || sh <= 0) return;
      let thumb = '';
      for (const max of [160, 120, 80, 56]) {
        const f = Math.min(1, max / Math.max(sw, sh));
        const c = doc.createElement('canvas');
        c.width = Math.max(1, Math.round(sw * f));
        c.height = Math.max(1, Math.round(sh * f));
        const g2 = c.getContext('2d');
        if (!g2) return;
        g2.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
        for (const q of [0.7, 0.5, 0.35]) {
          const t = c.toDataURL('image/jpeg', q);
          if (t.length <= THUMB_MAX) {
            thumb = t;
            break;
          }
        }
        if (thumb) break;
      }
      const note = notesById().get(noteId);
      if (!thumb || !note || dead || config.thumbs === false) return;
      // Not an undo step: the reader did not do this.
      v.commit({ update: [{ ...note, thumb }] });
    } catch {
      // A note without a thumbnail is still a note.
    }
  };

  // ---- eraser ----------------------------------------------------------------------

  let erase: { hit: Set<string>; done: number; marks: Map<string, Rect[]>; byId: Map<string, Note> } | null =
    null;

  const markRects = (n: Note): Rect[] => {
    const r = v.resolver.resolve(n.anchor, n.frame);
    if (!r?.range) return [];
    const out: Rect[] = [];
    for (const c of r.range.getClientRects()) {
      if (c.width > 0 && c.height > 0)
        out.push({ x: c.left + win.scrollX, y: c.top + win.scrollY, w: c.width, h: c.height });
    }
    return out;
  };

  const eraseAt = (p: Point): void => {
    if (!erase) return;
    for (const pl of placer.all()) {
      if (!inside(pl.bbox, p, ERASER_R)) continue;
      const n = erase.byId.get(pl.id);
      if (!n) continue;
      if (n.kind === 'textmark') {
        if (erase.hit.has(n.id)) continue;
        let rs = erase.marks.get(n.id);
        if (!rs) {
          rs = markRects(n);
          erase.marks.set(n.id, rs);
        }
        if (rs.some((r) => inside(r, p, ERASER_R / 2))) erase.hit.add(n.id);
        continue;
      }
      const local = placer.toLocal(pl.id, p);
      if (!local) continue;
      const r = ERASER_R / pl.scale;
      for (const s of n.strokes) if (!erase.hit.has(s.id) && hitStroke(s, local, r)) erase.hit.add(s.id);
    }
  };

  const eraseAlong = (samples: Sample[]): void => {
    if (!erase) return;
    const before = erase.hit.size;
    for (let i = erase.done; i < samples.length; i++) {
      const b = samples[i]!;
      const a = samples[i - 1] ?? b;
      // Fill gaps of fast moves so a thin stroke is not skipped.
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (ERASER_R / 2)));
      for (let k = 1; k <= steps; k++) {
        const f = k / steps;
        eraseAt({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      }
    }
    erase.done = samples.length;
    if (erase.hit.size !== before) layer.setHidden([...erase.hit]);
  };

  // ---- lasso -------------------------------------------------------------------------

  /**
   * One note in a drag. When only some of its strokes are selected, `part` holds them under a
   * stand-in id and `rest` the strokes that stay, so only the selection moves under the pen.
   */
  interface DragItem {
    note: Note;
    pl: Placed;
    part?: Note;
    rest?: Note;
  }
  let drag: { from: Point; d: Point; notes: DragItem[] } | null = null;

  /** Put a dragged note back the way it was before the drag. */
  const undrag = (it: DragItem): void => {
    if (it.part) {
      layer.removeNote(it.part.id);
      layer.drawNote(it.note, { origin: it.pl.origin, scale: it.pl.scale });
    }
    placer.upsert(it.note);
  };

  const lassoItems = (): LassoItem[] => {
    const byId = notesById();
    const out: LassoItem[] = [];
    for (const pl of placer.all()) {
      const n = byId.get(pl.id);
      if (n?.kind !== 'ink') continue;
      for (const s of n.strokes) {
        const raw = decodePts(s.pts);
        const step = Math.max(1, Math.floor(raw.length / 24));
        const pts: Point[] = [];
        for (let i = 0; i < raw.length; i += step) {
          const q = raw[i]!;
          pts.push({ x: pl.origin.x + q.x * pl.scale, y: pl.origin.y + q.y * pl.scale });
        }
        out.push({ note: n.id, stroke: s.id, bbox: docBox(s, pl), pts });
      }
    }
    return out;
  };

  const lassoEnd = (g: Gesture): void => {
    const sel = lassoSelect(
      g.samples.map((s) => ({ x: s.x, y: s.y })),
      lassoItems(),
    );
    const notes = [...sel.wholeNotes, ...sel.partialNotes];
    select(notes, sel.strokes);
  };

  const startDrag = (at: Point): void => {
    drag = null;
    if (!selNotes.length) return;
    const byId = notesById();
    const list: DragItem[] = [];
    let hit = false;
    for (const id of selNotes) {
      const note = byId.get(id);
      const pl = placer.get(id);
      if (!note || !pl) continue;
      const it: DragItem = { note, pl: { ...pl } };
      const take = note.strokes.filter((s) => selStrokes.has(s.id));
      if (take.length && take.length < note.strokes.length) {
        it.part = { ...note, id: `${note.id}:drag`, strokes: take };
        it.rest = { ...note, strokes: note.strokes.filter((s) => !selStrokes.has(s.id)) };
      }
      list.push(it);
      if (inside(pl.bbox, at, 6)) hit = true;
    }
    if (hit) drag = { from: at, d: { x: 0, y: 0 }, notes: list };
  };

  const dragMove = (g: Gesture): void => {
    if (!drag) return;
    const last = g.samples[g.samples.length - 1];
    if (!last) return;
    drag.d = { x: last.x - drag.from.x, y: last.y - drag.from.y };
    for (const { note, pl, part, rest } of drag.notes) {
      const at = { origin: { x: pl.origin.x + drag.d.x, y: pl.origin.y + drag.d.y }, scale: pl.scale };
      if (part && rest) {
        layer.drawNote(rest, { origin: pl.origin, scale: pl.scale });
        layer.drawNote(part, at);
      } else layer.drawNote(note, at);
    }
  };

  /** Patch that re-anchors the chosen strokes of a note, shifted by d, at the place they land. */
  const relocate = (note: Note, pl: Pick<Placed, 'origin' | 'scale'>, ids: string[], d: Point) => {
    const take = note.strokes.filter((s) => ids.includes(s.id));
    const box = unionRect(take.map((s) => docBox(s, pl)));
    if (!box) return null;
    const moved = { x: box.x + d.x, y: box.y + d.y, w: box.w, h: box.h };
    const to = described(describe(ctx, moved, { tool: take[0]?.tool ?? 'pen' }));
    const shift = {
      dx: (pl.origin.x + d.x - to.origin.x) / pl.scale,
      dy: (pl.origin.y + d.y - to.origin.y) / pl.scale,
      scale: pl.scale,
    };
    const whole = take.length === note.strokes.length;
    const patch = whole ? moveNote(note, to, shift) : splitNote(note, ids, to, shift);
    const added = patch.add?.[0];
    return added ? { patch, added, origin: to.origin } : null;
  };

  const dragEnd = (): void => {
    const dr = drag;
    drag = null;
    if (!dr) return;
    if (Math.hypot(dr.d.x, dr.d.y) < TAP_PX) {
      for (const it of dr.notes) undrag(it);
      return;
    }
    const patch: Patch = {};
    const known: Record<string, { origin: Point; scale: number }> = {};
    const fresh: Note[] = [];
    const moved: DragItem[] = [];
    for (const it of dr.notes) {
      const { note, pl } = it;
      const ids = note.strokes.filter((s) => selStrokes.has(s.id)).map((s) => s.id);
      const r = relocate(note, pl, ids, dr.d);
      if (!r) {
        undrag(it);
        continue;
      }
      moved.push(it);
      mergePatch(patch, r.patch);
      known[r.added.id] = { origin: r.origin, scale: 1 };
      fresh.push(r.added);
    }
    commit(patch, known);
    // The strokes that stayed are already drawn where they belong. The stand-ins go.
    for (const it of moved) if (it.part) layer.removeNote(it.part.id);
    select(
      fresh.map((n) => n.id),
      fresh.flatMap((n) => n.strokes.map((s) => s.id)),
    );
  };

  const joinSelected = (): void => {
    const byId = notesById();
    const list = selNotes
      .map((id) => ({ note: byId.get(id), pl: placer.get(id) }))
      .filter((x): x is { note: Note; pl: Placed } => !!x.note && !!x.pl && x.note.kind === 'ink');
    if (list.length < 2) return;
    list.sort((a, b) => a.note.createdAt - b.note.createdAt);
    const target = list[0]!;
    const others = list.slice(1).map(({ note, pl }) => ({
      note,
      dx: (pl.origin.x - target.pl.origin.x) / pl.scale,
      dy: (pl.origin.y - target.pl.origin.y) / pl.scale,
      scale: pl.scale / target.pl.scale,
    }));
    const patch = joinNotes(target.note, others);
    commit(patch, { [target.note.id]: { origin: target.pl.origin, scale: target.pl.scale } });
    const joined = notesById().get(target.note.id);
    select([target.note.id], joined?.strokes.map((s) => s.id) ?? []);
  };

  const splitSelected = (): void => {
    const byId = notesById();
    const patch: Patch = {};
    const known: Record<string, { origin: Point; scale: number }> = {};
    const fresh: Note[] = [];
    for (const id of selNotes) {
      const note = byId.get(id);
      const pl = placer.get(id);
      if (!note || !pl || note.kind !== 'ink') continue;
      const ids = note.strokes.filter((s) => selStrokes.has(s.id)).map((s) => s.id);
      if (!ids.length || ids.length === note.strokes.length) continue;
      const r = relocate(note, pl, ids, { x: 0, y: 0 });
      if (!r) continue;
      mergePatch(patch, r.patch);
      known[r.added.id] = { origin: r.origin, scale: 1 };
      fresh.push(r.added);
    }
    if (!fresh.length) return;
    commit(patch, known);
    select(
      fresh.map((n) => n.id),
      fresh.flatMap((n) => n.strokes.map((s) => s.id)),
    );
  };

  const deleteNotes = (ids: string[]): void => {
    const byId = notesById();
    const del: string[] = [];
    for (const id of ids) {
      const n = byId.get(id);
      if (!n) continue;
      const part = selNotes.includes(id) ? n.strokes.filter((s) => selStrokes.has(s.id)) : [];
      if (part.length && part.length < n.strokes.length) del.push(...part.map((s) => s.id));
      else del.push(id);
    }
    if (del.length) commit({ del });
    clearSelection();
  };

  // ---- place me ------------------------------------------------------------------------

  const placeAt = (p: Point): void => {
    const id = v.state().placing;
    v.setState({ placing: undefined });
    if (!id) return;
    const note = notesById().get(id);
    if (!note) return;
    if (note.kind === 'textmark') {
      const w = Math.max(24, Math.min(note.frame.w || 120, 400));
      const h = Math.max(8, Math.min(note.frame.h || 16, 40));
      const d = described(describe(ctx, { x: p.x - 4, y: p.y - h / 2, w, h }));
      if (d.anchor.type !== 'text') return;
      commit({ update: [{ ...note, anchor: d.anchor, frame: d.frame }] });
      return;
    }
    const lb = unionRect(note.strokes.map(strokeBBox));
    if (!lb) return;
    const box = { x: p.x - lb.w / 2, y: p.y - lb.h / 2, w: lb.w, h: lb.h };
    const to = described(describe(ctx, box, { tool: note.strokes[0]?.tool ?? 'pen' }));
    // Stored strokes keep their size; they are shifted so the ink is centred on the tap.
    const patch = moveNote(note, to, {
      dx: box.x - to.origin.x - lb.x,
      dy: box.y - to.origin.y - lb.y,
      scale: 1,
    });
    const added = patch.add?.[0];
    commit(patch, added ? { [added.id]: { origin: to.origin, scale: 1 } } : undefined);
  };

  // Taps that capture does not take (a mouse or finger with drawing off) still place a note.
  let tapFrom: { id: number; x: number; y: number } | null = null;
  let eatClickUntil = 0;
  // A page script can make pointer events but never trusted ones, so it cannot move a note.
  const real = v.opts.real ?? ((e: Event) => e.isTrusted);
  const onTapDown = (e: PointerEvent): void => {
    if (!real(e)) return;
    tapFrom = v.state().placing && !isUi(e.target) ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
  };
  const onTapUp = (e: PointerEvent): void => {
    if (!real(e)) return;
    const t = tapFrom;
    tapFrom = null;
    if (!t || t.id !== e.pointerId || !v.state().placing) return;
    if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > TAP_PX) return;
    eatClickUntil = e.timeStamp + 600;
    placeAt({ x: e.clientX + win.scrollX, y: e.clientY + win.scrollY });
  };
  const onClick = (e: MouseEvent): void => {
    if (!real(e) || !eatClickUntil || e.timeStamp > eatClickUntil) return;
    eatClickUntil = 0;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  // ---- capture ---------------------------------------------------------------------------

  const isUi = (t: EventTarget | null): boolean => t === layer.host;
  const ignore = v.opts.ignore;

  const capture = createCapture({
    doc,
    mount: layer.root,
    enabled: () => !v.state().off,
    draw: () => v.state().draw,
    tool: () => v.state().tool,
    liveStyle: () => {
      const t = v.state().tool;
      const tool = strokeTool(t);
      return { tool, color: layer.cssColor(colorFor(t), tool), w: tool === 'hi' ? config.hiW : config.penW };
    },
    modifier: config.modifier,
    isUi,
    penNeedsToggle: !!(v.opts.penNeedsToggle ?? config.penNeedsToggle),
    ...(v.opts.front ? { front: v.opts.front } : {}),
    ...(v.opts.real ? { real: v.opts.real } : {}),
    ...(v.opts.hooks?.probe ? { probe: v.opts.hooks.probe } : {}),
    ...(ignore ? { ignore: (el: Element) => ignore(el) } : {}),
    onStart(g) {
      ui.wake();
      dismissTip();
      if (v.state().placing) return;
      if (g.tool === 'eraser') erase = { hit: new Set(), done: 0, marks: new Map(), byId: notesById() };
      else if (g.tool === 'lasso') startDrag(g.at);
      else if (selNotes.length) clearSelection();
    },
    // Pen-down to the first pixel of the live stroke, for the host's timing hook.
    onFirstPaint(t0) {
      v.opts.hooks?.onTiming?.('live.first', performance.now() - t0);
    },
    onMove(g) {
      if (g.tool === 'eraser') eraseAlong(g.samples);
      else if (g.tool === 'lasso') dragMove(g);
    },
    onEnd(g) {
      if (dead) return;
      if (v.state().placing) {
        const s = g.samples[0];
        if (s) placeAt({ x: s.x, y: s.y });
        capture.clearLive();
        return;
      }
      if (g.tool === 'eraser') {
        if (!erase) erase = { hit: new Set(), done: 0, marks: new Map(), byId: notesById() };
        eraseAlong(g.samples);
        const del = [...erase.hit];
        erase = null;
        if (del.length) commit({ del });
        layer.setHidden([]);
        capture.clearLive();
        return;
      }
      if (g.tool === 'lasso') {
        // The last moves may come in the same frame as the lift, before onMove has run.
        if (drag) {
          dragMove(g);
          dragEnd();
        } else lassoEnd(g);
        capture.clearLive();
        return;
      }
      write(g);
    },
    onCancel() {
      if (erase) layer.setHidden([]);
      erase = null;
      if (drag) for (const it of drag.notes) undrag(it);
      drag = null;
    },
    onPenNear: () => ui.wake(),
  });

  // ---- commands ------------------------------------------------------------------------------

  const saveFile = async (name: string, data: Blob): Promise<void> => {
    if (hooks.saveFile) return hooks.saveFile(name, data);
    const a = doc.createElement('a');
    const url = URL.createObjectURL(data);
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    a.click();
    win.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const toPng = async (b: Blob): Promise<Blob> => {
    if (b.type === 'image/png') return b;
    const bmp = await createImageBitmap(b);
    const c = doc.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')?.drawImage(bmp, 0, 0);
    return new Promise((res, rej) =>
      c.toBlob((x) => (x ? res(x) : rej(new Error('PNG failed'))), 'image/png'),
    );
  };

  /** Picture of the visible page with its ink. Without a host hook, the ink alone. */
  const viewImage = async (): Promise<Blob> => {
    const url = await hooks.captureVisible?.().catch(() => undefined);
    const shot = url ? dataUrlBlob(url) : null;
    if (shot) return shot;
    const area = { x: win.scrollX, y: win.scrollY, w: win.innerWidth, h: win.innerHeight };
    return svgToPng(layer.toSVG(area), area.w, area.h, win.devicePixelRatio || 1);
  };

  const stamp = (): string => new Date().toISOString().slice(0, 10);
  const baseName = (): string =>
    (
      doc.title
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'page'
    ).toLowerCase();

  /** Plain text of the blocks in view, in reading order. */
  const sectionText = (): string => {
    const vh = win.innerHeight;
    const blocks = doc.body?.querySelectorAll<HTMLElement>(
      'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,figcaption,td,th,dt,dd',
    );
    const picked = new Set<Element>();
    const parts: string[] = [];
    let len = 0;
    for (const el of blocks ?? []) {
      if (len > CHAT_TEXT_MAX) break;
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.top >= vh || r.width === 0) continue;
      let p = el.parentElement;
      let nested = false;
      for (; p; p = p.parentElement) {
        if (picked.has(p)) {
          nested = true;
          break;
        }
      }
      if (nested) continue;
      picked.add(el);
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!t) continue;
      parts.push(t);
      len += t.length;
    }
    let text = parts.join('\n\n');
    if (text.length > CHAT_TEXT_MAX) text = `${text.slice(0, CHAT_TEXT_MAX)}…`;
    const marks = v
      .record()
      .notes.filter((n) => n.kind === 'textmark' && placer.get(n.id))
      .filter((n) => {
        const b = placer.get(n.id)!.bbox;
        return b.y + b.h > win.scrollY && b.y < win.scrollY + vh;
      })
      .map((n) => `> ${n.anchor.quote.exact}`);
    const head = `${doc.title}\n${win.location.href}`;
    return [head, text, marks.length ? `Marked:\n${marks.join('\n')}` : ''].filter(Boolean).join('\n\n');
  };

  const setSiteOff = (off: boolean): void => {
    // The host page owns this choice.
    if (v.opts.hideSiteOff) return;
    const host = v.identity().host;
    void store
      .config()
      .then((c) => {
        const list = c.off.filter((h) => h !== host);
        if (off) list.push(host);
        return store.setConfig({ off: list });
      })
      .catch(() => {});
    v.setState({ off });
    if (off) v.destroy?.();
  };

  /** Keep draw mode for this site, or forget it, as the reader leaves it. */
  const rememberDraw = (on: boolean): void => {
    const host = v.identity().host;
    if (!host) return;
    void store
      .config()
      .then((c) => {
        if (c.rememberDraw === false) return;
        const list = c.drawOn ?? [];
        if (list.includes(host) === on) return;
        return saveConfig({ drawOn: on ? [...list, host] : list.filter((h) => h !== host) });
      })
      .catch(() => {});
  };

  const cmd: InkCommands = {
    setDraw(on) {
      const was = v.state().draw;
      v.setState({ draw: on });
      if (on) ui.wake();
      if (on !== was) rememberDraw(on);
    },
    setTool(tool) {
      session.tool = tool;
      clearSelectionIfLeaving(tool);
      v.setState({ tool, color: colorFor(tool) });
    },
    setColor(color) {
      const hi = isHiColor(color);
      if (hi) session.hi = color;
      else session.pen = color;
      // A colour of the other family switches to its tool, like picking up that pen.
      const t = v.state().tool;
      if (hi && t !== 'hi') cmd.setTool('hi');
      else if (!hi && t !== 'pen') cmd.setTool('pen');
      else v.setState({ color });
    },
    undo() {
      const p = history.undo(v.record());
      clearSelection();
      if (p) v.commit(p);
      syncHistory();
    },
    redo() {
      const p = history.redo(v.record());
      clearSelection();
      if (p) v.commit(p);
      syncHistory();
    },
    place(id) {
      v.setState({ placing: id ?? undefined });
    },
    deleteNotes,
    joinSelected,
    splitSelected,
    clearSelection,
    clearPage() {
      // For good: not an undo step, and the steps before it go too, since they would bring ink back.
      // The store's own erase writes the tombstones, as the library's Delete does.
      const frame = v.opts.frame;
      const patch = erasePatch(v.record(), (n) =>
        frame ? n.anchor.frame?.url === frame.url : !n.anchor.frame,
      );
      clearSelection();
      v.setState({ placing: undefined });
      recent.clear();
      if (patch.del?.length) v.commit(patch);
      history.clear();
      syncHistory();
    },
    async exportImage() {
      const img = await viewImage();
      const ext = img.type === 'image/jpeg' ? 'jpg' : 'png';
      await saveFile(`${baseName()}-${stamp()}.${ext}`, img);
    },
    async exportMarkdown() {
      const md = toMarkdown([v.record()]);
      await saveFile(`${baseName()}-notes.md`, new Blob([md], { type: 'text/markdown' }));
    },
    async copyForChat() {
      const text = sectionText();
      const clip = win.navigator.clipboard;
      if (!clip) return;
      const png = await viewImage()
        .then(toPng)
        .catch(() => null);
      const Item = (win as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (png && Item && clip.write) {
        try {
          await clip.write([
            new Item({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'image/png': png }),
          ]);
          return;
        } catch {
          // Some browsers take only one type at a time. Text is the part that matters.
        }
      }
      await clip.writeText(text);
    },
    print() {
      win.print();
    },
    setSiteOff,
  };

  // The bar's one-line note goes away with anything the reader does.
  const dismissTip = (): void => {
    if (v.state().tip) v.setState({ tip: undefined });
  };
  for (const k of Object.keys(cmd) as (keyof InkCommands)[]) {
    const f = cmd[k] as (...a: unknown[]) => unknown;
    (cmd as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
      dismissTip();
      return f(...a);
    };
  }

  function clearSelectionIfLeaving(tool: Tool): void {
    if (tool !== 'lasso') clearSelection();
  }

  const ui = createUi({
    mount: layer.ui,
    state: v.state,
    subscribe: v.subscribe,
    cmd,
    tray: v.tray,
    cssColor: (c, t) => layer.cssColor(c, t),
    barHideMs: config.barHideMs,
    hideSiteOff: !!v.opts.hideSiteOff,
    uiTheme: v.opts.uiTheme,
    front: v.opts.front,
    ...(v.opts.real ? { real: v.opts.real } : {}),
  });

  win.addEventListener('pointerdown', onTapDown, true);
  win.addEventListener('pointerup', onTapUp, true);
  win.addEventListener('click', onClick, true);
  // The same handlers through the front, for pages that stop events at the window.
  // Each one acts once per tap, so seeing an event twice changes nothing.
  const front = v.opts.front;
  const offFront = front
    ? [
        front.on('pointerdown', (e) => onTapDown(e as PointerEvent)),
        front.on('pointerup', (e) => onTapUp(e as PointerEvent)),
        front.on('click', (e) => onClick(e as MouseEvent)),
      ]
    : [];

  const offSwap =
    v.onSwap?.(() => {
      history.clear();
      recent.clear();
      select([], []);
      v.setState({ placing: undefined, canUndo: false, canRedo: false });
    }) ?? (() => {});

  return {
    cmd,
    adopt: (events) => capture.adopt(events),
    openTray: (id, byKey) => ui.openTray(id, byKey),
    destroy() {
      if (dead) return;
      dead = true;
      offSwap();
      win.removeEventListener('pointerdown', onTapDown, true);
      win.removeEventListener('pointerup', onTapUp, true);
      win.removeEventListener('click', onClick, true);
      for (const f of offFront) f();
      capture.destroy();
      ui.destroy();
    },
  };
};

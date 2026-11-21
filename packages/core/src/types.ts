/**
 * Shared types for pageink-core. This file is the contract in code.
 * Every folder implements the function types declared here and imports its
 * data types from here. See docs/CONTRACT.md and docs/FORMAT.md.
 */

export const FORMAT_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One input sample. x and y are CSS pixels in the space named where the sample
 * is used (document space unless stated). p is pressure from 0 to 1. t is in
 * milliseconds; only differences matter.
 */
export interface Sample {
  x: number;
  y: number;
  p: number;
  t: number;
}

// ---------------------------------------------------------------------------
// Record format v1 (docs/FORMAT.md)
// ---------------------------------------------------------------------------

export type StrokeTool = 'pen' | 'hi';
export type Tool = StrokeTool | 'eraser' | 'lasso';

/** Semantic colour name. Mapped to a real colour per page theme by render/. */
export type InkColor = 'ink-1' | 'ink-2' | 'hi-1' | 'hi-2' | (string & {});

export interface Stroke {
  id: string;
  /** Time the stroke ended, epoch ms. */
  t: number;
  tool: StrokeTool;
  color: InkColor;
  /** Base width in note-local units. */
  w: number;
  /** Delta-encoded integer triples x, y, pressure. See FORMAT.md. */
  pts: number[];
  /** Finished outline path in note-local units. Painted as a filled path. */
  d: string;
}

export type MarkStyle = 'highlight' | 'underline' | 'strike';

export interface TextMark {
  style: MarkStyle;
  color: InkColor;
}

export interface Quote {
  exact: string;
  prefix: string;
  suffix: string;
}

export interface ElementPath {
  id?: string;
  css: string;
  xpath: string;
}

export type AnchorType = 'text' | 'block' | 'media' | 'viewport';
export type Place = 'on' | 'left' | 'right' | 'above' | 'below';

export interface Anchor {
  type: AnchorType;
  quote: Quote;
  path: ElementPath;
  pos: { start: number; end: number };
  hash: string;
  media?: { src: string; alt: string; caption: string };
  place: Place;
  scroller?: ElementPath;
  frame?: { url: string; path: ElementPath };
  /** Note position as a fraction of the document size when written. */
  frac?: Point;
  /** Address of the link the anchor block contains or sits in, when there is one. */
  link?: string;
}

export interface NoteFrame {
  /** Anchor box size when written, CSS px. */
  w: number;
  h: number;
  /** Computed font size of the anchor element when written. */
  fontPx: number;
  viewportW: number;
}

export type NoteKind = 'ink' | 'textmark';

export interface Note {
  id: string;
  createdAt: number;
  updatedAt: number;
  device: string;
  kind: NoteKind;
  anchor: Anchor;
  frame: NoteFrame;
  strokes: Stroke[];
  mark?: TextMark;
  /** Small image of what was under the note. Only for viewport anchors. */
  thumb?: string;
}

export interface Tombstone {
  id: string;
  t: number;
}

export interface PageRecord {
  v: 1;
  key: string;
  urls: string[];
  title: string;
  updatedAt: number;
  notes: Note[];
  deleted: Tombstone[];
  snapshot?: { ref: string; t: number };
}

// ---------------------------------------------------------------------------
// strokes/
// ---------------------------------------------------------------------------

export interface StrokeStyle {
  tool: StrokeTool;
  color: InkColor;
  w: number;
}

/** Outline path for a list of samples, in the same units as the samples. */
export type Outline = (samples: Sample[], style: Pick<StrokeStyle, 'tool' | 'w'>) => string;
export type EncodePts = (samples: Sample[]) => number[];
/** Inverse of EncodePts up to quantisation. t is 0 on decoded samples. */
export type DecodePts = (pts: number[]) => Sample[];
/**
 * Build a stored stroke from document-space samples. The result is in
 * note-local units: (sample - origin) / scale.
 */
export type MakeStroke = (
  docSamples: Sample[],
  origin: Point,
  style: StrokeStyle,
  opts?: { scale?: number; id?: string; t?: number },
) => Stroke;
/** Copy of a stroke moved and scaled in note-local space: p' = (p + d) * scale. New id. */
export type RebaseStroke = (s: Stroke, dx: number, dy: number, scale: number) => Stroke;
/** Bounding box in note-local units, including the stroke width. */
export type StrokeBBox = (s: Stroke) => Rect;
/** True when the note-local point p is within radius of the stroke. */
export type HitStroke = (s: Stroke, p: Point, radius: number) => boolean;

// ---------------------------------------------------------------------------
// capture/
// ---------------------------------------------------------------------------

export type PointerKind = 'pen' | 'touch' | 'mouse';

export interface Gesture {
  tool: Tool;
  pointerType: PointerKind;
  /** Document-space samples, including coalesced samples. */
  samples: Sample[];
  /** performance.now() at the first and last sample. */
  t0: number;
  t1: number;
}

/**
 * What capture saw during one pen, finger or mouse gesture. It is made only for a host that
 * passes a probe, such as a device check. Counts of touch events cover the time since the
 * previous probe, so the touch that started this gesture is included whichever came first.
 */
export interface StrokeProbe {
  pointerType: PointerKind;
  tool: Tool;
  /** ink: became a stroke. tap: left to the page. cancel: stopped by a second finger or the browser. skip: never started. */
  outcome: 'ink' | 'tap' | 'cancel' | 'skip';
  /** Why a pen-down did not start a gesture. Set with outcome skip. */
  reason?: 'off' | 'ui' | 'ignored' | 'needs-toggle' | 'button';
  /** The draw toggle when the gesture began. */
  draw: boolean;
  /** The events were held by the host before capture loaded, then replayed. */
  replayed: boolean;
  /** performance.now() time of the pen-down and of the lift or cancel. */
  t0: number;
  t1: number;
  /** Samples kept for the stroke. */
  samples: number;
  /** Samples per second over the stroke. */
  rate: number;
  /** Raw pressure as the browser reported it. */
  pressure: { min: number; max: number };
  /** pointermove events, coalesced samples in them, and predicted samples painted ahead. */
  moves: number;
  coalesced: number;
  predicted: number;
  /** Stylus touchstart and touchmove events, and how many of them capture cancelled. */
  stylusTouches: number;
  stylusCancelled: number;
  /** Finger pointers that touched down while this pen was down, and how many were kept from the page. */
  fingersWhilePen: number;
  fingersBlocked: number;
  /** Window scroll at the start and at the end. */
  scroll0: { x: number; y: number };
  scroll1: { x: number; y: number };
  /** From the pen-down event to the first live paint, and to the frame after it. Null when nothing was painted. */
  firstPaintMs: number | null;
  firstFrameMs: number | null;
}

/** What capture tells a probe. createProbe (capture/probe.ts) turns it into a StrokeProbe per gesture. */
export interface Probe {
  start(kind: PointerKind, tool: Tool, t0: number, replay: boolean, draw: boolean): void;
  /** A pen-down that started no gesture. */
  skip(tool: Tool, t: number, reason: NonNullable<StrokeProbe['reason']>, draw: boolean): void;
  /** The events behind the samples just taken. */
  raw(list: readonly PointerEvent[]): void;
  /** A move with this many coalesced samples. */
  move(coalesced: number): void;
  /** A live paint with this many predicted samples. */
  paint(predicted: number): void;
  /** A finger touched down while the pen was down. kept: capture kept it from the page. */
  palm(kept: boolean): void;
  /** A stylus touch event, and whether it ended up cancelled. */
  touch(cancelled: boolean): void;
  end(outcome: 'ink' | 'tap' | 'cancel', t1: number, pts: readonly { t: number }[]): void;
}

/** Event types a Front relays. */
export type FrontType = 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'click';

/**
 * Window listeners in the capture phase that the host registered before the
 * page's own scripts ran. Some pages stop every event at the window, which no
 * listener added later can see. A Front hands those events over first.
 * Consumers also keep their own listeners and handle each event once.
 */
export interface Front {
  /** Call fn for each event of this type. Returns an unsubscribe. */
  on(type: FrontType, fn: (e: Event) => void): () => void;
}

export interface CaptureHost {
  doc: Document;
  /** Early window listeners, when the host has them. */
  front?: Front;
  /** The live canvas is mounted here. */
  mount: ShadowRoot;
  /** False when ink is switched off for this site. */
  enabled(): boolean;
  /** Draw toggle. */
  draw(): boolean;
  tool(): Tool;
  /** Style for the live preview. color is a CSS colour. */
  liveStyle(): { tool: StrokeTool; color: string; w: number };
  /** Key that lets a mouse draw while held, with the toggle off. */
  modifier: 'Alt' | 'Control' | 'Meta' | 'none';
  /** Events that hit our own bar or tray are never ink. */
  isUi(target: EventTarget | null): boolean;
  /** Gestures that start on an element this returns true for are never ink. They reach the page untouched. */
  ignore?(target: Element): boolean;
  /** True: a pen writes only with the draw toggle, like touch and mouse. Default false. */
  penNeedsToggle?: boolean;
  onStart?(g: { tool: Tool; pointerType: PointerKind; at: Point }): void;
  /** Called at most once per frame while a gesture is in progress. */
  onMove?(g: Gesture): void;
  onEnd(g: Gesture): void;
  onCancel?(): void;
  /** A pen is hovering or has touched down. */
  onPenNear?(): void;
  /** The live stroke was painted for the first time. t0 is the pen-down event's timeStamp. */
  onFirstPaint?(t0: number): void;
  /**
   * Test seam. Input counts only when the browser made it (`isTrusted`). A test that
   * cannot make real input passes a function that also accepts its own events.
   */
  real?(e: Event): boolean;
  /** Counts what capture sees, for device checks. Make it with createProbe. Leave it out and nothing is counted. */
  probe?: Probe;
}

export interface Capture {
  /** Replay pointer events that were buffered before capture was loaded. */
  adopt(events: PointerEvent[]): void;
  /** Clear the live canvas. Call after the committed stroke is on screen. */
  clearLive(): void;
  destroy(): void;
}

export type CreateCapture = (host: CaptureHost) => Capture;

// ---------------------------------------------------------------------------
// anchor/
// ---------------------------------------------------------------------------

export interface AnchorContext {
  doc: Document;
  /** Extension-only accessor for closed shadow roots. */
  shadowRootOf?(el: Element): ShadowRoot | null;
  /** True for our own layer host. It is skipped everywhere. */
  isOurs?(el: Element): boolean;
  /** The clock for the text model's slices and the quick rung's budget, in ms. Default performance.now(). */
  now?(): number;
}

export interface Described {
  anchor: Anchor;
  frame: NoteFrame;
  /** Note-local origin in document space, right now. */
  origin: Point;
}

export type ResolveMethod = 'path' | 'exact' | 'fuzzy' | 'media' | 'viewport';

export interface Resolved {
  /** Note-local origin in document space. */
  origin: Point;
  /** Note-local units to CSS px. */
  scale: number;
  /** Current anchor box in document space. */
  box: Rect;
  el: Element;
  /** Present for text anchors and text marks. */
  range?: Range;
  method: ResolveMethod;
  /** Match quality from 0 to 1. */
  score: number;
  /** Inner scrolling element the anchor lives in, when there is one. */
  scroller?: Element;
  /** True when the anchor sits in fixed or sticky content. */
  pinned?: boolean;
  /**
   * Ancestors that clip the anchor, nearest first, below its scroller when it has one.
   * Ink is painted only inside all of them, as the anchor's own content is.
   */
  clips?: ClipEdge[];
}

/** An element that clips what it holds, on one axis or both. */
export interface ClipEdge {
  el: Element;
  x: boolean;
  y: boolean;
}

export interface Resolver {
  /** Null when the ladder finds nothing that passes the quote check. */
  resolve(anchor: Anchor, frame: NoteFrame): Resolved | null;
  /** Drop cached document text. Call after the page content changes. */
  invalidate(): void;
  /**
   * The structural path rung alone, with the quote checked on the anchor's own block.
   * Builds no document text. Undefined when only the full ladder can decide. The full
   * ladder can still differ (a twin block elsewhere), so a caller checks later with resolve().
   */
  quick?(anchor: Anchor, frame: NoteFrame): Resolved | undefined;
  /**
   * For an anchor resolve() cannot find: the element its path points at, when that element
   * still holds the quote but is not shown (a closed section, a hidden tab). Null otherwise.
   */
  hidden?(anchor: Anchor): Element | null;
  /** The element the anchor's path points at, unchecked. A cheap hint of where a note will be. */
  locate?(anchor: Anchor): Element | null;
  /** True when the document text is built, so resolve() builds nothing. */
  ready?(): boolean;
  /** Build the document text for about `ms`. True when it is complete. */
  prepare?(ms: number): boolean;
}

export type CreateResolver = (ctx: AnchorContext) => Resolver;

/** Choose an anchor for ink whose bounding box is `box` in document space. */
export type Describe = (ctx: AnchorContext, box: Rect, opts?: { tool?: StrokeTool }) => Described;
/** Anchor for a text range. Used for text marks. */
export type DescribeRange = (ctx: AnchorContext, range: Range) => Described;
/** Decide whether a stroke is a highlight, underline or strike on text. */
export type RecognizeTextMark = (
  ctx: AnchorContext,
  docSamples: Sample[],
  tool: StrokeTool,
) => { range: Range; style: MarkStyle } | null;

export interface PageIdentity {
  /** Normalised address or family key. This is PageRecord.key. */
  key: string;
  /** Other address keys that mean the same document (canonical link, the plain address). */
  aliases: string[];
  /** Host of the current address. */
  host: string;
  /** Every host this document can appear on (family hosts plus the current one). */
  hosts: string[];
  /** Version label inside a family, for example an arXiv "v2". */
  version?: string;
  /** The address as given. */
  url: string;
}

export type PageIdentityFn = (url: string, doc?: Document) => PageIdentity;

// ---------------------------------------------------------------------------
// render/ and place/
// ---------------------------------------------------------------------------

export type Theme = 'light' | 'dark';

export interface NotePose {
  origin: Point;
  scale: number;
  /** Draw a thin leader line to this document point (docked notes). */
  leaderTo?: Point;
  /** Points the leader passes on its way, so it runs round text rather than across it. */
  leaderVia?: Point[];
  /**
   * No free space for the note: draw a small marker in this document-space box instead. The marker
   * shows the ink at `scale` when it is tapped, hovered or pressed with a key.
   */
  marker?: Rect;
  /** Follow this inner scroller and clip to its box. */
  scroller?: Element;
  pinned?: boolean;
  /** Document-space box the note is cut to: where its anchor content is painted. Empty hides it. */
  clip?: Rect;
  /** The anchor is in the browser's top layer (a modal dialog, an open popover): paint above it. */
  top?: boolean;
}

export interface Layer {
  /** Custom element attached to <html>. */
  host: HTMLElement;
  /** Closed shadow root. */
  root: ShadowRoot;
  /** Container for the bar and the tray. Children take pointer events. */
  ui: HTMLElement;
  theme(): Theme;
  setTheme(t: Theme | 'auto'): void;
  /** Real colour for a semantic colour in the current theme. */
  cssColor(c: InkColor, tool: StrokeTool): string;
  /** Create or update the drawing of an ink note. */
  drawNote(note: Note, pose: NotePose): void;
  /** Create or update a text mark from the client rects of its range, document space. */
  drawMark(note: Note, rects: Rect[], pose?: Pick<NotePose, 'scroller' | 'pinned' | 'clip' | 'top'>): void;
  removeNote(id: string): void;
  clear(): void;
  setSelected(noteIds: string[]): void;
  /** Hide or show single strokes while a gesture is in progress (eraser preview). */
  setHidden(strokeIds: string[]): void;
  /** Small badge for notes that are not attached. count 0 hides it. */
  setBadge(count: number, onOpen?: () => void): void;
  /** Stand-alone SVG of all ink inside a document rect. */
  toSVG(area: Rect): string;
  destroy(): void;
}

export type CreateLayer = (doc: Document, opts?: { zIndex?: number; theme?: Theme | 'auto' }) => Layer;
/** Rasterise a stand-alone SVG. */
export type SvgToPng = (svg: string, w: number, h: number, scale?: number) => Promise<Blob>;

export interface Placed {
  id: string;
  origin: Point;
  scale: number;
  /** Ink bounding box in document space. */
  bbox: Rect;
  /** Anchor box in document space. */
  anchorBox: Rect;
  docked: boolean;
  /** Folded into a marker: `bbox` is the marker's box. */
  collapsed?: boolean;
  method: ResolveMethod;
}

export interface PlacerHost {
  doc: Document;
  resolver: Resolver;
  layer: Layer;
  /** Called after each placement pass. */
  onChange?(placed: Placed[], unplaced: Note[]): void;
  /** Called with ink timing marks for the bench. */
  onTiming?(name: string, ms: number): void;
  /** The clock for the pass budgets and timing marks, in ms. Default performance.now(). */
  now?(): number;
}

export interface Placer {
  /** Replace the whole set. */
  setNotes(notes: Note[]): void;
  /** Add or update one note. `known` skips the resolve for a note just written. */
  upsert(note: Note, known?: { origin: Point; scale: number }): void;
  remove(id: string): void;
  get(id: string): Placed | undefined;
  all(): Placed[];
  /** Notes with no anchor on the page right now. */
  unplaced(): Note[];
  /**
   * Notes hidden with their content: the anchor is there but not shown (a closed section).
   * They are not in unplaced(), so they never reach the tray, and they return when it opens.
   */
  hidden?(): Note[];
  /** Notes not decided yet: they wait for the document text, built in idle slices. */
  waiting?(): number;
  /** Document point to note-local point for a placed note. */
  toLocal(id: string, p: Point): Point | undefined;
  /** Run a full placement pass soon. */
  refresh(reason?: string): void;
  destroy(): void;
}

export type CreatePlacer = (host: PlacerHost) => Placer;

// ---------------------------------------------------------------------------
// notes/
// ---------------------------------------------------------------------------

/**
 * A change to a page record. Ids are never reused. Anything that changes
 * geometry (move, split, join, undo of a delete) deletes the old ids and adds
 * copies under new ids.
 */
export interface Patch {
  add?: Note[];
  addStrokes?: { note: string; strokes: Stroke[] }[];
  /** Replace note fields other than strokes. Matched by id. */
  update?: Note[];
  /** Note ids or stroke ids. */
  del?: string[];
}

export interface GroupCandidate {
  id: string;
  /** Document space. */
  bbox: Rect;
  /** performance.now() when the note's last stroke ended. */
  lastEnd: number;
  tool: StrokeTool;
}

/** Note the new stroke joins, or null to start a new note. DESIGN 7.1. */
export type PickNote = (
  stroke: { t0: number; bbox: Rect; tool: StrokeTool },
  candidates: GroupCandidate[],
  opts?: { gapMs?: number; gapPx?: number },
) => string | null;

export interface LassoItem {
  note: string;
  stroke: string;
  /** Document space. */
  bbox: Rect;
  /** A few document-space points on the stroke, for a precise test. */
  pts?: Point[];
}

/** Strokes inside the lasso. A note is whole when all its strokes are inside. */
export type LassoSelect = (
  polygon: Point[],
  items: LassoItem[],
) => { strokes: string[]; wholeNotes: string[]; partialNotes: string[] };

export interface History {
  /** Record a change that was just applied. `before` is the record before it. */
  record(patch: Patch, before: PageRecord): void;
  /** Patch that reverts the last change, or null. Re-added content gets new ids. */
  undo(now: PageRecord): Patch | null;
  redo(now: PageRecord): Patch | null;
  canUndo(): boolean;
  canRedo(): boolean;
  clear(): void;
}

export type CreateHistory = (opts?: { limit?: number }) => History;

/** Move a note to a new anchor. Strokes are rebased by (dx, dy) then scaled. */
export type MoveNote = (note: Note, to: Described, shift: { dx: number; dy: number; scale: number }) => Patch;
/** Take strokes out of a note into a new note at a new anchor. */
export type SplitNote = (
  note: Note,
  strokeIds: string[],
  to: Described,
  shift: { dx: number; dy: number; scale: number },
) => Patch;
/** Fold other notes into target. Each shift maps the other note's local space into target's. */
export type JoinNotes = (
  target: Note,
  others: { note: Note; dx: number; dy: number; scale: number }[],
) => Patch;

// ---------------------------------------------------------------------------
// store/
// ---------------------------------------------------------------------------

/** Minimal key-value storage. chrome.storage.local, IndexedDB or a host app. */
export interface KV {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** All keys that start with prefix. */
  keys(prefix: string): Promise<string[]>;
  /** Changes made by any context, including this one. */
  onChange?(cb: (changed: Record<string, unknown | undefined>) => void): () => void;
}

export interface InkConfig {
  v: 1;
  /** Random id for this install. */
  device: string;
  /** Hosts where ink is switched off. */
  off: string[];
  modifier: 'Alt' | 'Control' | 'Meta' | 'none';
  /** Block pen touches before the tools are loaded. On for iPad Safari. */
  penReady: boolean;
  /** The one-line hint after the first ink was shown. It is never shown again. */
  hinted?: boolean;
  /** Bar hides after this long without ink input. */
  barHideMs: number;
  penW: number;
  hiW: number;
  theme: Theme | 'auto';
  /** Name of the backup folder, when one is connected. */
  folder?: string;
  lastSync?: number;
  /** Open PDFs in the bundled viewer so they can take ink. Default true. */
  pdf?: boolean;
  /** Keep draw mode on for a site once the reader has switched it on there. Default true. */
  rememberDraw?: boolean;
  /** Hosts where draw mode was left on. */
  drawOn?: string[];
  /** The pen writes only while draw mode is on. Default false. */
  penNeedsToggle?: boolean;
  /** Save a small picture with notes written on blank areas. Default true. */
  thumbs?: boolean;
  /** Keep ink written in private windows. Default false. */
  privateKeep?: boolean;
}

export interface PageSummary {
  key: string;
  hash: string;
  title: string;
  url: string;
  updatedAt: number;
  notes: number;
}

export interface Store {
  /** Record for a page identity, looking through aliases. Null when none. */
  load(id: PageIdentity): Promise<PageRecord | null>;
  /**
   * Read, merge, write. Updates the site index for every host in id.hosts.
   * Returns the merged record. An empty record removes the page from the index.
   */
  save(rec: PageRecord, id: PageIdentity): Promise<PageRecord>;
  /** Call cb when the record changes in storage (another tab, a frame, sync). */
  watch(key: string, cb: (rec: PageRecord | null) => void): () => void;
  get(key: string): Promise<PageRecord | null>;
  remove(key: string): Promise<void>;
  list(): Promise<PageSummary[]>;
  config(): Promise<InkConfig>;
  setConfig(patch: Partial<InkConfig>): Promise<InkConfig>;
}

export type CreateStore = (kv: KV) => Store;
export type EmptyRecord = (id: PageIdentity, title: string) => PageRecord;
/** FORMAT.md merge rule. Pure. */
export type Merge = (a: PageRecord, b: PageRecord) => PageRecord;
export type ApplyPatch = (rec: PageRecord, patch: Patch, now?: number) => PageRecord;

/** A folder the reader owns. Names are relative paths like "pages/abc.ink.json". */
export interface FolderIO {
  list(dir: string): Promise<{ name: string; mtime: number; size: number }[]>;
  read(name: string): Promise<string>;
  write(name: string, text: string): Promise<void>;
  remove?(name: string): Promise<void>;
  /**
   * The hash that names a page's files, when the folder names them its own way (the password
   * lock uses a keyed hash). Without it, files are named with `hashKey`.
   */
  hash?(key: string): Promise<string>;
}

export interface SyncReport {
  pulled: number;
  pushed: number;
  merged: number;
  conflictsFolded: number;
  errors: string[];
  /**
   * Files sealed with a password lock this device does not hold. They are not damaged and
   * are never written over or removed. The pages they hold wait until the lock is opened.
   */
  locked?: string[];
  /**
   * Files that are not ours while the password lock is on: plain, or sealed for another name
   * or with another key. They are never merged, written over or removed.
   */
  refused?: string[];
}

export interface SyncOptions {
  /** Only these page keys. */
  only?: string[];
  /**
   * Leave out pages that exist only on this device and last changed before this time.
   * Used after a switch to a new place, so the switch copies nothing by itself.
   */
  since?: number;
}

/** Two-way sync between the store and the folder. Safe to run at any time. */
export type SyncFolder = (store: Store, io: FolderIO, opts?: SyncOptions) => Promise<SyncReport>;
/** Zip with pages/<hash>.ink.json files. The same layout as the folder. */
export type ExportArchive = (store: Store) => Promise<Uint8Array>;
export type ImportArchive = (store: Store, zip: Uint8Array) => Promise<SyncReport>;
export type ToMarkdown = (records: PageRecord[]) => string;

// ---------------------------------------------------------------------------
// ui/ and app/
// ---------------------------------------------------------------------------

export interface InkState {
  draw: boolean;
  tool: Tool;
  color: InkColor;
  canUndo: boolean;
  canRedo: boolean;
  /** Notes on this page, placed or not. */
  notes: number;
  /** Notes waiting in the tray. */
  tray: number;
  /** Lasso selection. */
  selected: string[];
  /** Id of the tray note in "place me" mode. */
  placing?: string;
  theme: Theme;
  /** Ink is switched off for this site. */
  off: boolean;
  /** A quiet problem the bar shows, such as a save that failed. Absent when all is well. */
  warn?: string;
  /** A one-line note the bar shows until the reader does anything. */
  tip?: string;
  /** Ink is kept in memory only: a private window. Nothing is saved or synced. */
  memoryOnly?: boolean;
  /** Notes held out of place while the browser shows a translation. Not counted in `tray`. */
  held?: number;
}

export interface TrayItem {
  note: Note;
  /**
   * waiting: the page may still load it. missing: the page has settled without it.
   * translated: the browser translated the page, so its words do not match; it returns
   * when the original is shown.
   */
  state: 'waiting' | 'missing' | 'translated';
  quote: string;
  link?: string;
  thumb?: string;
  /** Relative height on the page when written, 0 to 1. */
  relY: number;
}

export interface InkCommands {
  setDraw(on: boolean): void;
  setTool(tool: Tool): void;
  setColor(color: InkColor): void;
  undo(): void;
  redo(): void;
  /** Start "place me" for a tray note. The next tap on the page re-anchors it. */
  place(noteId: string | null): void;
  deleteNotes(ids: string[]): void;
  /** Join the selected notes into one. */
  joinSelected(): void;
  /** Split the selected strokes out of their notes. */
  splitSelected(): void;
  clearSelection(): void;
  clearPage(): void;
  /** Picture of the visible page with ink, saved as a file. */
  exportImage(): Promise<void>;
  /** This page's notes as Markdown, saved as a file. */
  exportMarkdown(): Promise<void>;
  /** Text of the section in view and a picture of its ink, to the clipboard. */
  copyForChat(): Promise<void>;
  /** Print dialog. The ink prints with the page. */
  print(): void;
  setSiteOff(off: boolean): void;
}

export interface UiHost {
  /** Layer.ui */
  mount: HTMLElement;
  state(): InkState;
  subscribe(cb: (s: InkState) => void): () => void;
  cmd: InkCommands;
  tray(): TrayItem[];
  cssColor(c: InkColor, tool: StrokeTool): string;
  barHideMs: number;
  /** Leave the "ink off for this site" entry out of the menu. */
  hideSiteOff?: boolean;
  /** Colours of the bar and tray. Default: the ink's theme. auto follows the reader's light or dark setting. */
  uiTheme?: Theme | 'auto';
  /** Early window listeners, so the bar works on pages that stop events at the window. */
  front?: Front;
  /** Test seam, as CaptureHost.real. Without it only events the browser made count. */
  real?(e: Event): boolean;
}

export interface Ui {
  /** Show the bar and restart its hide timer. */
  wake(): void;
  /** Open the tray. With a note id, that note's row is brought into view and marked. */
  openTray(noteId?: string, byKey?: boolean): void;
  destroy(): void;
}

export type CreateUi = (host: UiHost) => Ui;

/** A problem worth telling the host about. Each one is reported once. */
export interface InkWarning {
  /** save: storage refused a write. record: a stored record cannot be read and is left alone. */
  kind: 'save' | 'record';
  /** Storage key involved. */
  key: string;
  message: string;
}

/** Things only the embedding environment can do. All optional. */
export interface HostHooks {
  /** Picture of the visible tab as a data URL. */
  captureVisible?(): Promise<string | undefined>;
  /** Save a file. Default: a download link. */
  saveFile?(name: string, data: Blob): Promise<void>;
  /** Timing marks for the bench. */
  onTiming?(name: string, ms: number): void;
  /** Counts what capture sees, for device checks. Make it with createProbe from pageink-core/capture. */
  probe?: Probe;
  /** State changes, for a browser action badge or a host app. */
  onState?(s: InkState): void;
  /** Storage problems. Ink stays in memory and on the page meanwhile. */
  onWarn?(w: InkWarning): void;
}

export interface ViewerOptions {
  doc?: Document;
  kv: KV;
  /** Fixed identity. Default: pageIdentity(location.href, document), tracked across in-page navigation. */
  identity?: PageIdentity;
  /** Set when running inside a subframe. Notes are filtered and written with this frame. */
  frame?: { url: string; path: ElementPath };
  shadowRootOf?(el: Element): ShadowRoot | null;
  hooks?: HostHooks;
  /** Loads the tools chunk. Default: import('./tools'). */
  loadTools?: () => Promise<{ attachTools: AttachTools }>;
  /** Gestures that start on an element this returns true for are never ink. They reach the page untouched. */
  ignore?(target: Element): boolean;
  /** False (default): a pen writes with no toggle. True: the pen needs the draw toggle, like touch and mouse. */
  penNeedsToggle?: boolean;
  /** Leave out the "ink off for this site" menu entry and ignore config.off. */
  hideSiteOff?: boolean;
  /** Settings laid over the stored ones in memory. They are never saved. */
  config?: Partial<InkConfig>;
  /** Show a small draw handle once the page is idle, before the tools load. Default false. */
  showHandle?: boolean;
  /**
   * Colours of the bar and tray, apart from the ink. Default: the ink's theme.
   * auto follows the reader's light or dark setting, for a host whose own
   * chrome does, while the ink keeps the colours for its paper.
   */
  uiTheme?: Theme | 'auto';
  /** Window listeners registered before the page's scripts. The extension stub provides them. */
  front?: Front;
  /**
   * The page is in a private window. Ink works but is kept in memory only, never saved
   * or synced, unless config.privateKeep is true.
   */
  private?: boolean;
  /**
   * Test seam, as CaptureHost.real. Without it only events the browser made count, so a
   * page script can never write, erase, undo or place.
   */
  real?(e: Event): boolean;
  /** The clock for placement and text model budgets, in ms. Default performance.now(). Tests drive it. */
  now?(): number;
}

export interface Viewer {
  /** Resolves when the first placement pass is done. */
  ready: Promise<void>;
  state(): InkState;
  /** Load the tools if needed and return the commands. */
  tools(): Promise<InkCommands>;
  /** Pointer events buffered by the stub before the tools were loaded. */
  adopt(events: PointerEvent[]): void;
  /** Re-read identity and record. Called on in-page navigation. */
  reload(): Promise<void>;
  destroy(): void;
}

export type CreateViewer = (opts: ViewerOptions) => Promise<Viewer>;

/** Internal seam between the view chunk and the tools chunk. Owned by app/. */
export interface ViewerInternals {
  opts: ViewerOptions;
  doc: Document;
  store: Store;
  layer: Layer;
  placer: Placer;
  resolver: Resolver;
  ctx: AnchorContext;
  config: InkConfig;
  identity(): PageIdentity;
  record(): PageRecord;
  /** Apply a change, persist it, update placement. */
  commit(patch: Patch, known?: Record<string, { origin: Point; scale: number }>): void;
  setState(patch: Partial<InkState>): void;
  state(): InkState;
  subscribe(cb: (s: InkState) => void): () => void;
  tray(): TrayItem[];
  /** Called when reload() swaps in another page's record. Returns an unsubscribe. */
  onSwap?(cb: () => void): () => void;
  /** Tear the whole viewer down, for example when ink is switched off for the site. */
  destroy?(): void;
}

export type AttachTools = (v: ViewerInternals) => {
  cmd: InkCommands;
  adopt(events: PointerEvent[]): void;
  destroy(): void;
  /** Open the tray panel. Used by the badge and the page edge markers. */
  openTray?(noteId?: string, byKey?: boolean): void;
};

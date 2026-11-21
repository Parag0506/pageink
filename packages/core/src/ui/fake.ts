// Test helper: a UiHost that records commands and lets a test drive state.
import { vi } from 'vitest';
import type { InkColor, InkCommands, InkState, Note, StrokeTool, TrayItem, UiHost } from '../types';

export interface FakeHost extends UiHost {
  set(patch: Partial<InkState>): void;
  items: TrayItem[];
  subs: Set<(s: InkState) => void>;
  cmd: { [K in keyof InkCommands]: InkCommands[K] & ReturnType<typeof vi.fn> };
}

export const COLORS: Record<string, string> = {
  'light:ink-1': 'rgb(20, 20, 20)',
  'light:ink-2': 'rgb(200, 30, 30)',
  'light:hi-1': 'rgb(255, 220, 0)',
  'light:hi-2': 'rgb(120, 220, 120)',
  'dark:ink-1': 'rgb(240, 240, 240)',
  'dark:ink-2': 'rgb(255, 120, 120)',
  'dark:hi-1': 'rgb(150, 130, 0)',
  'dark:hi-2': 'rgb(40, 120, 40)',
};

export function fakeHost(
  mount: HTMLElement,
  opts: { barHideMs?: number; state?: Partial<InkState>; strict?: boolean } = {},
): FakeHost {
  let s: InkState = {
    draw: false,
    tool: 'pen',
    color: 'ink-1',
    canUndo: false,
    canRedo: false,
    notes: 0,
    tray: 0,
    selected: [],
    theme: 'light',
    off: false,
    ...opts.state,
  };
  const subs = new Set<(s: InkState) => void>();
  const set = (p: Partial<InkState>) => {
    s = { ...s, ...p };
    for (const cb of subs) cb(s);
  };
  const p = () => vi.fn(() => Promise.resolve());
  const cmd = {
    setDraw: vi.fn((on: boolean) => set({ draw: on })),
    setTool: vi.fn((tool: InkState['tool']) => set({ tool })),
    setColor: vi.fn((color: InkColor) => set({ color })),
    undo: vi.fn(),
    redo: vi.fn(),
    place: vi.fn((id: string | null) => set({ placing: id ?? undefined })),
    deleteNotes: vi.fn(),
    joinSelected: vi.fn(),
    splitSelected: vi.fn(),
    clearSelection: vi.fn(() => set({ selected: [] })),
    clearPage: vi.fn(),
    exportImage: p(),
    exportMarkdown: p(),
    copyForChat: p(),
    print: vi.fn(),
    setSiteOff: vi.fn((off: boolean) => set({ off })),
  };
  const host: FakeHost = {
    mount,
    state: () => s,
    subscribe: (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    cmd: cmd as FakeHost['cmd'],
    tray: () => host.items,
    cssColor: (c: InkColor, _t: StrokeTool) => COLORS[`${s.theme}:${c}`] ?? 'rgb(1, 2, 3)',
    barHideMs: opts.barHideMs ?? 60_000,
    set,
    items: [],
    subs,
  };
  // Tests drive the bar with events they make. Strict hosts take only real input, as a page does.
  if (!opts.strict) host.real = () => true;
  return host;
}

export function note(id: string, d = 'M0 0L100 0L100 50Z'): Note {
  return {
    id,
    createdAt: 1,
    updatedAt: 1,
    device: 'd',
    kind: 'ink',
    anchor: {
      type: 'text',
      quote: { exact: 'q', prefix: '', suffix: '' },
      path: { css: 'p', xpath: '/p' },
      pos: { start: 0, end: 1 },
      hash: 'h',
      place: 'on',
    },
    frame: { w: 100, h: 20, fontPx: 16, viewportW: 1000 },
    strokes: [{ id: `${id}-s`, t: 1, tool: 'pen', color: 'ink-1', w: 2, pts: [], d }],
  };
}

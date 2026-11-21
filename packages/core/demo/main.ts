// Runs the real viewer on the demo page over a KV kept in localStorage.

import { createViewer } from '../src/app/view';
import type { KV } from '../src/types';

const PREFIX = 'ink-demo:';

function localKV(): KV {
  type Listener = (changed: Record<string, unknown | undefined>) => void;
  const listeners = new Set<Listener>();
  const emit = (changed: Record<string, unknown | undefined>) => {
    queueMicrotask(() => {
      for (const l of [...listeners]) l(structuredClone(changed));
    });
  };
  // Other tabs on the same origin.
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(PREFIX)) return;
    emit({ [e.key.slice(PREFIX.length)]: e.newValue ? JSON.parse(e.newValue) : undefined });
  });
  const read = (k: string): unknown => {
    const v = localStorage.getItem(PREFIX + k);
    return v === null ? undefined : JSON.parse(v);
  };
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const v = read(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) localStorage.setItem(PREFIX + k, JSON.stringify(v));
      emit(items);
    },
    async remove(keys) {
      const changed: Record<string, undefined> = {};
      for (const k of keys) {
        localStorage.removeItem(PREFIX + k);
        changed[k] = undefined;
      }
      emit(changed);
    },
    async keys(prefix) {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k?.startsWith(PREFIX + prefix)) out.push(k.slice(PREFIX.length));
      }
      return out.sort();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

// The scrolling log.
const pane = document.getElementById('pane');
if (pane) {
  const rows: string[] = [];
  for (let d = 1; d <= 40; d++) {
    const litres = 12 + ((d * 7) % 9);
    rows.push(
      `<div>day ${String(d).padStart(2, '0')}  row ${(d % 6) + 1}  ${litres} litres  ${d % 5 ? 'clear' : 'rain'}</div>`,
    );
  }
  pane.innerHTML = rows.join('');
}

const params = new URLSearchParams(location.search);
if (params.has('reset')) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (k?.startsWith(PREFIX)) localStorage.removeItem(k);
  }
  // The query is part of the page key, so drop it once storage is clear.
  params.delete('reset');
  history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
}

const viewer = await createViewer({
  kv: localKV(),
  hooks: { onTiming: (name, ms) => console.debug(`ink ${name}: ${ms.toFixed(1)} ms`) },
});
(window as unknown as { ink: unknown }).ink = viewer;

// The extension loads the tools on a pen touch or the draw toggle. The demo shows them at once
// unless ?view is given, which shows the page as a reader with no tools would see it.
if (!params.has('view')) await viewer.tools();

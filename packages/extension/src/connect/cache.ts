/**
 * Skips downloads of files that did not change. For each file it keeps the version last
 * seen, the page key it held, and a hash of its text. When the version is the same and this
 * device's record for that page still gives the same text, the text is taken from here
 * instead of the cloud. Holds no note content, only hashes. No network code.
 */
import { hashKey } from 'pageink-core/hash';
import { recordText } from 'pageink-core/store';
import type { FolderIO, Store } from 'pageink-core/types';

export interface Seen {
  /** The cloud's version of the file. */
  v: string;
  /** The page key the file held. */
  k: string;
  /** Hash of the file's text, as it reads after the lock. */
  h: string;
}

export interface SeenStore {
  get(): Promise<Record<string, Seen>>;
  set(all: Record<string, Seen>): Promise<void>;
}

type Peeking = FolderIO & { peek?(name: string): { version: string } | undefined };

/** Hash of text for this cache. Two hashes over different seeds, so a match is no accident. */
const sum = (text: string) => `${hashKey(text)}.${hashKey(`~${text}`)}.${text.length}`;

const keyOf = (text: string): string => {
  try {
    const k = (JSON.parse(text) as { key?: unknown }).key;
    return typeof k === 'string' ? k : '';
  } catch {
    return '';
  }
};

export function cachedFolder(
  io: Peeking,
  store: Store,
  seen: SeenStore,
): FolderIO & { save(): Promise<void> } {
  let all: Record<string, Seen> | null = null;
  let dirty = false;
  const load = async (): Promise<Record<string, Seen>> =>
    (all ??= await seen.get().catch(() => ({}) as Record<string, Seen>));
  const note = async (name: string, text: string) => {
    const v = io.peek?.(name)?.version;
    const map = await load();
    if (!v) {
      if (map[name]) {
        delete map[name];
        dirty = true;
      }
      return;
    }
    map[name] = { v, k: keyOf(text), h: sum(text) };
    dirty = true;
  };
  return {
    ...io,
    async read(name) {
      const v = io.peek?.(name)?.version;
      const s = (await load())[name];
      if (v && s && s.v === v && s.k) {
        const local = await store.get(s.k).catch(() => null);
        if (local) {
          const text = recordText(local);
          if (sum(text) === s.h) return text;
        }
      }
      const text = await io.read(name);
      await note(name, text);
      return text;
    },
    async write(name, text) {
      await io.write(name, text);
      await note(name, text);
    },
    async remove(name) {
      await io.remove?.(name);
      const map = await load();
      if (map[name]) {
        delete map[name];
        dirty = true;
      }
    },
    async save() {
      if (dirty && all) await seen.set(all);
      dirty = false;
    },
  };
}

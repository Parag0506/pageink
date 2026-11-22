/**
 * Folder sync in a real browser. An OPFS directory stands in for the folder
 * the reader picks: it is a real FileSystemDirectoryHandle, stored in
 * IndexedDB the same way a picked handle is (adapters/folder-fs.ts).
 */
import type { Page } from '@playwright/test';
import { hashKey } from 'pageink-core/hash';
import { centre, expect, layerInfo, ring, stroke, test, textBox } from './fixtures';

/** Connect an OPFS folder as if the reader had picked it. */
const connect = (opt: Page) =>
  opt.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('PageInk Notes', { create: true });
    await new Promise<void>((ok, fail) => {
      const r = indexedDB.open('ink-folder', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('handles');
      r.onerror = () => fail(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(dir, 'folder');
        tx.oncomplete = () => {
          r.result.close();
          ok();
        };
        tx.onerror = () => fail(tx.error);
      };
    });
    const cfg = ((await chrome.storage.local.get('cfg')).cfg ?? {}) as object;
    await chrome.storage.local.set({ cfg: { ...cfg, folder: dir.name } });
  });

const list = (opt: Page) =>
  opt.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('PageInk Notes'))
      .getDirectoryHandle('pages')
      .catch(() => null);
    const out: string[] = [];
    if (dir) for await (const k of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) out.push(k);
    return out.sort();
  });

const readFile = (opt: Page, name: string) =>
  opt.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('PageInk Notes')).getDirectoryHandle('pages');
    return (await (await dir.getFileHandle(n)).getFile()).text();
  }, name);

const writeFile = (opt: Page, name: string, text: string) =>
  opt.evaluate(
    async ([n, t]) => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('PageInk Notes')).getDirectoryHandle('pages', {
        create: true,
      });
      const w = await (await dir.getFileHandle(n, { create: true })).createWritable();
      await w.write(t);
      await w.close();
    },
    [name, text] as const,
  );

type Rec = {
  key: string;
  updatedAt: number;
  notes: { id: string; updatedAt: number; strokes: { id: string; t: number }[] }[];
};

test('folder sync: pages are pushed to the folder, another device’s strokes and conflict copies come back', async ({
  context,
  origin,
  extId,
}) => {
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#settings`);
  await connect(opt);
  await opt.reload();
  await expect(opt.locator('#folder-state')).toContainText('PageInk Notes');

  const url = `${origin.a}/article.html`;
  const page = await context.newPage();
  await page.goto(url);
  const w = (await textBox(page, 'pomegranate'))!;
  await stroke(page, ring(centre(w), w.w / 2 + 8, w.h / 2 + 6));
  await expect.poll(async () => (await layerInfo(page))?.notes.length).toBe(1);

  // The background pushes the page by itself after a short pause.
  const file = `${hashKey(url)}.ink.json`;
  await expect.poll(() => list(opt)).toEqual([file]);
  const pushed = JSON.parse(await readFile(opt, file)) as Rec;
  expect(pushed.key).toBe(url);
  expect(pushed.notes[0]!.strokes).toHaveLength(1);

  // Another device adds a stroke to the same note and writes the file.
  const other = structuredClone(pushed);
  const n = other.notes[0]!;
  const s0 = n.strokes[0]!;
  const t = Date.now() + 1000;
  n.strokes.push({ ...s0, id: `${s0.id}-other`, t });
  n.updatedAt = t;
  other.updatedAt = t;
  await writeFile(opt, file, JSON.stringify(other, null, 2));

  // Sync runs in the service worker with the saved handle. Ask it directly once.
  const reply = (await opt.evaluate(() => chrome.runtime.sendMessage({ ink: 'sync' }))) as {
    report?: { pulled: number; merged: number };
    error?: string;
  };
  expect(reply.error).toBeUndefined();
  expect((reply.report?.pulled ?? 0) + (reply.report?.merged ?? 0)).toBe(1);
  await expect.poll(async () => (await layerInfo(page))?.notes[0]?.strokes).toBe(2);

  // The options page button does the same.
  await opt.bringToFront();
  await opt.click('#sync-now');
  await expect(opt.locator('#status')).toContainText('Synced');
  await expect(opt.locator('#last-sync')).not.toContainText('never');
  // Sync status has its own key. Settings are never rewritten by sync.
  const st = await opt.evaluate(() => chrome.storage.local.get(['sync', 'cfg']));
  expect((st.sync as { lastSync?: number }).lastSync).toBeGreaterThan(0);
  expect((st.cfg as { lastSync?: number }).lastSync).toBeUndefined();
  // The open page shows the stroke from the other device.
  await expect.poll(async () => (await layerInfo(page))?.notes[0]?.strokes).toBe(2);

  // A sync service left a conflict copy with one more stroke. It is folded in and removed.
  const conflict = structuredClone(other);
  const c = conflict.notes[0]!;
  c.strokes.push({ ...s0, id: `${s0.id}-conflict`, t: t + 1 });
  c.updatedAt = t + 1;
  conflict.updatedAt = t + 1;
  const copy = `${hashKey(url)} (conflicted copy).ink.json`;
  await writeFile(opt, copy, JSON.stringify(conflict));
  expect(await list(opt)).toEqual([copy, file].sort());
  await opt.click('#sync-now');
  await expect.poll(() => list(opt)).toEqual([file]);
  await expect.poll(async () => (await layerInfo(page))?.notes[0]?.strokes).toBe(3);
  const merged = JSON.parse(await readFile(opt, file)) as Rec;
  expect(merged.notes[0]!.strokes.map((s) => s.id).sort()).toEqual(
    [s0.id, `${s0.id}-other`, `${s0.id}-conflict`].sort(),
  );
});

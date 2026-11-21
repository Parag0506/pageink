import type { FolderIO } from 'pageink-core/types';

function parts(path: string): string[] {
  const segs = path.split('/').filter((s) => s && s !== '.');
  if (segs.some((s) => s === '..')) throw new Error(`Path leaves the folder: ${path}`);
  return segs;
}

const notFound = (e: unknown): boolean =>
  e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');

/**
 * A FolderIO over a directory handle from the File System Access API
 * (showDirectoryPicker) or the origin private file system (navigator.storage.getDirectory).
 * The site asks for the handle with mode "readwrite" in a click handler, then passes it here.
 */
export function fsFolder(root: FileSystemDirectoryHandle): FolderIO {
  const dirAt = async (segs: string[], create: boolean): Promise<FileSystemDirectoryHandle> => {
    let d = root;
    for (const s of segs) d = await d.getDirectoryHandle(s, { create });
    return d;
  };

  const split = (name: string): { dir: string[]; base: string } => {
    const segs = parts(name);
    const base = segs.pop();
    if (!base) throw new Error(`Not a file name: ${name}`);
    return { dir: segs, base };
  };

  return {
    async list(dir) {
      let d: FileSystemDirectoryHandle;
      try {
        d = await dirAt(parts(dir), false);
      } catch (e) {
        if (notFound(e)) return [];
        throw e;
      }
      const out: { name: string; mtime: number; size: number }[] = [];
      for await (const h of d.values()) {
        if (h.kind !== 'file') continue;
        const f = await (h as FileSystemFileHandle).getFile();
        out.push({ name: h.name, mtime: f.lastModified, size: f.size });
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async read(name) {
      const { dir, base } = split(name);
      const d = await dirAt(dir, false);
      const f = await (await d.getFileHandle(base)).getFile();
      return f.text();
    },
    async write(name, text) {
      const { dir, base } = split(name);
      const d = await dirAt(dir, true);
      const fh = await d.getFileHandle(base, { create: true });
      const w = await fh.createWritable();
      try {
        await w.write(text);
      } finally {
        await w.close();
      }
    },
    async remove(name) {
      const { dir, base } = split(name);
      try {
        const d = await dirAt(dir, false);
        await d.removeEntry(base);
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
  };
}

/**
 * Serves the simulator test pages from this Mac. The simulator shares the Mac's network,
 * so Mobile Safari reaches it at 127.0.0.1. Test only: nothing here ships.
 *
 *   tsx apple/sim/serve.ts <port>
 *
 * Pages come from apple/sim/pages, then from the extension's e2e pages. /paper.pdf is a small
 * text PDF made by the e2e helper, so no binary file sits in the repository.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { makePdf, paperPages } from '../../packages/extension/e2e/pdfs';

const port = Number(process.argv[2] ?? 8765);
const dirs = [resolve(import.meta.dirname, 'pages'), resolve(import.meta.dirname, '../../packages/extension/e2e/pages')];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
};
const pdf = makePdf({ pages: paperPages(3, 'sim'), title: 'Simulator test paper' });

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  // No caching, so a reload always asks again and the page under test is the one on disk.
  const base = { 'cache-control': 'no-store' };
  if (path === '/paper.pdf') {
    res.writeHead(200, { ...base, 'content-type': 'application/pdf' }).end(pdf);
    return;
  }
  for (const dir of dirs) {
    const file = join(dir, path === '/' ? 'sim.html' : path);
    if (file.startsWith(dir) && existsSync(file)) {
      res.writeHead(200, { ...base, 'content-type': TYPES[extname(file)] ?? 'text/plain' }).end(readFileSync(file));
      return;
    }
  }
  res.writeHead(404, base).end('not found');
}).listen(port, '127.0.0.1', () => console.log(`serving on http://127.0.0.1:${port}`));

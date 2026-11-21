/**
 * Serves the device check page to the iPad over the local network and collects its results.
 * Test only: nothing here ships.
 *
 *   tsx apple/device/serve.ts --port 8790 --out apple/build/device/<run> [--minutes 60]
 *
 * The page posts each step's result here. When the last step is done, this writes
 * results.json and summary.txt to the out folder, prints the summary and exits: 0 when no
 * check failed, 1 when one failed or was not done, 3 when time ran out first. A step the person
 * saw work while the tool got no record of it is SEEN, which is not a failure. results.json is
 * also written after every step, so nothing is lost when a run stops early.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { join, resolve } from 'node:path';
import { makePdf } from '../../packages/extension/e2e/pdfs';

const arg = (name: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const port = Number(arg('port', '8790'));
const out = resolve(arg('out', 'apple/build/device/run') ?? '');
const minutes = Number(arg('minutes', '60'));
/** The app's name on the iPad, for the page's words. */
const name = arg('name', '') ?? '';
const pages = resolve(import.meta.dirname, 'pages');
mkdirSync(out, { recursive: true });

export interface StepResult {
  id: string;
  title: string;
  /** seen: the person saw it work, but the tool got no record of it. Not a failure. */
  status: 'pass' | 'fail' | 'skip' | 'seen';
  /** One short line on why. */
  why: string;
  /** What the page decided by itself. */
  auto: Record<string, unknown>;
  /** The owner's answers to yes or no questions. */
  answers: Record<string, boolean>;
  /** The extension's records for this step, each with what the page saw at the same time. */
  records: unknown[];
  /** What the page itself saw: scroll, selection, the text field, stylus touches. */
  view: Record<string, unknown>;
  at: string;
}

const results = {
  started: new Date().toISOString(),
  finished: '',
  device: {} as Record<string, unknown>,
  extension: null as unknown,
  steps: {} as Record<string, StepResult>,
  events: [] as { at: string; type: string; text: string }[],
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const pdf = makePdf({
  title: 'Device check paper',
  pages: [1, 2].map((n) => [
    `This is page ${n} of the test paper.`,
    'Write on this page with your Pencil.',
    'The words are here so the ink has something to sit on.',
    'A few more lines of plain text follow below.',
    'Reading, writing and thinking all start with a page.',
    'A pen on paper is the oldest way to keep a thought.',
  ]),
});

const say = (text: string) => console.log(`  ${new Date().toLocaleTimeString()}  ${text}`);

function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((ok, fail) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      s += c;
      if (s.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        ok(JSON.parse(s || '{}'));
      } catch (e) {
        fail(e);
      }
    });
  });
}

/** The order of the checks in the summary. The page has the same list. */
const ORDER = ['extension', 'hello', 'scroll', 'palm', 'scribble', 'reload', 'rotate', 'pdf'];

interface Rec {
  pointerType?: string;
  outcome?: string;
  rate?: number;
  coalesced?: number;
  predicted?: number;
  samples?: number;
}

/** A few words on what the extension and the page saw in a step. */
function evidence(s: StepResult): string {
  const a = s.auto as Record<string, unknown>;
  const out: string[] = [];
  const ink = (s.records as Rec[]).filter((r) => r.pointerType === 'pen' && r.outcome === 'ink');
  if (ink.length) {
    const rates = ink.map((r) => r.rate ?? 0).sort((x, y) => x - y);
    out.push(`${ink.length} Pencil stroke(s), ${rates[rates.length >> 1]} samples a second`);
    out.push(`${ink.reduce((n, r) => n + (r.coalesced ?? 0), 0)} coalesced, ${ink.reduce((n, r) => n + (r.predicted ?? 0), 0)} predicted`);
  }
  const first = a.firstStroke as
    | {
        bufferedByStub?: boolean;
        firstPaintMs?: number | null;
        stub?: { buffered?: number; loadMs?: number; injectMs?: number } | null;
      }
    | null
    | undefined;
  if (first) {
    out.push(`first stroke ${first.bufferedByStub ? 'held by the stub, then taken over' : 'went straight to capture'}`);
    const s = first.stub;
    if (s && typeof s.loadMs === 'number') {
      const inj = typeof s.injectMs === 'number' ? `, ${s.injectMs} ms of it injecting` : '';
      out.push(`the stub buffered ${s.buffered ?? 0} event(s); tools took them ${s.loadMs} ms after pen-down${inj}`);
    }
    if (first.firstPaintMs != null) out.push(`first paint ${first.firstPaintMs} ms after pen-down`);
  }
  const p = a.pressure as { min: number; max: number } | null | undefined;
  if (p) out.push(`pressure ${p.min.toFixed(2)} to ${p.max.toFixed(2)}`);
  if (typeof a.stylusTouches === 'number') out.push(`${a.stylusCancelled}/${a.stylusTouches} stylus touches cancelled`);
  if (typeof a.handTouchesWhilePen === 'number') {
    out.push(`${a.handTouchesWhilePen} hand touches while the Pencil was down, ${a.handTouchesKeptFromPage} kept from the page`);
  }
  if (typeof a.typed === 'string') out.push(a.typed ? `typed text "${a.typed}"` : 'no typed text');
  if (typeof a.scrolledBy === 'number') out.push(`scrolled ${a.scrolledBy} px`);
  if (typeof a.layer === 'boolean') out.push(a.layer ? 'ink layer back' : 'no ink layer');
  return out.join('; ');
}

export function summary(r: typeof results): { text: string; failed: number; missing: number } {
  const lines = ['Device check', ''];
  let failed = 0;
  let missing = 0;
  for (const id of ORDER) {
    const s = r.steps[id];
    if (!s) {
      missing++;
      lines.push(`  ----  ${id.padEnd(10)} not done`);
      continue;
    }
    const mark = ({ pass: 'PASS', fail: 'FAIL', skip: 'SKIP', seen: 'SEEN' } as const)[s.status] ?? 'FAIL';
    // SEEN is not a failure: the person saw it work and only the record is missing.
    if (mark === 'FAIL') failed++;
    lines.push(`  ${mark}  ${id.padEnd(10)} ${s.title}${s.why ? `. ${s.why}` : ''}`);
    const seen = evidence(s);
    if (seen) lines.push(`        ${''.padEnd(10)} saw: ${seen}`);
  }
  const ext = r.extension as { build?: Record<string, unknown> } | null;
  lines.push('', `  Extension reported in: ${ext ? 'yes' : 'no'}`);
  const ua = r.device.ua as string | undefined;
  if (ua) lines.push(`  Browser: ${ua}`);
  lines.push(`  Started ${r.started}${r.finished ? `, finished ${r.finished}` : ''}`);
  return { text: `${lines.join('\n')}\n`, failed, missing };
}

const save = () => writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);

function finish(code: number, why: string): void {
  results.finished = new Date().toISOString();
  save();
  const s = summary(results);
  writeFileSync(join(out, 'summary.txt'), s.text);
  console.log(`\n${why}\n`);
  console.log(s.text);
  console.log(`Results: ${join(out, 'results.json')}`);
  const exit = code !== 0 ? code : s.failed || s.missing ? 1 : 0;
  setTimeout(() => process.exit(exit), 300);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  const base = { 'cache-control': 'no-store' };
  const json = (v: unknown) => res.writeHead(200, { ...base, 'content-type': 'application/json' }).end(JSON.stringify(v));
  try {
    if (req.method === 'POST') {
      const b = (await body(req)) as Record<string, unknown>;
      if (path === '/api/event') {
        const text = String(b.text ?? '');
        results.events.push({ at: new Date().toISOString(), type: String(b.type ?? ''), text });
        if (b.type === 'hello' && !results.extension) {
          results.extension = b.data ?? true;
          say('The extension reported in from the check page.');
        } else if (b.type === 'open') {
          results.device = { ...results.device, ...(b.data as object) };
          say(`The iPad opened the check page (${text}).`);
        } else if (text) say(text);
        save();
        return json({ ok: true });
      }
      if (path === '/api/step') {
        const s = b as unknown as StepResult;
        if (!ORDER.includes(s.id)) return json({ ok: false });
        results.steps[s.id] = { ...s, at: new Date().toISOString() };
        say(`${s.status.toUpperCase()}  ${s.title}${s.why ? `. ${s.why}` : ''}`);
        save();
        return json({ ok: true });
      }
      if (path === '/api/done') {
        // Only a check with results can end the run: a tab left over from an earlier run cannot.
        if (!Object.keys(results.steps).length) return json({ ok: false });
        json({ ok: true });
        finish(0, 'The iPad finished the check.');
        return;
      }
      res.writeHead(404, base).end();
      return;
    }
    if (path === '/api/state') {
      return json({
        steps: results.steps,
        order: ORDER,
        name,
        opened: results.events.length > 0,
        // Names this run, so the page never reads what it kept in an earlier one.
        started: results.started,
      });
    }
    if (path === '/test.pdf') {
      res
        .writeHead(200, {
          ...base,
          // Sent as plain bytes, so Safari saves the file to Downloads instead of showing it.
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="test.pdf"',
        })
        .end(pdf);
      return;
    }
    if (path === '/' || path === '/s' || path === '/s/') {
      res.writeHead(302, { ...base, location: '/s/start' }).end();
      return;
    }
    const file = path.startsWith('/s/') ? join(pages, 'check.html') : join(pages, path.replace(/^\/+/, ''));
    if (file.startsWith(pages) && existsSync(file)) {
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { ...base, 'content-type': TYPES[ext] ?? 'text/plain' }).end(readFileSync(file));
      return;
    }
    res.writeHead(404, base).end('not found');
  } catch (e) {
    res.writeHead(500, base).end(String(e));
  }
});

server.listen(port, '0.0.0.0', () => say(`Serving the check page on port ${port}. Waiting for the iPad.`));
setTimeout(() => finish(3, `No result after ${minutes} minutes. Stopped waiting.`), minutes * 60_000).unref();
process.on('SIGINT', () => finish(130, 'Stopped by hand.'));
process.on('SIGTERM', () => finish(143, 'Stopped.'));

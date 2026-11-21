/**
 * The device check page (apple/device), its PDF step, in plain Chromium. A stand-in plays the
 * diagnostics build of the extension: it answers the page the way content/diag.ts does, and it
 * keeps the log in the site's storage, which every tab of the site shares, as the extension's
 * storage is shared by the viewer and every tab.
 *
 * On an iPad the person may come back from the PDF viewer in another tab, or Safari may give
 * the page a fresh session. The step must still find the strokes made in the viewer.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const root = resolve(import.meta.dirname, '../../..');
const ORDER = ['extension', 'hello', 'scroll', 'palm', 'scribble', 'reload', 'rotate', 'pdf'];

interface Served {
  origin: string;
  out: string;
  exited: Promise<number | null>;
  proc: ChildProcess;
}

const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });

async function serve(): Promise<Served> {
  const port = await freePort();
  const out = mkdtempSync(join(tmpdir(), 'device-check-'));
  const proc = spawn(
    join(root, 'node_modules/.bin/tsx'),
    [join(root, 'apple/device/serve.ts'), '--port', String(port), '--out', out, '--minutes', '5'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = new Promise<number | null>((ok) => proc.on('exit', (code) => ok(code)));
  await new Promise<void>((ok, fail) => {
    let said = '';
    proc.stdout?.on('data', (c) => {
      said += String(c);
      if (said.includes('Serving the check page')) ok();
    });
    proc.stderr?.on('data', (c) => {
      said += String(c);
    });
    void exited.then(() => fail(new Error(`The check server stopped: ${said}`)));
  });
  return { origin: `http://127.0.0.1:${port}`, out, exited, proc };
}

/** Answers the check page as the diagnostics build does. The log is in the site's storage. */
function standIn(): void {
  const LOG = 'stand-in-log';
  const read = () => JSON.parse(localStorage.getItem(LOG) || '[]');
  const post = (kind: string, data: object) => postMessage({ 'ink-diag': kind, ...data }, location.origin);
  const hello = () => post('hello', { build: {}, viewer: `${location.origin}/viewer`, early: {}, all: true });
  addEventListener('message', (e) => {
    const ask = (e.data as Record<string, unknown> | null)?.['ink-check'];
    if (ask === 'hello') hello();
    else if (ask === 'log') post('log', { records: read() });
    else if (ask === 'clear') localStorage.removeItem(LOG);
  });
  addEventListener('DOMContentLoaded', hello);
}

/** What the viewer keeps for one Pencil stroke that became ink. */
const keepStroke = (page: Page) =>
  page.evaluate(() => {
    const log = JSON.parse(localStorage.getItem('stand-in-log') || '[]');
    log.push({
      id: `r${log.length}`,
      where: 'pdf',
      page: 'pdf viewer',
      pointerType: 'pen',
      outcome: 'ink',
      at: Date.now(),
      samples: 40,
      rate: 120,
      scroll0: { x: 0, y: 0 },
      scroll1: { x: 0, y: 0 },
    });
    localStorage.setItem('stand-in-log', JSON.stringify(log));
  });

let served: Served;
let context: BrowserContext;

test.beforeEach(async ({ browser }) => {
  served = await serve();
  context = await browser.newContext();
  await context.addInitScript(standIn);
});

test.afterEach(async () => {
  await context.close();
  served.proc.kill('SIGTERM');
  await served.exited;
  rmSync(served.out, { recursive: true, force: true });
});

const state = async () =>
  (await (await fetch(`${served.origin}/api/state`)).json()) as {
    steps: Record<string, { status: string; why: string; records: unknown[] }>;
  };

/** Saves test.pdf and opens the viewer from the PDF step, in a tab of its own. */
async function toViewer(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${served.origin}/s/pdf`);
  await page.getByRole('link', { name: 'Save test.pdf' }).click();
  await expect(page.getByRole('link', { name: 'Open the PDF viewer' })).toBeVisible();
  await expect(page.getByText('Back to the Pencil check')).toBeVisible();
  await page.getByRole('link', { name: 'Open the PDF viewer' }).click();
  await page.waitForURL(/\/viewer/);
  return page;
}

/** The person finds the check page again in a new tab, with a session of its own. */
async function backInNewTab(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${served.origin}/s/pdf`);
  await expect(page.getByText('Did test.pdf open, and did your writing show on page 1?')).toBeVisible();
  return page;
}

test('a stroke in the viewer counts when the person comes back in another tab', async () => {
  const viewer = await toViewer();
  expect(viewer.url()).toMatch(/\/viewer\?from=check$/);
  await keepStroke(viewer);
  const back = await backInNewTab();
  await back.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(back.getByText('That worked.')).toBeVisible();
  const pdf = (await state()).steps.pdf!;
  expect(pdf.status).toBe('pass');
  expect(pdf.records).toHaveLength(1);
});

test('Yes without a record is SEEN, which the summary shows and the exit code does not count', async () => {
  await toViewer();
  const back = await backInNewTab();
  await back.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(back.getByText('You saw it work.', { exact: false })).toBeVisible();
  const pdf = (await state()).steps.pdf!;
  expect(pdf.status).toBe('seen');
  expect(pdf.why).toBe('You saw the ink; the tool got no record of it');
  // Every other step passed: the run ends with 0.
  for (const id of ORDER.filter((x) => x !== 'pdf')) {
    await fetch(`${served.origin}/api/step`, {
      method: 'POST',
      body: JSON.stringify({
        id,
        title: id,
        status: 'pass',
        why: '',
        auto: {},
        answers: {},
        records: [],
        view: {},
      }),
    });
  }
  await fetch(`${served.origin}/api/done`, { method: 'POST', body: '{}' });
  expect(await served.exited).toBe(0);
  const summary = readFileSync(join(served.out, 'summary.txt'), 'utf8');
  expect(summary).toMatch(
    / {2}SEEN {2}pdf {8}A PDF from Files takes ink\. You saw the ink; the tool got no record of it/,
  );
});

test('No is a failure, even with a record', async () => {
  const viewer = await toViewer();
  await keepStroke(viewer);
  const back = await backInNewTab();
  await back.getByRole('button', { name: 'No', exact: true }).click();
  await expect(back.getByText('This did not work as it should.', { exact: false })).toBeVisible();
  expect((await state()).steps.pdf!.status).toBe('fail');
});

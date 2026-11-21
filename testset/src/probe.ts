// Opens one version of one pair with the harness loaded and runs a script in it. For looking into a failure.
//
//   tsx src/probe.ts <pair id> a|b <script file> [--anchor core] [--cond w1280] [--notes 20] [--args ...]
//
// The script is the body of an async function. It sees `T` (window.__inkTest), `notes` (the notes
// written on version A of the pair, with what describe returned) and `args` (the --args string).
// The anchor module's inner functions are on window.__inkInner. Whatever the script returns is printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { Written } from '../page/harness.ts';
import { anchorEntry, bundleGlobal, bundleHarness } from './bundle.ts';
import { Contexts, loadImages, open, urlFor } from './score.ts';
import { hasFixture, loadSources, ROOT } from './sources.ts';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      anchor: { type: 'string', default: 'core' },
      cond: { type: 'string' },
      notes: { type: 'string', default: '20' },
      args: { type: 'string', default: '' },
    },
  });
  const [id, version, file] = positionals as [string, 'a' | 'b', string];
  const src = loadSources();
  const pair = src.pairs.find((p) => p.id === id);
  if (!pair || !hasFixture(pair)) throw new Error(`no fixture for ${id}`);
  loadImages([pair]);
  const bundle = await bundleHarness(anchorEntry(values.anchor!));
  const browser = await chromium.launch();
  const pages = new Contexts(browser, { n: 0 });
  const base = src.conditions[src.base]!;
  const pa = await open(pages, urlFor(pair, 'a'), base, bundle, 'load');
  const notes = (await pa.evaluate(
    `window.__inkTest.write(${JSON.stringify(id)}, ${Number(values.notes)})`,
  )) as Written[];
  await pa.close();
  const cond = values.cond ? src.conditions[values.cond]! : base;
  const page = await open(pages, urlFor(pair, version), cond, bundle, 'load');
  // The module's inner functions, as window.__inkInner, for scripts that need the text model.
  await page.evaluate(
    `${await bundleGlobal(join(ROOT, 'page', 'internals.ts'), '__inkInner')};window.__inkInner = __inkInner;`,
  );
  const body = readFileSync(file, 'utf8');
  const out = await page.evaluate(
    `(async (T, notes, args) => { ${body} })(window.__inkTest, ${JSON.stringify(notes)}, ${JSON.stringify(values.args)})`,
  );
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  await pages.close();
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

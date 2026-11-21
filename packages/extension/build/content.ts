/**
 * Builds the code that runs in web pages. WXT bundles content scripts as one
 * IIFE with its own runtime, which is too big for the stub and cannot split
 * chunks. So the stub is built here as a bare IIFE.
 *
 * The viewer and the tools are built as ES modules first, so the bundler splits
 * them and the tools chunk takes shared code from the viewer. Each module is then
 * turned into a plain script: its imports and exports become reads and writes of
 * one object in the content script world (`globalThis.__ink`), which the page
 * cannot see. Plain scripts can be registered as content scripts and injected by
 * the background, so no file has to be web accessible.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import { build, type InlineConfig } from 'vite';
import { defines, pkgDir, type Target } from './targets.ts';

const src = (p: string) => resolve(pkgDir, 'src/content', p);

/** The object in the content script world that holds the loaded modules. */
export const GLOBAL = 'globalThis.__ink';

/**
 * Module names the background may inject. Each is content/<name>.js. Safari keeps PDFs in its
 * own viewer, so its build has no PDF chunk.
 */
export const modulesFor = (t: Target): string[] =>
  t === 'safari' ? ['loader', 'tools'] : ['loader', 'tools', 'pdf'];

function base(t: Target, mode: string): InlineConfig {
  return {
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    define: { ...defines(t, mode), 'process.env.NODE_ENV': '"production"' },
  };
}

type Node = { type: string; start: number; end: number } & Record<string, unknown>;
type Spec = {
  type: string;
  local: { name: string };
  imported?: { name: string };
  exported?: { name: string };
};

/**
 * One ES module as a plain script that stores its exports under `name`. An import from
 * `from` reads that module's stored exports. A dynamic import of `lazy` becomes a request
 * for that module through `need`, which the stub provides. Bindings are copied once, so
 * no source module may export a binding that changes (test/stub-size.test.ts checks this).
 */
export function toScript(
  code: string,
  name: string,
  o: { from?: { spec: string; name: string }; lazy?: { spec: RegExp; name: string } } = {},
): string {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) as unknown as { body: Node[] };
  const cuts: { start: number; end: number; text: string }[] = [];
  let exports = '';
  for (const n of ast.body) {
    if (n.type === 'ImportDeclaration') {
      const from = (n.source as { value: string }).value;
      if (!o.from || from !== o.from.spec) throw new Error(`${name}: unexpected import of ${from}`);
      const parts = (n.specifiers as Spec[]).map((s) => {
        if (s.type !== 'ImportSpecifier') throw new Error(`${name}: only named imports are supported`);
        return `${s.imported!.name}:${s.local.name}`;
      });
      cuts.push({ start: n.start, end: n.end, text: `const{${parts.join(',')}}=${GLOBAL}.${o.from.name};` });
    } else if (n.type === 'ExportNamedDeclaration' && !n.declaration && !n.source) {
      const parts = (n.specifiers as Spec[]).map((s) => `${s.exported!.name}:${s.local.name}`);
      exports += parts.join(',');
      cuts.push({ start: n.start, end: n.end, text: '' });
    } else if (n.type.startsWith('Export')) {
      throw new Error(`${name}: unsupported export form ${n.type}`);
    }
  }
  simple(
    ast as never,
    {
      ImportExpression(n: Node) {
        const s = n.source as { type: string; value?: string; quasis?: { value: { cooked: string } }[] };
        const spec = s.type === 'Literal' ? s.value : s.quasis?.length === 1 ? s.quasis[0]!.value.cooked : '';
        if (!o.lazy || !spec || !o.lazy.spec.test(spec))
          throw new Error(`${name}: unexpected import(${spec})`);
        cuts.push({ start: n.start, end: n.end, text: `${GLOBAL}.need(\`${o.lazy.name}\`)` });
      },
      MetaProperty() {
        throw new Error(`${name}: import.meta is not available in a plain script`);
      },
    } as never,
  );
  let out = code;
  for (const c of cuts.sort((a, b) => b.start - a.start))
    out = out.slice(0, c.start) + c.text + out.slice(c.end);
  // A second copy (a registered script and an injected one) keeps the first.
  return `(()=>{"use strict";if((${GLOBAL}??={}).${name})return;\n${out.trim()}\n${GLOBAL}.${name}={${exports}};})();\n`;
}

export async function buildContent(outDir: string, t: Target, mode = 'production'): Promise<string[]> {
  const files = ['stub.js'];
  await build({
    ...base(t, mode),
    build: {
      outDir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      target: 'es2022',
      lib: {
        entry: src('stub.main.ts'),
        formats: ['iife'],
        name: 'inkStub',
        fileName: () => 'stub.js',
      },
    },
  });
  const tmp = resolve(outDir, '.content-esm');
  const maps = !!process.env.INK_SOURCEMAP;
  rmSync(tmp, { recursive: true, force: true });
  // The view path is one file: loader.js holds the viewer and everything it
  // needs. The tools are a chunk that only loader.js imports, so they share its
  // modules and load only on pen-down or the draw toggle. Library mode keeps
  // the bundler's preload helper out, so loading the viewer touches no DOM.
  await build({
    ...base(t, mode),
    build: {
      outDir: tmp,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      target: 'es2022',
      lib: { entry: { loader: src('loader.ts') }, formats: ['es'] },
      // INK_SOURCEMAP=1, for profiling only: maps of the viewer and the tools, kept apart below.
      sourcemap: maps,
      rolldownOptions: {
        // Lets the tools chunk import shared code from loader.js instead of a third file.
        preserveEntrySignatures: 'allow-extension',
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name].js',
          minify: true,
        },
      },
    },
  });
  // The PDF chunk shares nothing with the viewer, so it is built on its own.
  const pdf = modulesFor(t).includes('pdf');
  if (pdf)
    await build({
      ...base(t, mode),
      build: {
        outDir: tmp,
        emptyOutDir: false,
        copyPublicDir: false,
        minify: true,
        target: 'es2022',
        lib: { entry: { pdf: src('pdf.ts') }, formats: ['es'] },
        rolldownOptions: { output: { entryFileNames: '[name].js', minify: true } },
      },
    });
  // The first read of a page with ink runs before the viewer, so it is built on its own: it holds
  // only the page's identity and the storage keys, and needs nothing from the viewer.
  await build({
    ...base(t, mode),
    build: {
      outDir: tmp,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      target: 'es2022',
      lib: { entry: { boot: src('boot.main.ts') }, formats: ['es'] },
      rolldownOptions: { output: { entryFileNames: '[name].js', minify: true } },
    },
  });
  const chunks = readdirSync(resolve(tmp, 'chunks')).filter((f) => !f.endsWith('.map'));
  if (chunks.length !== 1 || chunks[0] !== 'tools.js')
    throw new Error(`unexpected chunks: ${chunks.join(', ')}`);
  const read = (f: string) => readFileSync(resolve(tmp, f), 'utf8');
  const out = resolve(outDir, 'content');
  mkdirSync(out, { recursive: true });
  const scripts: Record<string, string> = {
    // No compile hint here. Asking V8 to compile the whole viewer as it loads saved about a
    // millisecond before the first paint, but it made the parse task longer, and the bench's
    // stress page then ran its first update as one long task far more often: 30 of 40 cold loads
    // with the hint, 6 of 20 without it, and 24 of 50 with a do-nothing extension.
    loader: toScript(read('loader.js'), 'loader', {
      lazy: { spec: /^\.\/chunks\/tools\.js$/, name: 'tools' },
    }),
    tools: toScript(read('chunks/tools.js'), 'tools', { from: { spec: '../loader.js', name: 'loader' } }),
    ...(pdf ? { pdf: toScript(read('pdf.js'), 'pdf') } : {}),
    // Registered ahead of loader.js on hosts with ink: the record read is on its way while the
    // viewer compiles.
    boot: toScript(read('boot.js'), 'boot'),
  };
  // A profile of content/<name>.js maps back through the same text in maps/<name>.esm.js, whose map
  // points into the sources. These files are not listed in the manifest and no page can load them.
  if (maps) {
    const dir = resolve(outDir, 'maps');
    mkdirSync(dir, { recursive: true });
    for (const [n, f] of [
      ['loader', 'loader.js'],
      ['tools', 'chunks/tools.js'],
    ] as const) {
      writeFileSync(resolve(dir, `${n}.esm.js`), read(f));
      writeFileSync(resolve(dir, `${n}.esm.js.map`), read(`${f}.map`));
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  for (const [n, code] of Object.entries(scripts)) {
    writeFileSync(resolve(out, `${n}.js`), code);
    files.push(`content/${n}.js`);
  }
  return files;
}

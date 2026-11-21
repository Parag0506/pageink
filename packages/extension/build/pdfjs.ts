/**
 * PDF.js for the viewer page, with no way to reach the network.
 *
 * PDF.js can load documents, fonts, cmaps and wasm over the network. The viewer
 * hands it bytes, and cmaps and fonts come from files bundled here, so those
 * paths are never used. This build removes them: every use of the global fetch
 * and XMLHttpRequest becomes a stub that fails. PDF.js also names some of its own
 * methods `fetch` (reading objects inside the file). They are renamed, so the
 * bundle scan stays a plain token check with no exceptions for PDF.js.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { build, type Plugin, parseAst } from 'vite';
import { NAME } from '../src/brand.ts';
import { pkgDir, type Target } from './targets.ts';

/** The error every removed network path throws. */
export const NO_NET_TEXT = `${NAME} makes no network requests.`;

const require = createRequire(import.meta.url);
/** Root of the installed pdfjs-dist package. */
export const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'));

const NO_NET = 'inkNoNet';
const NO_XHR = 'InkNoXhr';
const RENAMED = 'inkReadObj';
const PREAMBLE =
  `const ${NO_NET} = () => Promise.reject(new Error(${JSON.stringify(NO_NET_TEXT)}));\n` +
  `class ${NO_XHR} { static DONE = 4; constructor() { throw new Error(${JSON.stringify(NO_NET_TEXT)}); } }\n`;
const GLOBALS = new Set(['globalThis', 'self', 'window']);
const NEVER = new Set(['WebSocket', 'EventSource', 'sendBeacon', 'importScripts']);

type Node = { type: string; start: number; end: number; [k: string]: unknown };
type Edit = { start: number; end: number; text: string };

const isNode = (v: unknown): v is Node =>
  !!v && typeof v === 'object' && typeof (v as Node).type === 'string';

/** Binding positions: a local named fetch would make the global rewrite wrong. */
function isBinding(parent: Node, key: string): boolean {
  const t = parent.type;
  return (
    (t === 'VariableDeclarator' && key === 'id') ||
    ((t === 'FunctionDeclaration' || t === 'FunctionExpression' || t === 'ClassDeclaration') &&
      key === 'id') ||
    key === 'params' ||
    t === 'CatchClause' ||
    t === 'ImportSpecifier' ||
    t === 'ImportDefaultSpecifier' ||
    t === 'AssignmentPattern' ||
    t === 'RestElement' ||
    t === 'ArrayPattern' ||
    t === 'ObjectPattern'
  );
}

/** Rewrites one PDF.js module. Throws on any shape it does not expect, so a new PDF.js release is checked by hand. */
export function stripNetwork(code: string, file = 'pdf.js'): string {
  for (const n of [NO_NET, NO_XHR, RENAMED]) {
    if (code.includes(n)) throw new Error(`${file}: already contains ${n}`);
  }
  const ast = parseAst(code) as unknown as Node;
  const edits: Edit[] = [];
  const fail = (n: Node, why: string): never => {
    const line = code.slice(0, n.start).split('\n').length;
    throw new Error(`${file}:${line}: ${why}`);
  };

  const visit = (node: Node, parent: Node | null, key: string): void => {
    if (node.type === 'Identifier' && parent) {
      const name = node.name as string;
      if (NEVER.has(name)) fail(node, `unexpected ${name}`);
      if (name === 'fetch' || name === 'XMLHttpRequest') {
        const p = parent;
        const isProp = p.type === 'MemberExpression' && key === 'property' && !p.computed;
        const isKey =
          (p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') &&
          key === 'key' &&
          !p.computed;
        if (name === 'XMLHttpRequest') {
          if (isProp || isKey) fail(node, 'XMLHttpRequest used as a property');
          if (isBinding(p, key)) fail(node, 'a local named XMLHttpRequest');
          edits.push({ start: node.start, end: node.end, text: NO_XHR });
        } else if (isProp) {
          const obj = p.object as Node;
          if (obj.type === 'Identifier' && GLOBALS.has(obj.name as string))
            edits.push({ start: p.start, end: p.end, text: NO_NET });
          else edits.push({ start: node.start, end: node.end, text: RENAMED });
        } else if (isKey) {
          if (p.shorthand) fail(node, 'shorthand property named fetch');
          edits.push({ start: node.start, end: node.end, text: RENAMED });
        } else {
          if (isBinding(p, key)) fail(node, 'a local named fetch');
          edits.push({ start: node.start, end: node.end, text: NO_NET });
        }
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) visit(c, node, k);
      } else if (isNode(v)) visit(v, node, k);
    }
  };
  visit(ast, null, '');

  edits.sort((a, b) => b.start - a.start);
  let out = code;
  let last = Number.POSITIVE_INFINITY;
  for (const e of edits) {
    // A member edit and its property edit overlap. The outer one wins.
    if (e.end > last) continue;
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    last = e.start;
  }
  return PREAMBLE + out;
}

/**
 * Which PDF.js build each target ships. The modern build needs built-ins that
 * only the newest browsers have, such as Map.prototype.getOrInsertComputed and
 * Math.sumPrecise. The legacy build carries polyfills for those (core-js) and
 * runs on Chrome 119, Firefox 124 and Safari 17.4 as shipped. src/pdf/compat.ts
 * fills the last gap for Safari 17.0 to 17.3. Every target's minimum version
 * is below what the modern build needs, so every target ships legacy.
 */
export const PDFJS_BUILD: Record<Target, 'modern' | 'legacy'> = {
  chrome: 'legacy',
  edge: 'legacy',
  firefox: 'legacy',
  safari: 'legacy',
};

const buildDir = (t: Target) => (PDFJS_BUILD[t] === 'legacy' ? 'legacy/build' : 'build');

/** Aliases that point the bare PDF.js imports at the build a target ships. */
export function pdfjsAlias(t: Target): { find: RegExp; replacement: string }[] {
  return [
    { find: /^pdfjs-dist$/, replacement: join(pdfjsDir, buildDir(t), 'pdf.mjs') },
    {
      find: /^pdfjs-dist\/build\/pdf\.worker\.mjs$/,
      replacement: join(pdfjsDir, buildDir(t), 'pdf.worker.mjs'),
    },
  ];
}

const PDFJS_FILE = /[\\/]pdfjs-dist[\\/](?:legacy[\\/])?build[\\/]pdf(?:\.worker)?\.mjs$/;

/** The core-js licence and source addresses inside the legacy build. The licence ships as a file instead. */
const CORE_JS_URL = /(["'])https:\/\/github\.com\/zloirock\/core-js(?:\/blob\/v[\d.]+\/LICENSE)?\1/g;
export const CORE_JS_LICENSE = 'LICENSE-core-js.txt';

/** Points the core-js licence fields at the shipped licence file, so no address is left in the build. */
export function dropLicenseUrl(code: string): string {
  return code.replace(CORE_JS_URL, JSON.stringify(`${PDF_DIR}/${CORE_JS_LICENSE}`));
}

/**
 * core-js in the legacy build finds the global object with `Function('return this')()` when every
 * other way failed. Every supported browser has globalThis, which core-js tries first, and the
 * extension's policy refuses string evaluation anyway. Dropping it leaves no eval for store review.
 */
const EVAL_FALLBACK = /\|\|\s*Function\((['"])return this\1\)\(\)/g;
export function dropEvalFallback(code: string): string {
  return code.replace(EVAL_FALLBACK, '|| globalThis');
}

/** Vite plugin: applies stripNetwork to the PDF.js modules. */
export function pdfjsOffline(): Plugin {
  return {
    name: 'ink-pdfjs-offline',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0] ?? id;
      if (!PDFJS_FILE.test(file)) return null;
      return { code: dropEvalFallback(dropLicenseUrl(stripNetwork(code, file))), map: null };
    },
  };
}

/** Files the viewer page loads besides its own bundle. Paths are relative to the build folder. */
export const PDF_DIR = 'pdf';

/** The MIT licence of core-js, which the legacy build carries. The copyright line is read from the build. */
function coreJsLicense(t: Target): string | null {
  if (PDFJS_BUILD[t] !== 'legacy') return null;
  const code = readFileSync(join(pdfjsDir, 'legacy/build/pdf.mjs'), 'utf8');
  const version = /version: '(3\.[\d.]+)',\s*mode:/.exec(code)?.[1];
  const copyright = /copyright: '([^']+)'/.exec(code)?.[1];
  if (!version || !copyright) throw new Error('legacy PDF.js: core-js copyright not found');
  return [
    `core-js ${version}, bundled in the legacy build of PDF.js.`,
    '',
    'MIT License',
    '',
    `Copyright ${copyright.replace(/ All rights reserved\.$/, '')}`,
    '',
    'Permission is hereby granted, free of charge, to any person obtaining a copy',
    'of this software and associated documentation files (the "Software"), to deal',
    'in the Software without restriction, including without limitation the rights',
    'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
    'copies of the Software, and to permit persons to whom the Software is',
    'furnished to do so, subject to the following conditions:',
    '',
    'The above copyright notice and this permission notice shall be included in',
    'all copies or substantial portions of the Software.',
    '',
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
    'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
    'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
    'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
    'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
    'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN',
    'THE SOFTWARE.',
    '',
  ].join('\n');
}

/**
 * Writes the PDF.js worker for the target's build, the cmaps and standard
 * fonts as small modules the page can import (the page may not fetch, even
 * its own files), and the image decoders that run without wasm. Returns the
 * files written.
 */
export async function buildPdfAssets(outDir: string, t: Target): Promise<string[]> {
  const out = resolve(outDir, PDF_DIR);
  const files: string[] = [];
  await build({
    configFile: false,
    logLevel: 'warn',
    publicDir: false,
    plugins: [pdfjsOffline()],
    resolve: { alias: pdfjsAlias(t) },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      outDir: out,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      target: 'es2022',
      lib: {
        entry: resolve(pkgDir, 'src/pdf/worker.ts'),
        formats: ['es'],
        fileName: () => 'worker.js',
      },
      rolldownOptions: { output: { legalComments: 'none' } as never },
    },
  });
  files.push(`${PDF_DIR}/worker.js`);

  // Binary data as base64 modules. Only licences the product may ship: the
  // Adobe cmaps (BSD) and the Foxit fonts (BSD). The Liberation fonts are left
  // out; PDF.js uses system fonts for the standard fonts they would replace.
  const data: [string, string, RegExp][] = [
    ['cmaps', 'cmaps', /\.bcmap$/],
    ['standard_fonts', 'fonts', /^Foxit.*\.pfb$/],
  ];
  for (const [src, dst, re] of data) {
    mkdirSync(join(out, dst), { recursive: true });
    for (const name of readdirSync(join(pdfjsDir, src))) {
      if (!re.test(name)) continue;
      const b64 = readFileSync(join(pdfjsDir, src, name)).toString('base64');
      const rel = `${PDF_DIR}/${dst}/${name}.js`;
      writeFileSync(join(outDir, rel), `export default ${JSON.stringify(b64)};\n`);
      files.push(rel);
    }
  }
  mkdirSync(join(out, 'wasm'), { recursive: true });
  // The image decoders in plain script, each with its licence files (BSD and Apache 2.0).
  for (const name of [
    'openjpeg_nowasm_fallback.js',
    'jbig2_nowasm_fallback.js',
    'LICENSE_OPENJPEG',
    'LICENSE_PDFJS_OPENJPEG',
    'LICENSE_JBIG2',
    'LICENSE_PDFJS_JBIG2',
  ]) {
    copyFileSync(join(pdfjsDir, 'wasm', name), join(out, 'wasm', name));
    files.push(`${PDF_DIR}/wasm/${name}`);
  }
  // PDF.js is Apache 2.0, the cmaps and Foxit fonts BSD, core-js MIT. Their notices ship with them.
  for (const [src, name] of [
    ['LICENSE', 'LICENSE-pdfjs.txt'],
    ['cmaps/LICENSE', 'LICENSE-cmaps.txt'],
    ['standard_fonts/LICENSE_FOXIT', 'LICENSE-foxit.txt'],
  ] as const) {
    copyFileSync(join(pdfjsDir, src), join(out, name));
    files.push(`${PDF_DIR}/${name}`);
  }
  const coreJs = coreJsLicense(t);
  if (coreJs) {
    writeFileSync(join(out, CORE_JS_LICENSE), coreJs);
    files.push(`${PDF_DIR}/${CORE_JS_LICENSE}`);
  }
  return files;
}

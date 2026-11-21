/**
 * Parser-based scan for network use in shipped files (DESIGN 9, CONTRACT 2).
 * Scripts are parsed, so comments and licence text are never matched, and a call
 * cannot hide behind spacing, a member name or a string split in two.
 * The extension and the embed script both scan their builds with it, from their tests only.
 */
import { type Node, parse } from 'acorn';
import { fullAncestor, simple } from 'acorn-walk';

export interface Hit {
  /** Which rule matched. */
  rule:
    | 'api'
    | 'global-computed'
    | 'remote-string'
    | 'remote-assign'
    | 'remote-open'
    | 'worker'
    | 'import'
    | 'css'
    | 'html';
  /** The name or address that matched. */
  detail: string;
  /** For a fetch call: true when its first argument is provably the page's own address. */
  own?: boolean;
}

/** Names that reach the network, matched as identifiers, member names and literal keys. */
export const NET_NAMES = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'sendBeacon',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'importScripts',
]);

/** Objects through which a computed key could reach any of the names above. */
const GLOBALS = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames', 'navigator']);

const ATTRS = new Set(['src', 'href', 'action', 'location']);

// XML namespace names look like addresses but are never fetched. The XFA,
// XDP, XMP and signature names are compared against names inside PDF files.
const NAMESPACES = new Set([
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/2000/xmlns/',
  'http://www.w3.org/1999/XSL/Transform',
  'http://www.w3.org/2000/09/xmldsig#',
  'http://ns.adobe.com/xdp/',
  'http://ns.adobe.com/xdp/pdf/',
  'http://ns.adobe.com/xfdf/',
  'http://ns.adobe.com/xmpmeta/',
  'http://www.xfa.org/schema/xci/',
  'http://www.xfa.org/schema/xdc/',
  'http://www.xfa.org/schema/xfa-connection-set/',
  'http://www.xfa.org/schema/xfa-data/',
  'http://www.xfa.org/schema/xfa-data/1.0/',
  'http://www.xfa.org/schema/xfa-form/',
  'http://www.xfa.org/schema/xfa-locale-set/',
  'http://www.xfa.org/schema/xfa-source-set/',
  'http://www.xfa.org/schema/xfa-template/',
]);

// PDF.js parses link text from inside a PDF against these bases, and puts a
// scheme in front of links written as "www.". Nothing is requested.
const PARSE_BASES = new Set(['http://example.com', 'https://foo.bar']);
const SCHEME_PREFIX = /^http:\/\/\$\{\w+\}$/;

// The core-js polyfills in the legacy PDF.js build test the browser's own URL
// parser with these before they decide to replace it. Nothing is requested.
const URL_PROBES = new Set([
  'https://a',
  'https://a#б',
  'https://a/c%20d?a=1&c=3',
  'https://a@b',
  'https://x',
  'https://тест',
]);

export const inert = (u: string): boolean =>
  NAMESPACES.has(u) || PARSE_BASES.has(u) || URL_PROBES.has(u) || SCHEME_PREFIX.test(u);

const ADDRESS = /\b(?:https?|wss?|ftp):\/\/[^\s"'`)<>\\]*/gi;
const PROTO_RELATIVE = /^\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#]|$)/i;

/** Remote addresses inside one string value. */
export function remoteIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(ADDRESS)) if (!inert(m[0])) out.push(m[0]);
  if (PROTO_RELATIVE.test(s.trim())) out.push(s.trim());
  return out;
}

/** True when the value is itself a remote address, as a src or href would use it. */
const isRemote = (s: string): boolean => /^\s*(?:(?:https?|wss?|ftp):)?\/\//i.test(s) && !inert(s.trim());

// ESTree nodes have many shapes. The walk reads fields by name and checks each type first.
// biome-ignore lint/suspicious/noExplicitAny: see above.
type N = Node & Record<string, any>;

/**
 * Names in the file being scanned that hold one string for good: bound exactly once, by a
 * declaration with a string literal, and never assigned. Minified names are reused across
 * scopes, so a name bound anywhere else is left out.
 */
let consts = new Map<string, string>();

function findConsts(ast: N): Map<string, string> {
  const binds = new Map<string, number>();
  const value = new Map<string, string>();
  const assigned = new Set<string>();
  const bind = (p: N | null | undefined): void => {
    if (!p) return;
    if (p.type === 'Identifier') binds.set(p.name, (binds.get(p.name) ?? 0) + 1);
    else if (p.type === 'ObjectPattern')
      for (const q of p.properties) bind(q.type === 'RestElement' ? q : q.value);
    else if (p.type === 'ArrayPattern') for (const q of p.elements) bind(q);
    else if (p.type === 'RestElement') bind(p.argument);
    else if (p.type === 'AssignmentPattern') bind(p.left);
  };
  const fn = (f: N) => {
    bind(f.id);
    for (const p of f.params) bind(p);
  };
  simple(ast, {
    VariableDeclarator(d: N) {
      bind(d.id);
      if (d.id.type !== 'Identifier' || !d.init) return;
      if (d.init.type === 'Literal' && typeof d.init.value === 'string') value.set(d.id.name, d.init.value);
      // Minifiers write plain strings as templates with no holes.
      if (d.init.type === 'TemplateLiteral' && d.init.expressions.length === 0) {
        value.set(d.id.name, d.init.quasis[0].value.cooked ?? '');
      }
    },
    FunctionDeclaration: fn,
    FunctionExpression: fn,
    ArrowFunctionExpression: fn,
    ClassDeclaration: (c: N) => bind(c.id),
    CatchClause: (c: N) => bind(c.param),
    AssignmentExpression(a: N) {
      if (a.left.type === 'Identifier') assigned.add(a.left.name);
    },
    UpdateExpression(u: N) {
      if (u.argument.type === 'Identifier') assigned.add(u.argument.name);
    },
  });
  const out = new Map<string, string>();
  for (const [k, v] of value) if (binds.get(k) === 1 && !assigned.has(k)) out.set(k, v);
  return out;
}

/** The constant string value of a node, folding literal concatenation. Templates keep ${x} holes. */
function str(n: N | null | undefined, src: string): string | undefined {
  if (!n) return undefined;
  if (n.type === 'Identifier') return consts.get(n.name);
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral') {
    let s = '';
    n.quasis.forEach((q: N, i: number) => {
      s += q.value.cooked ?? q.value.raw;
      const e = n.expressions[i];
      const known = e?.type === 'Identifier' ? consts.get(e.name) : undefined;
      if (known !== undefined) s += known;
      else if (e) s += `\${${src.slice(e.start, e.end)}}`;
    });
    return s;
  }
  if (n.type === 'BinaryExpression' && n.operator === '+') {
    const a = str(n.left, src);
    const b = str(n.right, src);
    if (a !== undefined && b !== undefined) return a + b;
  }
  return undefined;
}

const nameOf = (n: N | undefined): string | undefined =>
  !n
    ? undefined
    : n.type === 'Identifier'
      ? n.name
      : n.type === 'MemberExpression' && !n.computed
        ? n.property.name
        : n.type === 'MemberExpression' && n.property.type === 'Literal'
          ? String(n.property.value)
          : undefined;

/** location.href, window.location.href or document.location.href. */
function isOwnHref(n: N): boolean {
  if (n.type !== 'MemberExpression' || nameOf(n) !== 'href') return false;
  const o = n.object as N;
  if (o.type === 'Identifier') return o.name === 'location';
  return (
    nameOf(o) === 'location' &&
    o.object.type === 'Identifier' &&
    ['window', 'document', 'self', 'globalThis'].includes(o.object.name)
  );
}

const FUNCS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * True when the identifier, used inside fn, is a local that holds location.href:
 * one declaration with that initialiser and no later assignment.
 */
function localIsOwnHref(fn: N, name: string): boolean {
  let decl = 0;
  let good = 0;
  let assigned = false;
  simple(fn.body, {
    VariableDeclarator(d: N) {
      if (d.id.type !== 'Identifier' || d.id.name !== name) return;
      decl++;
      if (d.init && isOwnHref(d.init)) good++;
    },
    AssignmentExpression(a: N) {
      if (a.left.type === 'Identifier' && a.left.name === name) assigned = true;
    },
  });
  return decl === 1 && good === 1 && !assigned;
}

/**
 * True when the first argument of a fetch call is the page's own address: location.href itself,
 * or a parameter of a named function that every caller in the file passes location.href to.
 */
function fetchesOwnAddress(call: N, ancestors: N[], program: N): boolean {
  const arg = call.arguments[0] as N | undefined;
  if (!arg) return false;
  if (isOwnHref(arg)) return true;
  if (arg.type !== 'Identifier') return false;
  const fn = [...ancestors].reverse().find((a) => FUNCS.has(a.type));
  if (!fn) return false;
  if (localIsOwnHref(fn, arg.name)) return true;
  const idx = fn.params.findIndex((p: N) => p.type === 'Identifier' && p.name === arg.name);
  const fname = fn.type === 'FunctionDeclaration' ? fn.id?.name : undefined;
  if (idx < 0 || !fname) return false;
  let calls = 0;
  let ok = true;
  fullAncestor(program, (n: N, _s, anc: N[]) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier' || n.callee.name !== fname) return;
    calls++;
    const a = n.arguments[idx] as N | undefined;
    const caller = [...anc]
      .slice(0, -1)
      .reverse()
      .find((x) => FUNCS.has(x.type));
    if (!a) ok = false;
    else if (isOwnHref(a)) return;
    else if (a.type !== 'Identifier' || !caller || !localIsOwnHref(caller, a.name)) ok = false;
  });
  return calls > 0 && ok;
}

/** Dynamic and static imports may only name files inside the extension. */
function localImport(n: N, src: string): boolean {
  const s = str(n, src);
  if (s !== undefined) return /^\.{0,2}\//.test(s) && !s.startsWith('//');
  // The stub and loader import their chunks by runtime.getURL(...), which is inside the extension.
  return n.type === 'CallExpression' && nameOf(n.callee) === 'getURL';
}

function parseJs(text: string): N {
  const o = { ecmaVersion: 'latest', allowHashBang: true } as const;
  try {
    return parse(text, { ...o, sourceType: 'module' }) as N;
  } catch {
    return parse(text, { ...o, sourceType: 'script', allowReturnOutsideFunction: true }) as N;
  }
}

export function scanJs(text: string): Hit[] {
  const ast = parseJs(text);
  consts = findConsts(ast);
  const hits: Hit[] = [];
  const api = (detail: string) => hits.push({ rule: 'api', detail });
  const keys = (props: N[]) => {
    for (const p of props) {
      if (p.type !== 'Property') continue;
      const k = p.computed ? str(p.key, text) : p.key.type === 'Identifier' ? p.key.name : p.key.value;
      if (typeof k === 'string' && NET_NAMES.has(k)) api(k);
    }
  };
  fullAncestor(ast, (node, _s, ancestors) => {
    const n = node as N;
    const parent = ancestors[ancestors.length - 2] as N | undefined;
    switch (n.type) {
      case 'Identifier':
        if (!NET_NAMES.has(n.name)) break;
        if (n.name === 'fetch' && parent?.type === 'CallExpression' && parent.callee === n) {
          hits.push({ rule: 'api', detail: 'fetch', own: fetchesOwnAddress(parent, ancestors as N[], ast) });
        } else api(n.name);
        break;
      case 'MemberExpression': {
        const key = n.computed ? str(n.property, text) : n.property.name;
        if (typeof key === 'string' && NET_NAMES.has(key)) {
          if (key === 'fetch' && parent?.type === 'CallExpression' && parent.callee === n) {
            hits.push({
              rule: 'api',
              detail: 'fetch',
              own: fetchesOwnAddress(parent, ancestors as N[], ast),
            });
          } else api(key);
        }
        if (n.computed && key === undefined && n.object.type === 'Identifier' && GLOBALS.has(n.object.name)) {
          hits.push({
            rule: 'global-computed',
            detail: `${n.object.name}[${text.slice(n.property.start, n.property.end)}]`,
          });
        }
        break;
      }
      case 'ObjectExpression':
      case 'ObjectPattern':
        keys(n.properties);
        break;
      case 'Literal':
        if (typeof n.value === 'string') {
          for (const u of remoteIn(n.value)) hits.push({ rule: 'remote-string', detail: u });
        }
        break;
      case 'TemplateLiteral':
        for (const u of remoteIn(str(n, text) ?? '')) hits.push({ rule: 'remote-string', detail: u });
        break;
      case 'BinaryExpression': {
        // Only the outermost concatenation is checked, so a split address is seen whole.
        if (n.operator !== '+' || parent?.type === 'BinaryExpression') break;
        const s = str(n, text);
        if (s === undefined) break;
        // Addresses whole inside one literal are reported by that literal already.
        const parts = new Set<string>();
        simple(n, {
          Literal(l: N) {
            if (typeof l.value === 'string') for (const u of remoteIn(l.value)) parts.add(u);
          },
        });
        for (const u of remoteIn(s)) if (!parts.has(u)) hits.push({ rule: 'remote-string', detail: u });
        break;
      }
      case 'AssignmentExpression': {
        const target = n.left.type === 'Identifier' ? n.left.name : nameOf(n.left);
        const s = str(n.right, text);
        if (target && ATTRS.has(target) && s !== undefined && isRemote(s)) {
          hits.push({ rule: 'remote-assign', detail: `${target} = ${s}` });
        }
        break;
      }
      case 'CallExpression': {
        const callee = nameOf(n.callee);
        const a0 = str(n.arguments[0], text);
        const a1 = str(n.arguments[1], text);
        if (
          callee === 'setAttribute' &&
          a0 &&
          ATTRS.has(a0.toLowerCase()) &&
          a1 !== undefined &&
          isRemote(a1)
        ) {
          hits.push({ rule: 'remote-assign', detail: `${a0} = ${a1}` });
        }
        if (callee === 'open' && a0 !== undefined && isRemote(a0))
          hits.push({ rule: 'remote-open', detail: a0 });
        break;
      }
      case 'NewExpression': {
        const callee = nameOf(n.callee);
        const a0 = str(n.arguments[0], text);
        if ((callee === 'Worker' || callee === 'SharedWorker') && a0 !== undefined && isRemote(a0)) {
          hits.push({ rule: 'worker', detail: a0 });
        }
        break;
      }
      case 'ImportExpression':
        if (!localImport(n.source, text))
          hits.push({ rule: 'import', detail: text.slice(n.source.start, n.source.end) });
        break;
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
        if (n.source && !localImport(n.source, text))
          hits.push({ rule: 'import', detail: String(n.source.value) });
        break;
    }
  });
  return hits;
}

/** url() and @import in a style sheet. */
export function scanCss(text: string): Hit[] {
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const hits: Hit[] = [];
  for (const m of css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (isRemote(m[2]!)) hits.push({ rule: 'css', detail: m[2]! });
  }
  for (const m of css.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1/gi)) {
    if (isRemote(m[2]!)) hits.push({ rule: 'css', detail: m[2]! });
  }
  return hits;
}

/** Resource hints, remote attributes, inline scripts and inline styles in a page. */
export function scanHtml(text: string): Hit[] {
  const html = text.replace(/<!--[\s\S]*?-->/g, '');
  const hits: Hit[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*(['"]?)([^'">]*)\1/i.exec(m[0])?.[2] ?? '';
    for (const r of rel.toLowerCase().split(/\s+/)) {
      if (['prefetch', 'preconnect', 'dns-prefetch', 'prerender'].includes(r))
        hits.push({ rule: 'html', detail: `rel=${r}` });
    }
  }
  for (const m of html.matchAll(
    /\b(src|href|action|poster|data|srcset|formaction)\s*=\s*(['"]?)([^'"\s>]*)\2/gi,
  )) {
    if (isRemote(m[3]!)) hits.push({ rule: 'html', detail: `${m[1]}=${m[3]}` });
  }
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1]!.trim()) hits.push(...scanJs(m[1]!));
  }
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) hits.push(...scanCss(m[1]!));
  return hits;
}

/** Every string value in a JSON file that is a remote address. */
export function scanJson(text: string): Hit[] {
  const hits: Hit[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') for (const u of remoteIn(v)) hits.push({ rule: 'remote-string', detail: u });
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
  };
  walk(JSON.parse(text));
  return hits;
}

export function scanFile(name: string, text: string): Hit[] {
  if (/\.m?js$/.test(name)) return scanJs(text);
  if (name.endsWith('.css')) return scanCss(text);
  if (name.endsWith('.html')) return scanHtml(text);
  if (name.endsWith('.json')) return scanJson(text);
  return [];
}

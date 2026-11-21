/**
 * Finds uses of recent JavaScript built-ins in shipped code, and the polyfills
 * that cover them. It parses the code, so names in strings and comments do not
 * count. The list is short on purpose: the built-ins the modern PDF.js build
 * needs and the legacy build polyfills (found by comparing the two builds),
 * the ones the legacy build uses without a polyfill, and a few more that are
 * easy to reach for by accident.
 */
import { parseAst } from 'vite';

export type Browser = 'chrome' | 'firefox' | 'safari';

export interface Builtin {
  name: string;
  /** First version with it. Infinity: not relied on in any version, so it always needs a polyfill. */
  since: Record<Browser, number>;
  /** Owner.name for a static, Owner#name for a prototype method. */
  members: string[];
}

const iter = [
  'map',
  'filter',
  'take',
  'drop',
  'flatMap',
  'reduce',
  'toArray',
  'forEach',
  'some',
  'every',
  'find',
];

export const BUILTINS: Builtin[] = [
  {
    name: 'Iterator helpers',
    since: { chrome: 122, firefox: 131, safari: 18.4 },
    members: ['Iterator.from', ...iter.map((m) => `Iterator#${m}`)],
  },
  {
    name: 'Map and WeakMap getOrInsert',
    since: { chrome: Infinity, firefox: Infinity, safari: Infinity },
    members: ['Map', 'WeakMap'].flatMap((o) => [`${o}#getOrInsert`, `${o}#getOrInsertComputed`]),
  },
  {
    name: 'Math.sumPrecise',
    since: { chrome: Infinity, firefox: 137, safari: Infinity },
    members: ['Math.sumPrecise'],
  },
  { name: 'Promise.try', since: { chrome: 128, firefox: 134, safari: 18.2 }, members: ['Promise.try'] },
  {
    name: 'Promise.withResolvers',
    since: { chrome: 119, firefox: 121, safari: 17.4 },
    members: ['Promise.withResolvers'],
  },
  {
    name: 'AbortSignal.any',
    since: { chrome: 116, firefox: 124, safari: 17.4 },
    members: ['AbortSignal.any'],
  },
  {
    name: 'ArrayBuffer transfer',
    since: { chrome: 114, firefox: 122, safari: 17.4 },
    members: ['ArrayBuffer#transfer', 'ArrayBuffer#transferToFixedLength'],
  },
  {
    name: 'Set methods',
    since: { chrome: 122, firefox: 127, safari: 17 },
    members: [
      'union',
      'intersection',
      'difference',
      'symmetricDifference',
      'isSubsetOf',
      'isSupersetOf',
      'isDisjointFrom',
    ].map((m) => `Set#${m}`),
  },
  {
    name: 'Uint8Array base64 and hex',
    since: { chrome: 140, firefox: 133, safari: 18.2 },
    members: [
      'Uint8Array.fromBase64',
      'Uint8Array.fromHex',
      'Uint8Array#toBase64',
      'Uint8Array#toHex',
      'Uint8Array#setFromBase64',
      'Uint8Array#setFromHex',
    ],
  },
  { name: 'URL.parse', since: { chrome: 126, firefox: 126, safari: 18 }, members: ['URL.parse'] },
  {
    name: 'Response and Blob bytes',
    since: { chrome: 132, firefox: 128, safari: 18 },
    members: ['Response#bytes', 'Blob#bytes'],
  },
  {
    name: 'groupBy',
    since: { chrome: 117, firefox: 119, safari: 17.4 },
    members: ['Object.groupBy', 'Map.groupBy'],
  },
  { name: 'RegExp.escape', since: { chrome: 136, firefox: 134, safari: 18.2 }, members: ['RegExp.escape'] },
];

/**
 * A prototype method is seen as a call `x.name(...)` on any value, since the
 * type is unknown. Iterator helpers share names with array methods, so they
 * count only on a fresh iterator, as in `m.values().map(...)`, except toArray,
 * which arrays do not have.
 */
const ITER_SOURCES = new Set(['values', 'keys', 'entries']);
const ANY_OWNER = new Set(['toArray']);

type N = { type: string; [k: string]: unknown };
const isNode = (v: unknown): v is N => !!v && typeof v === 'object' && typeof (v as N).type === 'string';

/** A string constant: 'x', "x" or `x`. Minifiers write strings as template literals. */
function str(n: N | undefined): string | null {
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && (n.expressions as N[]).length === 0) {
    const q = (n.quasis as N[])[0]?.value as { cooked?: string } | undefined;
    return q?.cooked ?? null;
  }
  return null;
}

function propName(m: N): string | null {
  const p = m.property as N;
  if (!m.computed && p.type === 'Identifier') return p.name as string;
  return m.computed ? str(p) : null;
}

function keyName(p: N): string | null {
  const k = p.key as N | undefined;
  if (!k) return null;
  if (!p.computed && k.type === 'Identifier') return k.name as string;
  return str(k);
}

/** Owner of a member expression: X for X.name, X# for X.prototype.name. */
function ownerOf(obj: N): string | null {
  if (obj.type === 'Identifier') return `${obj.name as string}.`;
  if (
    obj.type === 'MemberExpression' &&
    propName(obj) === 'prototype' &&
    (obj.object as N).type === 'Identifier'
  )
    return `${(obj.object as N).name as string}#`;
  return null;
}

export interface Scan {
  /** Owner.name, Owner#name, *#name for a call on any value. */
  uses: Set<string>;
  /** Owner.name and Owner#name that the code defines itself. */
  provides: Set<string>;
}

export function scan(code: string): Scan {
  const uses = new Set<string>();
  const provides = new Set<string>();
  const ast = parseAst(code) as unknown as N;

  const visit = (node: N, parent: N | null, key: string): void => {
    if (node.type === 'MemberExpression') {
      const name = propName(node);
      const obj = node.object as N;
      const owner = ownerOf(obj);
      if (name && parent?.type === 'AssignmentExpression' && key === 'left') {
        if (owner) provides.add(owner + name);
      } else if (name) {
        if (owner?.endsWith('.')) uses.add(owner + name);
        if (parent?.type === 'CallExpression' && key === 'callee') {
          uses.add(`*#${name}`);
          // m.values() with no argument. Object.keys(o) takes one and returns an array.
          const fresh = obj.type === 'CallExpression' && (obj.arguments as N[]).length === 0;
          const src = fresh ? (obj.callee as N) : null;
          if (src?.type === 'MemberExpression' && ITER_SOURCES.has(propName(src) ?? ''))
            uses.add(`Iterator#${name}`);
        }
      }
    }
    if (node.type === 'CallExpression') {
      const args = node.arguments as N[];
      // core-js: $({ target: 'Map', proto: true, ... }, { getOrInsertComputed: ... })
      const [opts, defs] = args;
      if (args.length === 2 && opts?.type === 'ObjectExpression' && defs?.type === 'ObjectExpression') {
        const props = (opts.properties as N[]).filter((p) => p.type === 'Property');
        const target = str(props.find((p) => keyName(p) === 'target')?.value as N | undefined);
        if (target) {
          const proto = props.some((p) => keyName(p) === 'proto');
          for (const p of defs.properties as N[]) {
            const k = p.type === 'Property' ? keyName(p) : null;
            if (k) provides.add(`${target}${proto ? '#' : '.'}${k}`);
          }
        }
      }
      // Object.defineProperty(X.prototype, 'name', ...)
      const callee = node.callee as N;
      const [on, nameArg] = args;
      const defined = str(nameArg);
      if (callee.type === 'MemberExpression' && propName(callee) === 'defineProperty' && on && defined) {
        const o =
          on.type === 'Identifier'
            ? `${on.name as string}.`
            : on.type === 'MemberExpression' &&
                propName(on) === 'prototype' &&
                (on.object as N).type === 'Identifier'
              ? `${(on.object as N).name as string}#`
              : null;
        if (o) provides.add(o + defined);
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
  return { uses, provides };
}

/** The built-ins a file uses that a browser at version v lacks and the file does not polyfill. */
export function tooNew(s: Scan, browser: Browser, v: number): string[] {
  const out: string[] = [];
  for (const b of BUILTINS) {
    if (v >= b.since[browser]) continue;
    const bad = new Set<string>();
    for (const m of b.members) {
      const isProto = m.includes('#');
      const [owner, name] = m.split(isProto ? '#' : '.') as [string, string];
      const generic = owner !== 'Iterator' || ANY_OWNER.has(name);
      const used = s.uses.has(m) || (isProto && generic && s.uses.has(`*#${name}`));
      if (!used) continue;
      // A call on any value needs every owner of that name covered.
      const owners = isProto && generic ? b.members.filter((x) => x.endsWith(`#${name}`)) : [m];
      for (const o of owners) if (!s.provides.has(o)) bad.add(`${b.name}: ${o}`);
    }
    out.push(...bad);
  }
  return out.sort();
}

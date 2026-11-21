// Prints the size of each built file, minified and gzipped.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const dist = resolve(import.meta.dirname, '../dist');
const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) {
      if (n !== 'types') walk(p);
    } else if (/\.(m?js)$/.test(n)) files.push(p);
  }
};
walk(dist);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
let esm = 0;
let esmGz = 0;
for (const f of files.sort()) {
  const buf = readFileSync(f);
  const gz = gzipSync(buf, { level: 9 }).length;
  if (f.endsWith('.mjs')) {
    esm += buf.length;
    esmGz += gz;
  }
  console.log(`${relative(dist, f).padEnd(36)} ${kb(buf.length).padStart(9)}  gzip ${kb(gz).padStart(8)}`);
}
console.log(`${'all .mjs files'.padEnd(36)} ${kb(esm).padStart(9)}  gzip ${kb(esmGz).padStart(8)}`);

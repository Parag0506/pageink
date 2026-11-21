/**
 * A small QR code maker for the terminal, so the iPad's camera can open the check page.
 * Byte mode, error correction level L, versions 1 to 5 (up to 106 bytes), mask 0.
 * It follows the layout in ISO/IEC 18004. Test only: nothing here ships.
 *
 *   tsx apple/device/qr.ts <address>     prints the address in big digits and as a QR code
 */

const DATA = [0, 19, 34, 55, 80, 108];
const EC = [0, 7, 10, 15, 20, 26];

function mul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function divisor(degree: number): number[] {
  const r = new Array<number>(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      r[j] = mul(r[j]!, root);
      if (j + 1 < degree) r[j] = r[j]! ^ r[j + 1]!;
    }
    root = mul(root, 2);
  }
  return r;
}

function remainder(data: number[], div: number[]): number[] {
  const r = new Array<number>(div.length).fill(0);
  for (const b of data) {
    const f = b ^ r.shift()!;
    r.push(0);
    for (let i = 0; i < div.length; i++) r[i] = r[i]! ^ mul(div[i]!, f);
  }
  return r;
}

/** The QR code for text as rows of booleans, true for dark. */
export function qr(text: string): boolean[][] {
  const bytes = [...Buffer.from(text, 'utf8')];
  let ver = 1;
  while (ver <= 5 && bytes.length + 2 > DATA[ver]!) ver++;
  if (ver > 5) throw new Error('Too long for this QR maker');
  const cap = DATA[ver]!;

  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(Number.parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < cap; pad ^= 0xec ^ 0x11) data.push(pad);
  const all = [...data, ...remainder(data, divisor(EC[ver]!))];

  const size = 17 + 4 * ver;
  const m = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    m[y]![x] = dark;
    fn[y]![x] = true;
  };
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (ver > 1) {
    const c = size - 7;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) set(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  // Format bits: level L (1) and mask 0, with their BCH code.
  const fmt = (1 << 3) | 0;
  let rem = fmt;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const f = ((fmt << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((f >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);

  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
        if (fn[y]![x]) continue;
        const dark = i < all.length * 8 ? ((all[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1 : false;
        i++;
        // Mask 0.
        m[y]![x] = dark !== ((x + y) % 2 === 0);
      }
    }
  }
  return m;
}

/** The code drawn with terminal colours, two characters per module, with a quiet zone. */
export function qrText(text: string): string {
  const m = qr(text);
  const q = 2;
  const light = '\x1b[47m  \x1b[0m';
  const dark = '\x1b[40m  \x1b[0m';
  const rows: string[] = [];
  for (let y = -q; y < m.length + q; y++) {
    let line = '';
    for (let x = -q; x < m.length + q; x++) line += m[y]?.[x] ? dark : light;
    rows.push(line);
  }
  return rows.join('\n');
}

/** Big digits for the address, for reading it off the screen and typing it in. */
const BIG: Record<string, string[]> = {
  '0': ['███', '█ █', '█ █', '█ █', '███'],
  '1': [' █ ', '██ ', ' █ ', ' █ ', '███'],
  '2': ['███', '  █', '███', '█  ', '███'],
  '3': ['███', '  █', '███', '  █', '███'],
  '4': ['█ █', '█ █', '███', '  █', '  █'],
  '5': ['███', '█  ', '███', '  █', '███'],
  '6': ['███', '█  ', '███', '█ █', '███'],
  '7': ['███', '  █', '  █', '  █', '  █'],
  '8': ['███', '█ █', '███', '█ █', '███'],
  '9': ['███', '█ █', '███', '  █', '███'],
  '.': ['   ', '   ', '   ', '   ', ' █ '],
  ':': ['   ', ' █ ', '   ', ' █ ', '   '],
};

export function bigText(s: string): string {
  const rows = ['', '', '', '', ''];
  for (const c of s) {
    const g = BIG[c] ?? ['   ', '   ', '   ', '   ', '   '];
    for (let r = 0; r < 5; r++) rows[r] += `${g[r]} `;
  }
  return rows.join('\n');
}

if (process.argv[1]?.endsWith('qr.ts') && process.argv[2]) {
  const url = process.argv[2];
  const host = new URL(url).host;
  console.log(`\nOpen this address in Safari on the iPad:\n\n  ${url}\n`);
  console.log(bigText(host));
  console.log('\nOr point the iPad camera at this code:\n');
  console.log(qrText(url));
  console.log('');
}

/**
 * Writes small test PDFs by hand: several pages of Helvetica text, no fonts
 * embedded, no third-party files. Same input, same bytes, so the PDF.js
 * fingerprint is stable across runs and file names.
 */

export interface PdfSpec {
  /** One entry per page. Each page is a list of text lines from the top. */
  pages: string[][];
  /** Page size in PDF points. Default US Letter. */
  w?: number;
  h?: number;
  title?: string;
  /** Sixteen bytes as hex for the trailer /ID. */
  id?: string;
  /** Size of single pages, by index from 0, when it differs from w and h. */
  sizes?: Record<number, { w: number; h: number }>;
  /** Link areas. rect is in PDF points from the bottom left. A link has a web address or a page to go to. */
  links?: {
    page: number;
    rect: [number, number, number, number];
    uri?: string;
    to?: { page: number; y: number };
  }[];
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf(spec: PdfSpec): Buffer {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add('');
  const pages = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title (${esc(spec.title ?? 'Test document')}) /Producer (ink tests) >>`);
  // Page objects come first, so links can point at any page.
  const kids: number[] = spec.pages.map(() => add(''));
  spec.pages.forEach((lines, i) => {
    const w = spec.sizes?.[i]?.w ?? spec.w ?? 612;
    const h = spec.sizes?.[i]?.h ?? spec.h ?? 792;
    // Page number big at the top, then the lines.
    const body: string[] = ['BT', `/F1 20 Tf 72 ${h - 72} Td (Page ${i + 1}) Tj`, 'ET'];
    let y = h - 120;
    for (const line of lines) {
      body.push('BT', `/F1 14 Tf 72 ${y} Td (${esc(line)}) Tj`, 'ET');
      y -= 22;
    }
    // A thin frame so a page is easy to spot in screenshots.
    body.push('0.8 G 0.5 w 36 36 m', `${w - 36} 36 l ${w - 36} ${h - 36} l 36 ${h - 36} l h S`);
    const stream = body.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const annots = (spec.links ?? [])
      .filter((l) => l.page === i)
      .map((l) => {
        const action = l.uri
          ? `/A << /S /URI /URI (${esc(l.uri)}) >>`
          : `/Dest [${kids[l.to!.page]} 0 R /XYZ 0 ${l.to!.y} 0]`;
        return add(`<< /Type /Annot /Subtype /Link /Rect [${l.rect.join(' ')}] /Border [0 0 0] ${action} >>`);
      });
    const list = annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : '';
    objs[kids[i]! - 1] =
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R${list} >>`;
  });
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objs[pages - 1] =
    `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  const id = spec.id ?? '00112233445566778899aabbccddeeff';
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>\n`;
  out += `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Sentences with words that occur once, so tests can find them in the text layer. */
export function paperPages(n: number, tag = 'doc'): string[][] {
  const out: string[][] = [];
  for (let p = 1; p <= n; p++) {
    out.push([
      `Section ${p} of the ${tag} test paper.`,
      `The marker word for this page is quokka${p} and it sits here.`,
      'Lines of plain text fill the page so selection and marks have',
      'something to hold on to. Each line is set in Helvetica at fourteen.',
      `Another line names the zebra${p} so a second target exists.`,
      'The quick brown fox jumps over the lazy dog near the river bank.',
      'Pack my box with five dozen liquor jugs before the night is over.',
    ]);
  }
  return out;
}

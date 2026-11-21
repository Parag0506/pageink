import type { Note, ToMarkdown } from '../types';
import { addresses } from './identity';
import { showsInk } from './patch';

function kindOf(n: Note): string {
  if (n.kind === 'textmark') return n.mark?.style ?? 'highlight';
  return n.strokes.length > 0 && n.strokes.every((s) => s.tool === 'hi') ? 'highlight' : 'handwriting';
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** One line of plain text: Markdown control characters at line start would change the meaning. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Records can come from a synced folder, so their text is data. Characters that could start
 * a link, an image, inline HTML, code or emphasis are escaped.
 */
const text = (s: string) => oneLine(s).replace(/[\\`*_[\]()<>!|~&]/g, '\\$&');

/** Only http and https addresses become links. Anything else is written as plain text. */
function link(s: string): string {
  try {
    const u = new URL(s);
    if (u.protocol === 'http:' || u.protocol === 'https:') return `<${u.href}>`;
  } catch {
    // Not an address at all.
  }
  return text(s);
}

export const toMarkdown: ToMarkdown = (records) => {
  const parts: string[] = [];
  // A note the merge left with no strokes shows nothing, so it is not exported.
  const pages = records
    .map((r) => ({ r, shown: r.notes.filter(showsInk) }))
    .filter((p) => p.shown.length > 0)
    .sort((a, b) => b.r.updatedAt - a.r.updatedAt);
  for (const { r, shown } of pages) {
    const address = addresses(r)[0] ?? r.key;
    const lines = [`## ${text(r.title) || text(address)}`, '', link(address), ''];
    const notes = [...shown].sort(
      (a, b) => a.anchor.pos.start - b.anchor.pos.start || a.createdAt - b.createdAt,
    );
    for (const n of notes) {
      const quote = text(n.anchor.quote.exact);
      if (quote) lines.push(`> ${quote}`, '');
      const kind = kindOf(n);
      lines.push(`- ${kind[0]!.toUpperCase()}${kind.slice(1)}, ${day(n.createdAt)}`);
      if (n.anchor.link) lines.push(`- Link: ${link(n.anchor.link)}`);
      lines.push('');
    }
    parts.push(lines.join('\n'));
  }
  return parts.length ? `# Notes\n\n${parts.join('\n')}` : '# Notes\n';
};

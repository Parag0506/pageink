import { describe, expect, it } from 'vitest';
import { toMarkdown } from './markdown';
import { anchor, note, record, stroke } from './testkit';

describe('toMarkdown', () => {
  it('lists each page with its notes, quotes, kinds, dates and links', () => {
    const day = Date.UTC(2026, 0, 2);
    const rec = record({
      title: 'A page',
      urls: ['host:example.com', 'https://example.com/a'],
      notes: [
        note({
          createdAt: day,
          anchor: anchor({
            quote: { exact: 'second\nline', prefix: '', suffix: '' },
            pos: { start: 50, end: 60 },
          }),
          strokes: [stroke({ tool: 'hi' })],
        }),
        note({ createdAt: day, anchor: anchor({ link: 'https://example.com/ref' }) }),
        note({
          createdAt: day,
          kind: 'textmark',
          mark: { style: 'strike', color: 'ink-1' },
          anchor: anchor({ pos: { start: 70, end: 80 } }),
        }),
      ],
    });
    const empty = record({ key: 'https://example.com/empty', title: 'Empty' });
    const md = toMarkdown([rec, empty]);
    expect(md).toContain('## A page');
    expect(md).toContain('<https://example.com/a>');
    expect(md).not.toContain('host:');
    expect(md).not.toContain('Empty');
    expect(md).toContain('> second line');
    expect(md).toContain('- Handwriting, 2026-01-02\n- Link: <https://example.com/ref>');
    expect(md).toContain('- Highlight, 2026-01-02');
    expect(md).toContain('- Strike, 2026-01-02');
    expect(md).not.toMatch(/data:|<img|!\[/);
    // Notes in reading order.
    expect(md.indexOf('Handwriting')).toBeLessThan(md.indexOf('Highlight'));
  });

  it('writes only http and https links as links; anything else is plain escaped text', () => {
    const rec = record({
      title: 'Links',
      urls: ['javascript:alert(1)'],
      notes: [
        note({ anchor: anchor({ link: 'javascript:alert(document.cookie)' }) }),
        note({ anchor: anchor({ link: 'data:text/html,<script>x</script>', pos: { start: 5, end: 6 } }) }),
        note({ anchor: anchor({ link: 'http://example.com/a b', pos: { start: 7, end: 8 } }) }),
      ],
    });
    const md = toMarkdown([rec]);
    expect(md).not.toContain('<javascript:');
    expect(md).not.toContain('<data:');
    expect(md).not.toContain('<script>');
    expect(md).toContain('- Link: javascript:alert\\(document.cookie\\)');
    expect(md).toContain('- Link: <http://example.com/a%20b>');
  });

  it('escapes Markdown in titles and quotes so a record cannot inject markup', () => {
    const rec = record({
      title: '[click](https://evil.example) <img src=x onerror=alert(1)> **bold**',
      notes: [
        note({
          anchor: anchor({
            quote: { exact: '![pic](https://evil.example/p.png) `code` _em_ &amp;', prefix: '', suffix: '' },
          }),
        }),
      ],
    });
    const md = toMarkdown([rec]);
    expect(md).toContain(
      '## \\[click\\]\\(https://evil.example\\) \\<img src=x onerror=alert\\(1\\)\\> \\*\\*bold\\*\\*',
    );
    expect(md).toContain('> \\!\\[pic\\]\\(https://evil.example/p.png\\) \\`code\\` \\_em\\_ \\&amp;');
  });
});

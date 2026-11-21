// Adds content pairs to sources.json with exact, permanent addresses.
//
//   tsx src/add.ts wiki "Photosynthesis" 2025-09-01 2025-10-01 --change month --shape prose
//   tsx src/add.ts wayback https://example.org/post 2023-01-01 2024-06-01 --kind wayback --shape article
//   tsx src/add.ts arxiv 2401.04088
//   tsx src/add.ts url my-id https://a https://b --kind docs --change release --license "..." --commit
//
// Wikipedia dates pick the last revision at or before the date. Web archive dates pick the
// nearest snapshot that has different content from the other one.
import { parseArgs } from 'node:util';
import { loadSources, type Pair, type PairKind, saveSources } from './sources.ts';

const UA = 'pageink-testset/0.1 (anchor test set fetcher)';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<unknown> {
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, { headers: { 'user-agent': UA } });
    if (r.ok) return r.json();
    await sleep(1500 * (i + 1));
  }
  throw new Error(`failed: ${url}`);
}

async function getText(url: string): Promise<{ status: number; text: string }> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
      if (r.status === 429 || r.status >= 500) {
        await sleep(2000 * (i + 1));
        continue;
      }
      return { status: r.status, text: await r.text() };
    } catch {
      await sleep(2000 * (i + 1));
    }
  }
  return { status: 0, text: '' };
}

export async function wikiRevision(title: string, date: string): Promise<{ id: number; ts: string }> {
  const u = new URL('https://en.wikipedia.org/w/api.php');
  u.search = new URLSearchParams({
    action: 'query',
    prop: 'revisions',
    titles: title,
    rvstart: `${date}T00:00:00Z`,
    rvdir: 'older',
    rvlimit: '1',
    rvprop: 'ids|timestamp',
    format: 'json',
    formatversion: '2',
  }).toString();
  const d = (await getJson(u.toString())) as {
    query: { pages: { revisions?: { revid: number; timestamp: string }[] }[] };
  };
  const rev = d.query.pages[0]?.revisions?.[0];
  if (!rev) throw new Error(`no revision for ${title} at ${date}`);
  await sleep(400);
  return { id: rev.revid, ts: rev.timestamp };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);

/** Snapshots of url as [timestamp, digest] from the web archive index. */
async function cdx(url: string, from: string, to: string): Promise<[string, string][]> {
  const u = new URL('https://web.archive.org/cdx/search/cdx');
  u.search = new URLSearchParams({
    url,
    from: from.replace(/-/g, ''),
    to: to.replace(/-/g, ''),
    output: 'json',
    filter: 'statuscode:200',
    collapse: 'digest',
    fl: 'timestamp,digest',
    limit: '400',
  }).toString();
  const rows = (await getJson(u.toString())) as string[][];
  await sleep(800);
  return rows.slice(1).map((r) => [r[0]!, r[1]!]);
}

const tsOf = (date: string) => Number(date.replace(/-/g, '').padEnd(14, '0'));

/** Two snapshots near dateA and dateB with different content digests. */
export async function waybackPair(url: string, dateA: string, dateB: string): Promise<[string, string]> {
  const rows = await cdx(url, String(Number(dateA.slice(0, 4)) - 1), String(Number(dateB.slice(0, 4)) + 1));
  if (rows.length < 2) throw new Error(`fewer than two distinct snapshots for ${url}`);
  const near = (t: number, skip?: string) =>
    rows
      .filter((r) => r[1] !== skip)
      .reduce((best, r) => (Math.abs(Number(r[0]) - t) < Math.abs(Number(best[0]) - t) ? r : best));
  const a = near(tsOf(dateA));
  const b = near(tsOf(dateB), a[1]);
  return [a[0], b[0]];
}

const wb = (ts: string, url: string) => `https://web.archive.org/web/${ts}/${url}`;
const day = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;

function addPair(p: Pair): void {
  const s = loadSources();
  const i = s.pairs.findIndex((x) => x.id === p.id);
  if (i >= 0) s.pairs[i] = p;
  else s.pairs.push(p);
  saveSources(s);
  console.log(`${i >= 0 ? 'updated' : 'added'} ${p.id}: ${p.a.label} -> ${p.b.label}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      change: { type: 'string' },
      shape: { type: 'string', default: 'article' },
      kind: { type: 'string', default: 'wayback' },
      license: { type: 'string', default: 'unknown, not redistributed' },
      attribution: { type: 'string', default: '' },
      commit: { type: 'boolean', default: false },
      id: { type: 'string' },
    },
  });
  const [cmd, ...rest] = positionals;
  if (cmd === 'wiki') {
    const [title, da, db] = rest as [string, string, string];
    const [a, b] = [await wikiRevision(title, da), await wikiRevision(title, db)];
    const t = encodeURIComponent(title.replace(/ /g, '_'));
    const change = values.change ?? 'month';
    addPair({
      id: values.id ?? `wiki-${slug(title)}-${change}`,
      kind: 'wikipedia',
      change: `wiki-${change}`,
      shape: values.shape!,
      license: 'CC BY-SA 4.0',
      attribution: `Wikipedia contributors, "${title}", English Wikipedia, revisions ${a.id} and ${b.id}`,
      commit: true,
      a: {
        url: `https://en.wikipedia.org/w/index.php?title=${t}&oldid=${a.id}`,
        label: `rev ${a.id} ${a.ts.slice(0, 10)}`,
      },
      b: {
        url: `https://en.wikipedia.org/w/index.php?title=${t}&oldid=${b.id}`,
        label: `rev ${b.id} ${b.ts.slice(0, 10)}`,
      },
    });
  } else if (cmd === 'wayback') {
    const [url, da, db] = rest as [string, string, string];
    const [ta, tb] = await waybackPair(url, da, db);
    const host = new URL(url).hostname.replace(/^www\./, '');
    addPair({
      id: values.id ?? `wb-${slug(host + new URL(url).pathname)}`,
      kind: values.kind as PairKind,
      change: values.change ?? 'archive-time',
      shape: values.shape!,
      license: values.license!,
      attribution: values.attribution || url,
      commit: values.commit!,
      a: { url: wb(ta, url), label: `snapshot ${day(ta)}` },
      b: { url: wb(tb, url), label: `snapshot ${day(tb)}` },
    });
  } else if (cmd === 'arxiv') {
    const [id] = rest as [string];
    const v1 = await getText(`https://arxiv.org/html/${id}v1`);
    const v2 = await getText(`https://arxiv.org/html/${id}v2`);
    if (v1.status !== 200 || v2.status !== 200) throw new Error(`${id}: no HTML for v1 and v2`);
    const abs = await getText(`https://arxiv.org/abs/${id}v2`);
    const lic =
      /href="(https?:\/\/(?:creativecommons\.org|arxiv\.org\/licenses)[^"]+)"/.exec(abs.text)?.[1] ?? '';
    // Only CC BY and CC BY-SA allow the frozen copy to be committed.
    const open = /creativecommons\.org\/licenses\/by(-sa)?\//.test(lic);
    addPair({
      id: `arxiv-${id.replace('.', '-')}`,
      kind: 'arxiv',
      change: 'arxiv-version',
      shape: values.shape ?? 'paper',
      license: lic || 'arXiv non-exclusive licence',
      attribution: `arXiv:${id}, authors of the paper`,
      commit: open,
      a: { url: `https://arxiv.org/html/${id}v1`, label: 'v1' },
      b: { url: `https://arxiv.org/html/${id}v2`, label: 'v2' },
    });
  } else if (cmd === 'url') {
    const [id, ua, ub] = rest as [string, string, string];
    addPair({
      id,
      kind: values.kind as PairKind,
      change: values.change ?? 'release',
      shape: values.shape!,
      license: values.license!,
      attribution: values.attribution || ua,
      commit: values.commit!,
      a: { url: ua, label: ua },
      b: { url: ub, label: ub },
    });
  } else {
    console.error('usage: add.ts wiki|wayback|arxiv|url ...');
    process.exit(2);
  }
}

if (process.argv[1]?.endsWith('add.ts')) {
  main().catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
}

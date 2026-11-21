// Freezes a live page into a script-free fixture that lays out the same offline.
// The page side runs in the browser through page.evaluate. The node side fetches
// stylesheets, removes remote urls from them and stores them by content hash.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';

export const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Removes every remote url() from CSS. Data urls stay. Layout does not depend on them. */
export function stripCssUrls(css: string): string {
  return css.replace(/url\(\s*(['"]?)(?!data:)([^'")]*)\1\s*\)/gi, 'url("data:,")');
}

/**
 * Stylesheets that are not the page's own and are not kept: the Wayback Machine's toolbar and
 * icon styles, and font-service rules from Google Fonts and Adobe Fonts (Typekit). They state no
 * licence that allows sharing them, and they do not lay out the article. The address may sit
 * inside a Wayback address, so it is matched anywhere.
 */
export const DROPPED_SHEET =
  /\barchive\.org\/(?:_static|includes)\/|\bfonts\.googleapis\.com\/|\btypekit\.(?:net|com)\//i;

export const isDroppedSheet = (href: string): boolean => DROPPED_SHEET.test(href);

/** Runs in the page. Removes scripts and live resources and returns the serialised document. */
function freezeInPage(dropped: string): {
  html: string;
  sheets: { href: string; media: string }[];
  images: Record<string, [number, number]>;
} {
  const d = document;
  const sheets: { href: string; media: string }[] = [];
  // Images keep their address. Replay answers each with a blank picture of the recorded size.
  const images: Record<string, [number, number]> = {};
  const kill = (sel: string) => {
    for (const el of Array.from(d.querySelectorAll(sel))) el.remove();
  };
  const drop = new RegExp(dropped, 'i');
  // Web archive toolbar and its assets.
  kill('#wm-ipp-base, #wm-ipp-print, #donato, #wm-ipp, #wm-capinfo');
  const root = d.documentElement;
  root.style.removeProperty('--wm-toolbar-height');
  if (root.getAttribute('style')?.trim() === '') root.removeAttribute('style');
  for (const l of Array.from(d.querySelectorAll('link'))) {
    const rel = (l.getAttribute('rel') ?? '').toLowerCase();
    const href = l.href;
    if (rel.split(/\s+/).includes('stylesheet') && href && !drop.test(href)) {
      sheets.push({ href, media: l.media });
      l.setAttribute('href', `INKCSS:${sheets.length - 1}`);
      for (const a of Array.from(l.attributes)) {
        if (!['rel', 'href', 'media'].includes(a.name)) l.removeAttribute(a.name);
      }
    } else {
      l.remove();
    }
  }
  kill('script, noscript, object, embed, base, meta[http-equiv], template[shadowrootmode]');
  for (const el of Array.from(d.querySelectorAll('iframe, frame'))) {
    el.removeAttribute('src');
    el.setAttribute('srcdoc', '');
  }
  const ph = (w: number, h: number, key: string): string => {
    images[key] = [w, h];
    return key;
  };
  for (const img of Array.from(d.querySelectorAll('img'))) {
    const src = img.currentSrc || img.src;
    if (!src || src.startsWith('data:')) continue;
    const r = img.getBoundingClientRect();
    const w = img.naturalWidth || Number(img.getAttribute('width')) || Math.round(r.width) || 1;
    const h = img.naturalHeight || Number(img.getAttribute('height')) || Math.round(r.height) || 1;
    img.setAttribute('src', ph(w, h, src));
    for (const a of ['srcset', 'sizes', 'loading', 'decoding', 'fetchpriority']) img.removeAttribute(a);
  }
  kill('picture > source, video > source, audio > source, track');
  for (const v of Array.from(d.querySelectorAll('video, audio'))) {
    const r = v.getBoundingClientRect();
    const poster = v.getAttribute('poster');
    v.removeAttribute('src');
    v.setAttribute('preload', 'none');
    if (v instanceof HTMLVideoElement) {
      if (poster)
        v.setAttribute(
          'poster',
          ph(
            v.videoWidth || Math.round(r.width) || 1,
            v.videoHeight || Math.round(r.height) || 1,
            new URL(poster, location.href).toString(),
          ),
        );
    }
  }
  for (const el of Array.from(d.querySelectorAll('image, use'))) {
    for (const a of ['href', 'xlink:href']) {
      const v = el.getAttribute(a);
      if (v && !v.startsWith('#') && !v.startsWith('data:')) el.removeAttribute(a);
    }
  }
  const strip = (s: string) => s.replace(/url\(\s*(['"]?)(?!data:)([^'")]*)\1\s*\)/gi, 'url("data:,")');
  for (const s of Array.from(d.querySelectorAll('style'))) {
    const text = (s.textContent ?? '').replace(/@import[^;]*;/g, (m) => (drop.test(m) ? '' : m));
    s.textContent = strip(text);
  }
  const walker = d.createTreeWalker(d.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  for (let n: Node | null = walker.currentNode; n; n = walker.nextNode()) {
    if (n.nodeType === Node.COMMENT_NODE) {
      comments.push(n);
      continue;
    }
    const el = n as Element;
    for (const a of Array.from(el.attributes)) {
      if (a.name.startsWith('on')) el.removeAttribute(a.name);
      else if (a.name === 'style' && a.value.includes('url(')) el.setAttribute('style', strip(a.value));
      else if ((a.name === 'href' || a.name === 'action') && /^\s*javascript:/i.test(a.value))
        el.setAttribute(a.name, '#');
    }
  }
  for (const c of comments) c.parentNode?.removeChild(c);
  return { html: `<!doctype html>\n${d.documentElement.outerHTML}`, sheets, images };
}

async function fetchCss(page: Page, href: string, depth = 0): Promise<string> {
  if (depth > 4) return '';
  let text = '';
  try {
    const r = await page.request.get(href, { timeout: 30000 });
    if (!r.ok()) return '';
    text = await r.text();
  } catch {
    return '';
  }
  // Inline @import so the fixture needs no network.
  const imports = [...text.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?([^;]*);/g)];
  for (const m of imports) {
    const abs = new URL(m[1]!, href).toString();
    if (isDroppedSheet(abs)) {
      text = text.replace(m[0], '');
      continue;
    }
    const inner = await fetchCss(page, abs, depth + 1);
    const media = m[2]!.trim();
    text = text.replace(m[0], media ? `@media ${media} {\n${inner}\n}` : inner);
  }
  return stripCssUrls(text);
}

/** Blank picture of a recorded size, served in place of a real image during replay. */
export function placeholderSvg(url: string, w: number, h: number): string {
  const name = (url.split(/[?#]/)[0]!.split('/').pop() ?? '').replace(/[<&"]/g, '').slice(0, 60);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="#d8d8d8"/><text x="4" y="14" font-size="11" fill="#555">${name}</text></svg>`;
}

export interface Frozen {
  images: Record<string, [number, number]>;
  html: string;
  sha256: string;
  bytes: number;
  css: string[];
}

/**
 * Loads url, settles lazy content, freezes the page and writes it to outFile.
 * Stylesheets go to cssDir by content hash and are linked from cssHref.
 */
export async function freezeUrl(
  page: Page,
  url: string,
  outFile: string,
  cssDir: string,
  cssHref: (name: string) => string,
  stamp: string,
): Promise<Frozen> {
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  // Walk down the page so lazy images and sections load, then return to the top.
  await page.evaluate(async () => {
    const step = innerHeight * 0.9;
    for (let y = 0, i = 0; y < document.documentElement.scrollHeight && i < 80; y += step, i++) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 60));
    }
    scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  const { html, sheets, images } = await page.evaluate(freezeInPage, DROPPED_SHEET.source);
  mkdirSync(cssDir, { recursive: true });
  let out = html;
  const names: string[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const css = await fetchCss(page, sheets[i]!.href);
    const name = `${sha(css).slice(0, 16)}.css`;
    writeFileSync(join(cssDir, name), css);
    names.push(name);
    out = out.replace(`INKCSS:${i}"`, `${cssHref(name)}"`);
  }
  // Large inline style blocks are the same on every page of a site. Store them once.
  out = out.replace(/<style([^>]*)>([\s\S]*?)<\/style>/g, (m, attrs: string, body: string) => {
    if (body.length < 2000) return m;
    const name = `${sha(body).slice(0, 16)}.css`;
    writeFileSync(join(cssDir, name), body);
    names.push(name);
    const media = /media="[^"]*"/.exec(attrs)?.[0];
    return `<link rel="stylesheet" href="${cssHref(name)}"${media ? ` ${media}` : ''}>`;
  });
  out = out.replace(
    /<head[^>]*>/i,
    (h) => `${h}\n<meta name="ink-fixture" content="${url.replace(/"/g, '&quot;')} | frozen ${stamp}">`,
  );
  writeFileSync(outFile, out);
  return { html: out, sha256: sha(out), bytes: Buffer.byteLength(out), css: names, images };
}

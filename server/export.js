'use strict';
/**
 * HTML export: the built app + this wiki's data as a standalone static site.
 * Every page gets its own index.html so it works on any static host (and on
 * a subdomain root), and the chat box falls back to searching the wiki text.
 * Also: a small dependency-free ZIP writer, and PDF printing via Playwright.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./store');

const DIST = path.join(__dirname, '..', 'dist');
const DEMO_ROUTES = new Set(['microsoft', 'huggingface', 'opendatalab']);

function slugify(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'page';
}

/** Same ordering/numbering as the browser (src/lib/wiki.js orderPages). */
function orderPages(pages) {
  const byPath = new Map(pages.map(p => [p.path, p]));
  const children = new Map();
  const roots = [];
  for (const page of pages) {
    const parent = page.parent && byPath.has(page.parent) && page.parent !== page.path ? page.parent : null;
    if (parent) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(page); } else roots.push(page);
  }
  const out = [];
  const seen = new Set();
  const walk = (list, prefix, depth) => list.forEach((page, i) => {
    if (seen.has(page.path)) return;
    seen.add(page.path);
    const num = prefix ? `${prefix}.${i + 1}` : String(i + 1);
    out.push({ ...page, num, depth, slug: `${num}-${slugify(page.title)}` });
    walk(children.get(page.path) || [], num, depth + 1);
  });
  walk(roots, '', 0);
  return out;
}

function copyDir(src, dest, skipTop) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipTop && skipTop.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function validateWiki(wiki) {
  if (!wiki || typeof wiki !== 'object') throw new Error('Missing wiki');
  const ok = s => typeof s === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(s) && s !== '..' && s !== '.';
  if (!ok(wiki.owner) || !ok(wiki.repo)) throw new Error('Invalid wiki name');
  if (!Array.isArray(wiki.pages) || !wiki.pages.length) throw new Error('The wiki has no pages');
  return {
    owner: wiki.owner,
    repo: wiki.repo,
    description: String(wiki.description || '').slice(0, 1000),
    lastIndexed: wiki.lastIndexed || null,
    commit: String(wiki.commit || '').slice(0, 64),
    source: wiki.source && wiki.source.type === 'github' ? { type: 'github', url: String(wiki.source.url || ''), commit: String(wiki.source.commit || '') } : null,
    pages: wiki.pages.map(p => ({ path: String(p.path), title: String(p.title), parent: p.parent ? String(p.parent) : null, markdown: String(p.markdown || '') })),
  };
}

/** Prefers the stored copy of a local wiki (fresh from disk) over what the browser sent. */
function resolveWiki(wiki) {
  const record = store.findWikiRecord(wiki.owner, wiki.repo);
  if (record) {
    const content = store.loadWikiContent(record);
    if (content) return validateWiki({ ...content, source: content.source && content.source.type === 'github' ? content.source : null });
  }
  return validateWiki(wiki);
}

function exportSite(wikiInput, destDir, { domain } = {}) {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error('The app is not built yet: run “npm run build” first.');
  const wiki = resolveWiki(wikiInput);
  copyDir(DIST, destDir, new Set([...DEMO_ROUTES, '404.html', 'index.html']));
  const data = { ...wiki, id: `${wiki.owner}/${wiki.repo}`, exported: true };
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  fs.writeFileSync(path.join(destDir, 'wiki-data.js'),
    `window.__RW_EXPORT__=${JSON.stringify({ owner: wiki.owner, repo: wiki.repo })};\nwindow.__RW_DATA__=${json};\n`);
  let shell = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  shell = shell
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(`${wiki.owner}/${wiki.repo} documentation`)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escapeHtml(wiki.description || `Documentation for ${wiki.owner}/${wiki.repo}`)}" />`)
    .replace('<script type="module"', '<script src="/wiki-data.js"></script>\n    <script type="module"');
  const write = rel => {
    const dir = path.join(destDir, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), shell);
  };
  write('');
  write(`${wiki.owner}/${wiki.repo}`);
  write(`${wiki.owner}/${wiki.repo}/print`);
  for (const p of orderPages(wiki.pages)) write(`${wiki.owner}/${wiki.repo}/${p.slug}`);
  fs.writeFileSync(path.join(destDir, '404.html'), shell);
  if (domain && /^[A-Za-z0-9.-]+$/.test(domain)) fs.writeFileSync(path.join(destDir, 'CNAME'), `${domain}\n`);
  fs.writeFileSync(path.join(destDir, '.nojekyll'), '');
  return { dir: destDir, pages: wiki.pages.length, wiki };
}

/* ---------------- zip ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

function zipDir(dir) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const rel of listFiles(dir)) {
    const data = fs.readFileSync(path.join(dir, rel));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/* ---------------- single-file offline HTML ---------------- */

function readBrandSvg(name) {
  const p = path.join(__dirname, '..', 'public', 'brand', name);
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

function svgToDataUri(svg) {
  if (!svg) return '';
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

function buildSingleHtmlDocument({ wiki, pages }) {
  const title = `${wiki.owner}/${wiki.repo} — Documentation`;
  const desc = wiki.description || `Technical documentation for ${wiki.owner}/${wiki.repo}`;
  const monogramGold = svgToDataUri(readBrandSvg('logo-monogram-gold.svg'));
  const monogramWhite = svgToDataUri(readBrandSvg('logo-monogram-white.svg'));
  const brandLight = svgToDataUri(readBrandSvg('logo-horizontal-onlight.svg'));
  const brandDark = svgToDataUri(readBrandSvg('logo-horizontal-ondark.svg'));
  const exportedDate = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const indexedDate = wiki.lastIndexed
    ? new Date(wiki.lastIndexed).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const navHtml = pages.map((p, idx) => {
    const pad = 10 + Math.min(4, Number(p.depth) || 0) * 14;
    return `<button type="button" class="nav-item${idx === 0 ? ' active' : ''}" data-idx="${idx}" data-id="${escapeHtml(p.id)}" style="padding-left:${pad}px"><span class="nav-num">${escapeHtml(p.num)}</span><span class="nav-title">${escapeHtml(p.title)}</span></button>`;
  }).join('\n          ');

  const articlesHtml = pages.map((p, idx) => (
    `<article class="doc-page${idx === 0 ? ' active' : ''}" id="${escapeHtml(p.id)}" data-idx="${idx}" data-title="${escapeHtml(p.title)}" data-num="${escapeHtml(p.num)}">
        <div class="page-crumb">${escapeHtml(p.num)} · ${escapeHtml(`${wiki.owner}/${wiki.repo}`)}</div>
        <div class="prose">${p.html}</div>
        <nav class="pager" aria-label="Page navigation">
          ${idx > 0 ? `<button type="button" class="pager-btn" data-jump="${idx - 1}">← ${escapeHtml(pages[idx - 1].num)} ${escapeHtml(pages[idx - 1].title)}</button>` : '<span></span>'}
          ${idx < pages.length - 1 ? `<button type="button" class="pager-btn" data-jump="${idx + 1}">${escapeHtml(pages[idx + 1].num)} ${escapeHtml(pages[idx + 1].title)} →</button>` : '<span></span>'}
        </nav>
      </article>`
  )).join('\n      ');

  const metaLine = [
    `${pages.length} pages`,
    wiki.commit ? `commit ${String(wiki.commit).slice(0, 7)}` : '',
    indexedDate ? `indexed ${indexedDate}` : '',
    `exported ${exportedDate}`,
  ].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(desc)}" />
  ${monogramGold ? `<link rel="icon" href="${monogramGold}" type="image/svg+xml" />` : ''}
  <style>
    :root {
      --bg: #ffffff; --surface: #f7f7f7; --surface-hover: #efefef; --border: #e5e5e5;
      --text: #1c1c1c; --text-2: #525252; --muted: #737373; --accent: #2563eb;
      --accent-soft: #eff6ff; --chip: #f0f0ef; --chip-range: #e4e4e2;
      --diagram-bg: #f4f4f2; --code-bg: #f6f6f5; --shadow: 0 12px 32px rgba(0,0,0,.14);
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Helvetica, Arial, sans-serif;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    html.dark {
      --bg: #15171a; --surface: #1c1f24; --surface-hover: #252932; --border: #2a2f3a;
      --text: #eceef2; --text-2: #b4bcc8; --muted: #8b95a5; --accent: #7aa2ff;
      --accent-soft: rgba(122,162,255,.14); --chip: #232730; --chip-range: #2c313d;
      --diagram-bg: #f2f2f0; --code-bg: #1b1e24; --shadow: 0 16px 40px rgba(0,0,0,.55);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--sans); font-size: 15px; line-height: 1.65; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    button { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; }
    .topbar {
      position: sticky; top: 0; z-index: 30; height: 56px;
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 0 20px; background: var(--bg); border-bottom: 1px solid var(--border);
    }
    .topbar-left { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .brand-icon { width: 22px; height: 22px; flex-shrink: 0; }
    .brand-icon.dark-only { display: none; }
    html.dark .brand-icon.light-only { display: none; }
    html.dark .brand-icon.dark-only { display: block; }
    .repo-title { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .repo-meta { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .topbar-right { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .icon-btn {
      height: 32px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--border);
      background: var(--surface); font-size: 13px; color: var(--text-2);
      display: inline-flex; align-items: center; gap: 6px;
    }
    .icon-btn:hover { background: var(--surface-hover); color: var(--text); }
    .menu-toggle { display: none; }
    .shell { display: grid; grid-template-columns: 276px minmax(0, 1fr) 220px; min-height: calc(100vh - 56px); }
    .sidebar {
      position: sticky; top: 56px; height: calc(100vh - 56px); overflow-y: auto;
      border-right: 1px solid var(--border); padding: 14px 12px 24px;
      display: flex; flex-direction: column; gap: 10px; background: var(--bg);
    }
    .search-box {
      width: 100%; height: 34px; padding: 0 10px; border-radius: 8px;
      border: 1px solid var(--border); background: var(--surface); color: var(--text);
      font-size: 13px; outline: none;
    }
    .search-box:focus { border-color: var(--accent); }
    .nav-list { display: flex; flex-direction: column; gap: 2px; flex: 1; }
    .nav-item {
      display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left;
      padding: 6px 10px; border-radius: 7px; font-size: 13.5px; line-height: 1.4;
      color: var(--text-2); transition: background .12s, color .12s;
    }
    .nav-item:hover { background: var(--surface); color: var(--text); }
    .nav-item.active { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
    .nav-item.hidden { display: none; }
    .nav-num { font-size: 11.5px; color: var(--muted); flex-shrink: 0; font-variant-numeric: tabular-nums; }
    .nav-item.active .nav-num { color: var(--accent); }
    .nav-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .nav-match { margin-left: auto; font-size: 11px; color: var(--accent); background: var(--accent-soft); border-radius: 99px; padding: 0 6px; flex-shrink: 0; }
    .sidebar-foot {
      margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border);
      display: flex; flex-direction: column; gap: 6px; font-size: 11.5px; color: var(--muted);
    }
    .sidebar-foot img { height: 18px; width: auto; align-self: flex-start; opacity: .82; }
    .brand-logo.dark-only { display: none; }
    html.dark .brand-logo.light-only { display: none; }
    html.dark .brand-logo.dark-only { display: block; }
    .content { padding: 32px 44px 72px; min-width: 0; max-width: 880px; width: 100%; margin: 0 auto; }
    .doc-page { display: none; }
    .doc-page.active { display: block; }
    .page-crumb { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 10px; }
    .toc-col {
      position: sticky; top: 56px; height: calc(100vh - 56px); overflow-y: auto;
      padding: 24px 16px; border-left: 1px solid var(--border); font-size: 12.5px;
    }
    .toc-head { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 10px; }
    .toc-links { display: flex; flex-direction: column; gap: 5px; }
    .toc-links a { color: var(--text-2); line-height: 1.4; display: block; }
    .toc-links a:hover { color: var(--accent); text-decoration: none; }
    .toc-links a.d3 { padding-left: 12px; font-size: 12px; color: var(--muted); }
    .prose h1 { font-size: 30px; line-height: 1.2; margin: 0 0 18px; letter-spacing: -.02em; }
    .prose h2 { font-size: 21px; line-height: 1.3; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    .prose h3 { font-size: 16.5px; line-height: 1.4; margin: 24px 0 8px; }
    .prose h4 { font-size: 15px; margin: 18px 0 6px; }
    .prose p { margin: 0 0 14px; }
    .prose ul, .prose ol { margin: 0 0 14px; padding-left: 24px; }
    .prose li { margin: 4px 0; }
    .prose code { font-family: var(--mono); font-size: 12.5px; background: var(--chip); padding: 2px 5px; border-radius: 4px; }
    .prose pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; margin: 0 0 16px; line-height: 1.5; }
    .prose pre code { background: none; padding: 0; font-size: 12.5px; }
    .prose blockquote { margin: 0 0 16px; padding: 2px 14px; border-left: 3px solid var(--border); color: var(--text-2); }
    .prose hr { border: 0; border-top: 1px solid var(--border); margin: 24px 0; }
    .table-wrap { overflow-x: auto; margin: 18px 0; }
    .prose table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
    .prose th { text-align: left; font-weight: 600; padding: 8px 12px 8px 0; border-bottom: 1px solid var(--border); }
    .prose td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--border); vertical-align: top; }
    .src-chip {
      display: inline-flex; align-items: stretch; vertical-align: middle; margin: 0 4px 4px 0;
      font-family: var(--mono); font-size: 12px; line-height: 16px; color: var(--text) !important; text-decoration: none !important;
    }
    .src-chip .path { display: inline-flex; align-items: center; gap: 5px; background: var(--chip); padding: 4px 8px; border-radius: 4px 0 0 4px; }
    .src-chip .path:only-child { border-radius: 4px; }
    .src-chip .range { display: inline-flex; align-items: center; background: var(--chip-range); padding: 4px 7px; border-radius: 0 4px 4px 0; color: var(--text-2); }
    .sources-line { margin: 0 0 14px; font-size: 13px; color: var(--muted); }
    .relevant { border: 1px solid var(--border); border-radius: 8px; margin: 0 0 22px; background: var(--surface); }
    .relevant summary { list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px; padding: 0 14px; height: 40px; font-size: 14px; font-weight: 500; }
    .relevant summary::-webkit-details-marker { display: none; }
    .relevant[open] summary svg { transform: rotate(90deg); }
    .relevant ul { list-style: none; margin: 0; padding: 4px 14px 12px 34px; }
    .diagram {
      position: relative; background: var(--diagram-bg); border: 1px solid var(--border);
      border-radius: 10px; padding: 20px 16px; margin: 0 0 18px; overflow-x: auto; text-align: center;
      cursor: zoom-in;
    }
    .diagram > svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
    .diagram pre.mermaid-src { text-align: left; background: none; border: 0; margin: 0; color: #333; cursor: text; }
    .pager { display: flex; justify-content: space-between; gap: 12px; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--border); flex-wrap: wrap; }
    .pager-btn { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); font-size: 13.5px; color: var(--text); }
    .pager-btn:hover { border-color: var(--accent); color: var(--accent); }
    .zoom-overlay {
      position: fixed; inset: 0; z-index: 100; background: rgba(0,0,0,.62);
      display: none; align-items: center; justify-content: center; padding: 24px;
    }
    .zoom-overlay.open { display: flex; }
    .zoom-card {
      background: #f4f4f2; border-radius: 12px; max-width: 94vw; max-height: 90vh;
      overflow: auto; padding: 24px; position: relative; box-shadow: var(--shadow);
    }
    .zoom-close {
      position: sticky; top: 0; float: right; width: 32px; height: 32px; border-radius: 99px;
      background: #fff; border: 1px solid #ddd; color: #222; font-size: 16px;
    }
    .zoom-body svg { max-width: none !important; height: auto; display: block; }
    @media (max-width: 1120px) {
      .shell { grid-template-columns: 260px minmax(0, 1fr); }
      .toc-col { display: none; }
    }
    @media (max-width: 820px) {
      .menu-toggle { display: inline-flex; }
      .repo-meta { display: none; }
      .shell { grid-template-columns: 1fr; }
      .sidebar {
        position: fixed; left: 0; top: 56px; bottom: 0; width: 290px; z-index: 40;
        transform: translateX(-100%); transition: transform .18s ease; box-shadow: var(--shadow);
      }
      .sidebar.open { transform: translateX(0); }
      .content { padding: 22px 18px 56px; }
    }
    @media print {
      .topbar, .sidebar, .toc-col, .pager, .zoom-overlay { display: none !important; }
      .shell { display: block; }
      .content { max-width: none; padding: 0; }
      .doc-page { display: block !important; break-before: page; page-break-before: always; }
      .doc-page:first-of-type { break-before: auto; page-break-before: auto; }
    }
  </style>
  <script>
    try { if (localStorage.getItem('s4w-doc-theme') === 'dark') document.documentElement.classList.add('dark'); } catch (e) {}
  </script>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <button type="button" class="icon-btn menu-toggle" id="menuBtn" aria-label="Toggle menu">☰</button>
      ${monogramGold ? `<img class="brand-icon light-only" src="${monogramGold}" alt="" />` : ''}
      ${monogramWhite ? `<img class="brand-icon dark-only" src="${monogramWhite}" alt="" />` : ''}
      <div style="min-width:0">
        <div class="repo-title">${escapeHtml(`${wiki.owner}/${wiki.repo}`)}</div>
        <div class="repo-meta">${escapeHtml(metaLine)}</div>
      </div>
    </div>
    <div class="topbar-right">
      <button type="button" class="icon-btn" id="printBtn" title="Print or save as PDF">Print</button>
      <button type="button" class="icon-btn" id="themeBtn" title="Switch light / dark theme">Theme</button>
    </div>
  </header>
  <div class="shell">
    <aside class="sidebar" id="sidebar">
      <input type="search" class="search-box" id="searchInput" placeholder="Search documentation…" aria-label="Search documentation" />
      <nav class="nav-list" id="navList">
        ${navHtml}
      </nav>
      <div class="sidebar-foot">
        ${brandLight ? `<img class="brand-logo light-only" src="${brandLight}" alt="Safe4ai" />` : ''}
        ${brandDark ? `<img class="brand-logo dark-only" src="${brandDark}" alt="Safe4ai" />` : ''}
        <span>Generated with Safe4wiki · safe4ai.com</span>
      </div>
    </aside>
    <main class="content" id="mainContent">
      ${articlesHtml}
    </main>
    <aside class="toc-col" aria-label="On this page">
      <div class="toc-head">On this page</div>
      <div class="toc-links" id="tocLinks"></div>
    </aside>
  </div>
  <div class="zoom-overlay" id="zoomOverlay" role="dialog" aria-label="Diagram preview">
    <div class="zoom-card" id="zoomCard">
      <button type="button" class="zoom-close" id="zoomClose" aria-label="Close">✕</button>
      <div class="zoom-body" id="zoomBody"></div>
    </div>
  </div>
  <script>
    (function () {
      var pages = Array.prototype.slice.call(document.querySelectorAll('.doc-page'));
      var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));
      var tocLinks = document.getElementById('tocLinks');
      var sidebar = document.getElementById('sidebar');
      var searchInput = document.getElementById('searchInput');
      var zoomOverlay = document.getElementById('zoomOverlay');
      var zoomBody = document.getElementById('zoomBody');
      var pageTexts = pages.map(function (el) { return (el.textContent || '').toLowerCase(); });
      var currentIdx = 0;

      function buildToc(article) {
        tocLinks.innerHTML = '';
        var hs = article.querySelectorAll('.prose h2, .prose h3');
        for (var i = 0; i < hs.length; i++) {
          var h = hs[i];
          if (!h.id) h.id = 'sec-' + currentIdx + '-' + i;
          var a = document.createElement('a');
          a.href = '#' + h.id;
          a.textContent = h.textContent.trim();
          if (h.tagName === 'H3') a.className = 'd3';
          tocLinks.appendChild(a);
        }
      }

      function showPage(idx, targetEl, updateHash) {
        if (idx < 0 || idx >= pages.length) idx = 0;
        currentIdx = idx;
        for (var i = 0; i < pages.length; i++) {
          pages[i].classList.toggle('active', i === idx);
          if (navItems[i]) navItems[i].classList.toggle('active', i === idx);
        }
        buildToc(pages[idx]);
        sidebar.classList.remove('open');
        if (updateHash !== false) {
          var newHash = '#' + (targetEl ? targetEl.id : pages[idx].id);
          if (location.hash !== newHash) {
            try { history.pushState(null, '', newHash); } catch (e) { location.hash = newHash; }
          }
        }
        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else window.scrollTo(0, 0);
      }

      function navigateHash(hash, push) {
        var id = (hash || '').replace(/^#/, '');
        if (!id) { showPage(0, null, false); return; }
        for (var i = 0; i < pages.length; i++) {
          if (pages[i].id === id) { showPage(i, null, push); return; }
        }
        var target = document.getElementById(id);
        if (target) {
          var art = target.closest('.doc-page');
          if (art) { showPage(Number(art.dataset.idx) || 0, target, push); return; }
        }
        showPage(0, null, false);
      }

      document.getElementById('navList').addEventListener('click', function (e) {
        var btn = e.target.closest('.nav-item');
        if (btn) showPage(Number(btn.dataset.idx) || 0, null, true);
      });

      document.getElementById('mainContent').addEventListener('click', function (e) {
        var jump = e.target.closest('[data-jump]');
        if (jump) { showPage(Number(jump.dataset.jump) || 0, null, true); return; }
        var a = e.target.closest('a[href^="#"]');
        if (a) { e.preventDefault(); navigateHash(a.getAttribute('href'), true); return; }
        var diag = e.target.closest('.diagram');
        if (diag) {
          var svg = diag.querySelector(':scope > svg');
          if (svg) {
            zoomBody.innerHTML = svg.outerHTML.replace(/max-width:[^;"]*;?/g, '');
            zoomOverlay.classList.add('open');
          }
        }
      });

      document.getElementById('zoomClose').addEventListener('click', function () { zoomOverlay.classList.remove('open'); });
      zoomOverlay.addEventListener('click', function (e) { if (e.target === zoomOverlay) zoomOverlay.classList.remove('open'); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') zoomOverlay.classList.remove('open'); });

      document.getElementById('themeBtn').addEventListener('click', function () {
        var dark = document.documentElement.classList.toggle('dark');
        try { localStorage.setItem('s4w-doc-theme', dark ? 'dark' : 'light'); } catch (e) {}
      });
      document.getElementById('printBtn').addEventListener('click', function () { window.print(); });
      document.getElementById('menuBtn').addEventListener('click', function () { sidebar.classList.toggle('open'); });

      searchInput.addEventListener('input', function () {
        var q = searchInput.value.trim().toLowerCase();
        for (var i = 0; i < navItems.length; i++) {
          var oldBadge = navItems[i].querySelector('.nav-match');
          if (oldBadge) oldBadge.remove();
          if (!q) { navItems[i].classList.remove('hidden'); continue; }
          var text = pageTexts[i] || '';
          var titleText = (pages[i].dataset.title || '').toLowerCase();
          var count = 0;
          var pos = 0;
          while ((pos = text.indexOf(q, pos)) !== -1) { count++; pos += q.length; if (count >= 99) break; }
          if (count > 0 || titleText.indexOf(q) !== -1) {
            navItems[i].classList.remove('hidden');
            if (count > 0) {
              var badge = document.createElement('span');
              badge.className = 'nav-match';
              badge.textContent = count >= 99 ? '99+' : String(count);
              navItems[i].appendChild(badge);
            }
          } else {
            navItems[i].classList.add('hidden');
          }
        }
      });

      window.addEventListener('hashchange', function () { navigateHash(location.hash, false); });
      navigateHash(location.hash, false);
    })();
  </script>
</body>
</html>`;
}

async function renderFallbackPages(wiki) {
  const ordered = orderPages(wiki.pages);
  let markedParse = null;
  try {
    const mod = await import('marked');
    markedParse = md => mod.marked.parse(String(md || ''), { gfm: true, async: false });
  } catch { /* minimal fallback below */ }
  return ordered.map(p => {
    const id = `page-${slugify(p.slug)}`;
    const html = markedParse
      ? markedParse(p.markdown)
      : `<pre>${escapeHtml(p.markdown)}</pre>`;
    return { id, slug: p.slug, num: p.num, depth: p.depth, title: p.title, html };
  });
}

async function exportSingleHtml({ port, wiki: wikiInput }) {
  const wiki = resolveWiki(wikiInput);
  let pages = null;
  if (port) {
    let playwright;
    try { playwright = require('playwright'); } catch { playwright = null; }
    if (playwright) {
      let browser;
      try {
        try { browser = await playwright.chromium.launch(); } catch { browser = await playwright.chromium.launch({ channel: 'chrome' }); }
        const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
        const tab = await ctx.newPage();
        await tab.goto(`http://127.0.0.1:${port}/${encodeURIComponent(wiki.owner)}/${encodeURIComponent(wiki.repo)}/print?paper=A4`, { waitUntil: 'networkidle', timeout: 120000 });
        await tab.waitForFunction(() => window.__PRINT_READY === true, null, { timeout: 180000 });
        pages = await tab.evaluate(() => Array.from(document.querySelectorAll('[data-print-page]')).map(sec => ({
          id: sec.id,
          slug: sec.dataset.slug || sec.id,
          num: sec.dataset.num || '',
          depth: Number(sec.dataset.depth || 0),
          title: sec.dataset.title || sec.querySelector('h1')?.textContent?.trim() || sec.id,
          html: sec.querySelector('.prose')?.innerHTML || '',
        })));
      } catch {
        pages = null;
      } finally {
        if (browser) await browser.close().catch(() => {});
      }
    }
  }
  if (!pages || !pages.length) pages = await renderFallbackPages(wiki);
  return buildSingleHtmlDocument({ wiki, pages });
}

/* ---------------- pdf ---------------- */

async function printPdf({ port, owner, repo, paper = 'A4', page }) {
  let playwright;
  try { playwright = require('playwright'); } catch {
    const e = new Error('Built-in PDF printing needs Playwright (npm install playwright && npx playwright install chromium). Opening your browser’s print window instead.');
    e.code = 'no_browser';
    throw e;
  }
  let browser;
  try {
    try { browser = await playwright.chromium.launch(); } catch { browser = await playwright.chromium.launch({ channel: 'chrome' }); }
  } catch (err) {
    const e = new Error(`No browser for PDF printing (${err.message.split('\n')[0]}). Run “npx playwright install chromium”, or use the print window.`);
    e.code = 'no_browser';
    throw e;
  }
  try {
    const ctx = await browser.newContext({ viewport: { width: 1100, height: 1400 } });
    const tab = await ctx.newPage();
    const q = new URLSearchParams({ paper, ...(page ? { page } : {}) });
    await tab.goto(`http://127.0.0.1:${port}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/print?${q}`, { waitUntil: 'networkidle', timeout: 120000 });
    await tab.waitForFunction(() => window.__PRINT_READY === true, null, { timeout: 180000 });
    await tab.emulateMedia({ media: 'print' });
    const label = `${owner}/${repo}`.replace(/[<>&"]/g, '');
    return await tab.pdf({
      format: paper === 'Letter' ? 'Letter' : 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="width:100%;font-size:8px;color:#999;padding:0 16mm;font-family:sans-serif;display:flex;justify-content:space-between"><span>${label}</span><span class="title"></span></div>`,
      footerTemplate: '<div style="width:100%;font-size:8px;color:#999;padding:0 16mm;font-family:sans-serif;text-align:right"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
      outline: true,
      tagged: true,
    });
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { exportSite, exportSingleHtml, buildSingleHtmlDocument, zipDir, printPdf, orderPages, slugify, validateWiki };

// Wiki helpers shared by the live app, the print/PDF view and the HTML export:
// page ordering and numbering, slugs, and markdown -> HTML with source chips,
// "Relevant source files", "Sources:" lines and mermaid diagram placeholders.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'page';
}

/**
 * Orders pages as a tree (parents before children) and gives each a number
 * ("1", "1.1", "2") and a URL slug ("1-overview", "1.1-build-system").
 */
export function orderPages(pages) {
  const byPath = new Map(pages.map(p => [p.path, p]));
  const children = new Map();
  const roots = [];
  for (const page of pages) {
    const parent = page.parent && byPath.has(page.parent) && page.parent !== page.path ? page.parent : null;
    if (parent) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(page);
    } else {
      roots.push(page);
    }
  }
  const out = [];
  const seen = new Set();
  const walk = (list, prefix, depth) => {
    list.forEach((page, index) => {
      if (seen.has(page.path)) return;
      seen.add(page.path);
      const num = prefix ? `${prefix}.${index + 1}` : String(index + 1);
      out.push({ ...page, num, depth, slug: `${num}-${slugify(page.title)}` });
      walk(children.get(page.path) || [], num, depth + 1);
    });
  };
  walk(roots, '', 0);
  return out;
}

export function findPage(ordered, slug) {
  if (!slug) return ordered[0] || null;
  return ordered.find(p => p.slug === slug)
    || ordered.find(p => p.slug.split('-')[0] === slug.split('-')[0])
    || ordered[0] || null;
}

const escapeHtml = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const GITHUB_ICON = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';
const FILE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
// Standard DOMPurify URI rules (no global vscode:// scheme; local file links
// are validated against source.root explicitly below).
const BASE_ALLOWED_URI = /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

function normalizeSafeRel(file) {
  const raw = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') return null; // reject upward traversal outside repository root
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function localVscodePrefix(root) {
  const norm = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm) return '';
  const encoded = norm.split('/').map(encodeURIComponent).join('/');
  return `vscode://file${encoded.startsWith('/') ? '' : '/'}${encoded}/`;
}

/** Link to a file (and line range) in the wiki's source. */
export function sourceHref(source, file, start, end) {
  if (!source) return '#';
  const clean = normalizeSafeRel(file);
  if (!clean) return '#';
  if (source.type === 'github' && source.url) {
    const ref = source.commit || 'HEAD';
    const lines = start ? `#L${start}${end && end !== start ? `-L${end}` : ''}` : '';
    return `${source.url.replace(/\.git$/, '').replace(/\/+$/, '')}/blob/${ref}/${clean}${lines}`;
  }
  if (source.type === 'local' && source.root) {
    const prefix = localVscodePrefix(source.root);
    if (!prefix) return '#';
    const encodedRel = clean.split('/').map(encodeURIComponent).join('/');
    return `${prefix}${encodedRel}${start ? `:${start}` : ''}`;
  }
  return '#';
}

export function chipHtml(source, file, start, end) {
  const range = start ? `${start}${end && end !== start ? `–${end}` : ''}` : '';
  const icon = source && source.type === 'local' ? FILE_ICON : GITHUB_ICON;
  const href = sourceHref(source, file, start, end);
  const label = range ? `${file}, ${end && end !== start ? 'lines' : 'line'} ${range}` : file;
  // The label can pass through the Markdown inline parser before reaching the browser.
  const pathLabel = escapeHtml(file).replace(/[_*`~\[\]]/g, char => `&#${char.charCodeAt(0)};`);
  const dataAttrs = ` data-file="${escapeHtml(file)}"${start ? ` data-start="${start}"` : ''}${end ? ` data-end="${end}"` : ''}`;
  const content = `<span class="path">${icon}${pathLabel}</span>`
    + (range ? `<span class="range">${escapeHtml(range)}</span>` : '');
  if (href === '#') return `<span class="src-chip"${dataAttrs}>${content}</span>`;
  return `<a class="src-chip"${dataAttrs} aria-label="${escapeHtml(label)}" target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}">${content}</a>`;
}

const CITE_RE = /\[([^\]\s:`]+?\.[A-Za-z0-9_+-]+|[^\]\s:`]+?):L?(\d+)(?:\s*[-–]\s*L?(\d+))?\](?:\(([^)\s]*)\))?/g;
const FILE_LINK_RE = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*$/;

function citeToChips(text, source) {
  return text.replace(CITE_RE, (_m, file, start, end) => chipHtml(source, file, Number(start), end ? Number(end) : null));
}

/**
 * Turns engine-style markdown into HTML-ready markdown:
 *  - <cite> "Referenced Files" block  -> collapsible "Relevant source files"
 *  - "**Section sources**" style lists -> one "Sources:" line of chips
 *  - inline [file:L1-L9](...) citations -> chips
 *  - ```mermaid blocks                 -> diagram placeholders
 */
export function preprocess(markdown, source) {
  let md = String(markdown || '').replace(/\r\n/g, '\n');
  const diagrams = [];

  // Protect fenced code so citations inside code stay untouched.
  // Anchored to line starts with backtick-count matching so inline ```` ```json ````
  // code spans never swallow following blocks (such as a ```mermaid diagram).
  const fences = [];
  md = md.replace(/^([ \t]*)(`{3,})([\w-]*)[^\n]*\n([\s\S]*?)(?:\n|^)[ \t]*\2[ \t]*(?=\n|$)/gm, (match, _indent, _ticks, lang, body) => {
    if (lang.toLowerCase() === 'mermaid') {
      diagrams.push(body.trim());
      return `\n\n<div class="diagram" data-diagram="${diagrams.length - 1}"></div>\n\n`;
    }
    fences.push(match);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });

  // Collect any section-level source files and strip repetitive per-section "Sources:" blocks
  // so files are listed once cleanly inside the page's "Relevant source files" dropdown.
  const extraFiles = [];
  const addExtra = file => {
    const clean = String(file || '').replace(/`/g, '').replace(/:L?\d+(?:-L?\d+)?$/, '').trim();
    if (clean && !extraFiles.includes(clean)) extraFiles.push(clean);
  };
  md = md.replace(/\*\*(?:Section|Diagram|File)?\s*sources?\*\*:?\s*\n((?:\s*[-*]\s+.*\n?)+)/gi, (_m, list) => {
    for (const line of list.split('\n')) {
      const t = line.replace(/^\s*[-*]\s+/, '').trim();
      if (!t) continue;
      const cite = t.match(/\[([^\]]+?):L?(\d+)(?:\s*[-–]\s*L?(\d+))?\]/);
      if (cite) { addExtra(cite[1]); continue; }
      const link = t.match(/\[([^\]]+)\]/);
      addExtra(link ? link[1] : t);
    }
    return '\n';
  });

  // <cite> ... </cite> -> Relevant source files (deduplicated, merged with section sources)
  let hadCite = false;
  md = md.replace(/<cite>([\s\S]*?)<\/cite>/gi, (_m, inner) => {
    hadCite = true;
    const files = [];
    const seen = new Set();
    const push = f => {
      const clean = String(f || '').replace(/:L?\d+(?:-L?\d+)?$/, '').trim();
      if (clean && !seen.has(clean)) { seen.add(clean); files.push(clean); }
    };
    for (const line of inner.split('\n')) {
      const m = line.match(FILE_LINK_RE);
      if (m) push(m[1]);
    }
    for (const f of extraFiles) push(f);
    if (!files.length) return '';
    const items = files.map(f => `<li>${chipHtml(source, f)}</li>`).join('');
    return `\n\n<details class="relevant"><summary>${CHEVRON}<span>Relevant source files</span></summary><ul>${items}</ul></details>\n\n`;
  });
  if (!hadCite && extraFiles.length) {
    const items = extraFiles.map(f => `<li>${chipHtml(source, f)}</li>`).join('');
    const block = `\n\n<details class="relevant"><summary>${CHEVRON}<span>Relevant source files</span></summary><ul>${items}</ul></details>\n\n`;
    md = md.replace(/^(#\s+[^\n]+\n)/, `$1${block}`);
  }

  md = citeToChips(md, source);
  md = md.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => fences[Number(i)]);
  return { md, diagrams };
}

const CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

/**
 * Renders a page to sanitized HTML plus its heading outline and diagrams.
 * resolveLink maps relative .md links between wiki pages to app URLs.
 */
export function renderPage(markdown, { source, resolveLink } = {}) {
  const { md, diagrams } = preprocess(markdown, source);
  const headings = [];
  const used = new Map();
  const renderer = new marked.Renderer();
  renderer.heading = function heading({ tokens, depth }) {
    const html = this.parser.parseInline(tokens);
    const text = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    let id = slugify(text);
    const n = used.get(id) || 0;
    used.set(id, n + 1);
    if (n) id = `${id}-${n}`;
    if (depth <= 4) headings.push({ id, text, depth });
    return `<h${depth} id="${id}">${html}</h${depth}>\n`;
  };
  renderer.link = function link({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    let target = href || '';
    let external = /^[a-z]+:/i.test(target);
    if (!external && resolveLink && !target.startsWith('/')) {
      const resolved = resolveLink(target);
      if (resolved) target = resolved;
      else if (source) { target = sourceHref(source, target.split('#')[0]); external = true; }
    }
    return `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
  };
  renderer.table = function table(token) {
    const head = token.header.map(c => `<th>${this.parser.parseInline(c.tokens)}</th>`).join('');
    const body = token.rows.map(r => `<tr>${r.map(c => `<td>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('');
    return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  };
  const raw = marked.parse(md, { renderer, gfm: true, async: false });
  const vscodePrefix = source && source.type === 'local' ? localVscodePrefix(source.root) : '';
  const allowedUri = vscodePrefix
    ? new RegExp(`^(?:${escapeRegExp(vscodePrefix)}(?!.*(?:^|\\/)\\.\\.(?:\\/|$))|(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))`, 'i')
    : BASE_ALLOWED_URI;
  const html = DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: allowedUri,
    SANITIZE_NAMED_PROPS: true,
    ADD_ATTR: ['target', 'data-diagram', 'open', 'data-file', 'data-start', 'data-end'],
    ADD_TAGS: ['details', 'summary'],
  });
  return { html, headings, diagrams };
}

/** Maps a markdown link to another wiki page ("../architecture/x.md") to its slug. */
export function makeLinkResolver(ordered, current, basePath) {
  const dir = current && current.path.includes('/') ? current.path.slice(0, current.path.lastIndexOf('/') + 1) : '';
  return href => {
    if (!href || href.startsWith('#')) return href;
    const [file, hash] = href.split('#');
    if (!/\.md$/i.test(file)) return null;
    const parts = (dir + file).split('/');
    const stack = [];
    for (const part of parts) {
      if (part === '..') stack.pop();
      else if (part && part !== '.') stack.push(part);
    }
    const target = stack.join('/');
    const page = ordered.find(p => p.path === target) || ordered.find(p => p.path.endsWith('/' + file.replace(/^\.\//, '')));
    if (!page) return null;
    return `${basePath}/${page.slug}${hash ? `#${hash}` : ''}`;
  };
}

/** Plain text of a markdown page, for search. */
export function plainText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

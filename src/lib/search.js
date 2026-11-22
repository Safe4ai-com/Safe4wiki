// Small BM25 search over wiki sections. Used when no local server is running
// (sample wikis, published HTML exports) so the chat box can still point to
// the most relevant parts of the documentation.
import { plainText } from './wiki.js';

const STOP = new Set('a an and are as at be by for from how i in is it of on or that the this to was what when where which who why will with does do can about into my me you your'.split(' '));

export function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9_]+/).filter(t => t.length > 1 && !STOP.has(t))
    .map(t => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

/** Drops what reads badly as an excerpt: source lists, diagrams, table rulers. */
function readable(markdown) {
  return markdown
    .replace(/<cite>[\s\S]*?<\/cite>/g, '')
    .replace(/```mermaid[\s\S]*?```/g, '')
    .replace(/\*\*Section sources\*\*\n(?:\s*[-*] .*\n?)*/g, '')
    .split('\n')
    .filter(line => !/^\s*\|?\s*:?-{3,}/.test(line))
    .map(line => (/^\s*\|.*\|\s*$/.test(line)
      ? line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()).filter(Boolean).join(' — ') + '.'
      : line))
    .join('\n')
    .replace(/\[([^\]\s]+):L\d+(?:-L\d+)?\]/g, '');
}

export function sectionsOf(page) {
  const out = [];
  const lines = String(page.markdown || '').split('\n');
  let heading = page.title;
  let anchor = '';
  let buf = [];
  const flush = () => {
    const text = plainText(readable(buf.join('\n')));
    if (text.length > 40) out.push({ page, heading, anchor, text });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,4})\s+(.*)$/);
    if (m) {
      flush();
      heading = m[2].trim();
      anchor = heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    } else buf.push(line);
  }
  flush();
  return out;
}

export function searchSections(pages, query, limit = 5) {
  const docs = pages.filter(p => !p.placeholder).flatMap(sectionsOf).map(s => ({ ...s, tokens: tokenize(`${s.heading} ${s.heading} ${s.text}`) }));
  const q = tokenize(query);
  if (!q.length || !docs.length) return [];
  const N = docs.length;
  const avg = docs.reduce((a, d) => a + d.tokens.length, 0) / N;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  const scored = docs.map(d => {
    const tf = new Map();
    for (const t of d.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const t of q) {
      const f = tf.get(t) || 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.tokens.length / avg));
    }
    return { ...d, score };
  });
  return scored.filter(d => d.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

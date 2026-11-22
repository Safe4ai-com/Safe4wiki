'use strict';
/**
 * Chat with a wiki and its code (retrieval-augmented generation).
 *  - Index: wiki sections + source-file chunks (with line numbers).
 *  - Retrieval: BM25 keyword search, fused with embedding similarity when an
 *    embeddings endpoint is configured (Ollama, LM Studio, OpenAI...).
 *  - Answer: the chosen model profile (streamed for OpenAI-style and Ollama
 *    servers; agent CLIs run inside the repository and may read more files).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { chatDetailed, resolveApiKey, ollamaContextSize } = require('./engine/providers');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.local-wiki', '.qoder', 'coverage', '.idea', '.vscode', '.gradle', 'Pods', '.turbo', '.cache', 'bower_components']);
const TEXT_EXT = new Set('js jsx ts tsx mjs cjs vue svelte py rb go rs java kt kts scala swift m mm c h cc cpp hpp cs fs php lua dart ex exs erl hs clj sh bash zsh ps1 sql graphql proto json yaml yml toml ini cfg conf md mdx rst txt html css scss less xml gradle cmake make mk dockerfile tf hcl r jl nim zig sol'.split(' '));
const MAX_FILE = 200 * 1024;
const MAX_FILES = 4000;
const CHUNK_LINES = 60;
const OVERLAP = 10;

const cache = new Map();

function invalidate(owner, repo) {
  for (const key of cache.keys()) if (key.startsWith(`${owner}/${repo}`.toLowerCase())) cache.delete(key);
}

/* ---------------- tokenizing & BM25 ---------------- */

const STOP = new Set('a an and are as at be by for from how i in is it of on or that the this to was what when where which who why will with does do can about into my me you your je i u na da se za od kako sta šta koji koja koje kakav kakva kakvo li su sam si smo ste bih bi ovo ova ovaj taj ta to gde kada zasto zašto zato kao sve svi vec već ima nema daj mi reci objasni pokazi prikazi napisi molim treba'.split(' '));

// Lightweight cross-language technical cognates (e.g. Serbian/Croatian/Bosnian/German/etc. -> English repo terms)
const SYNONYM_PREFIXES = [
  ['arhitektur', ['architecture', 'overview', 'system']],
  ['aplikacij', ['application', 'app', 'overview']],
  ['pregled', ['overview', 'architecture']],
  ['struktur', ['structure', 'architecture', 'overview']],
  ['podat', ['data', 'database', 'schema']],
  ['baz', ['database', 'db', 'schema', 'sql']],
  ['autentifik', ['auth', 'authentication', 'login', 'jwt']],
  ['autorizac', ['authorization', 'auth', 'rbac', 'permission']],
  ['bezbedn', ['security', 'auth']],
  ['sigurn', ['security', 'auth']],
  ['bekend', ['backend', 'server', 'api']],
  ['klijent', ['client', 'frontend', 'ui']],
  ['interfejs', ['interface', 'ui', 'frontend']],
  ['izvestaj', ['report', 'reporting', 'pdf']],
  ['pacijent', ['patient']],
  ['klinik', ['clinic']],
  ['zadat', ['task']],
  ['komunikac', ['communication', 'notification', 'message']],
  ['obavest', ['notification', 'websocket']],
  ['dokument', ['document', 'file', 'storage']],
  ['deploy', ['deployment', 'docker', 'nginx']],
  ['produkcij', ['production', 'deployment', 'docker']],
  ['pokret', ['startup', 'setup', 'deployment']],
  ['rut', ['route', 'router', 'endpoint']],
  ['servis', ['service', 'api']],
  ['modul', ['module']],
  ['tok', ['flow', 'pipeline', 'workflow']],
  ['revizij', ['audit', 'log']],
];

function expandCognates(term) {
  const out = [];
  for (const [prefix, targets] of SYNONYM_PREFIXES) {
    if (term.startsWith(prefix)) out.push(...targets);
  }
  return out;
}

function tokenize(text) {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOP.has(t))
    .map(t => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

function buildBm25(chunks) {
  const docs = chunks.map(c => {
    const tf = new Map();
    const toks = tokenize(`${c.title || ''} ${c.title || ''} ${c.page || ''} ${c.file || ''} ${c.text}`);
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    return { tf, len: toks.length };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const vocab = [...df.keys()];
  const avg = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  return query => {
    const rawQ = [...new Set(tokenize(query))];
    // Expand inflected/multilingual query terms (e.g. "transformersi" -> "transformer", "arhitekturu" -> "architecture")
    const expanded = [];
    const seenTerms = new Set();
    const addTerm = (term, weight) => {
      if (!df.has(term) || seenTerms.has(term)) return;
      seenTerms.add(term);
      expanded.push({ term, weight });
    };
    for (const t of rawQ) {
      if (df.has(t)) {
        addTerm(t, 1);
      } else if (t.length >= 5) {
        const stem = t.slice(0, Math.max(5, t.length - 3));
        const matches = vocab.filter(v => v.length >= 4 && (t.startsWith(v) || v.startsWith(stem))).slice(0, 6);
        for (const m of matches) addTerm(m, 0.75);
      }
      for (const syn of expandCognates(t)) addTerm(syn, 0.9);
    }
    const N = docs.length;
    return docs.map((d, i) => {
      let s = 0;
      for (const { term, weight } of expanded) {
        const f = d.tf.get(term);
        if (!f) continue;
        const n = df.get(term) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        s += weight * idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.len / avg));
      }
      // wiki prose explains; give it a lift over raw code
      if (s > 0 && chunks[i].kind === 'wiki') s *= 1.25;
      return { i, s };
    }).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
  };
}

/* ---------------- chunking ---------------- */

function wikiChunks(pages) {
  const out = [];
  for (const page of pages) {
    const lines = String(page.markdown || '').split('\n');
    let heading = page.title;
    let buf = [];
    const flush = () => {
      const text = buf.join('\n').replace(/<\/?cite>/g, '').trim();
      if (text.length > 24) {
        for (let i = 0; i < text.length; i += 2400) {
          out.push({ kind: 'wiki', page: page.path, title: `${page.title}${heading !== page.title ? ` › ${heading}` : ''}`, text: text.slice(i, i + 2600) });
        }
      }
      buf = [];
    };
    for (const line of lines) {
      const m = line.match(/^#{1,3}\s+(.*)$/);
      if (m) { flush(); heading = m[1].trim(); }
      buf.push(line);
    }
    flush();
  }
  return out;
}

function walkFiles(root) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < MAX_FILES) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(r); continue; }
      if (!e.isFile()) continue;
      const ext = e.name.includes('.') ? e.name.split('.').pop().toLowerCase() : e.name.toLowerCase();
      if (!TEXT_EXT.has(ext) || /\.(min|bundle)\.(js|css)$|lock\.json$|\.lock$/.test(e.name)) continue;
      files.push(r);
      if (files.length >= MAX_FILES) break;
    }
  }
  return files;
}

function codeChunks(root) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const rel of walkFiles(root)) {
    let text;
    try {
      const st = fs.statSync(path.join(root, rel));
      if (st.size > MAX_FILE) continue;
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch { continue; }
    if (text.includes('\u0000')) continue;
    const lines = text.split('\n');
    for (let start = 0; start < lines.length; start += CHUNK_LINES - OVERLAP) {
      const slice = lines.slice(start, start + CHUNK_LINES);
      if (!slice.join('').trim()) continue;
      out.push({ kind: 'code', file: rel, start: start + 1, end: start + slice.length, text: slice.join('\n') });
      if (start + CHUNK_LINES >= lines.length) break;
    }
  }
  return out;
}

/* ---------------- embeddings ---------------- */

async function embed(settings, texts) {
  const e = settings.embedding || {};
  const url = `${String(e.baseUrl || '').replace(/\/+$/, '')}/embeddings`;
  const key = resolveApiKey(e.apiKey || '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: e.model, input: texts }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.data || []).map(d => d.embedding);
}

const sha = s => crypto.createHash('sha1').update(s).digest('hex');

const backgroundIndexing = new Set();

function loadCachedVectors(index, settings) {
  const e = settings.embedding || {};
  if (!e.enabled || !e.baseUrl || !e.model) return null;
  if (index.vectors && index.vectorModel === e.model) {
    return { vectors: index.vectors, missing: [] };
  }
  const cacheFile = index.cacheDir ? path.join(index.cacheDir, 'embeddings.json') : null;
  const saved = cacheFile ? store.readJson(cacheFile, {}) : {};
  const bag = saved.model === e.model ? saved.vectors || {} : {};
  const limit = Math.min(index.chunks.length, 6000);
  const missing = [];
  for (let i = 0; i < limit; i++) {
    const h = index.chunks[i].hash || sha(index.chunks[i].text);
    index.chunks[i].hash = h;
    if (!bag[h]) missing.push(i);
  }
  const vectors = index.chunks.map(c => (c.hash ? bag[c.hash] || null : null));
  if (missing.length === 0) {
    index.vectors = vectors;
    index.vectorModel = e.model;
  }
  return { vectors, missing, limit, bag, cacheFile };
}

function warmEmbeddingsInBackground(index, settings) {
  const e = settings.embedding || {};
  if (!e.enabled || !e.baseUrl || !e.model) return;
  const key = `${index.cacheDir || 'mem'}:${e.model}`;
  if (backgroundIndexing.has(key)) return;
  const state = loadCachedVectors(index, settings);
  if (!state || !state.missing.length) return;
  backgroundIndexing.add(key);
  (async () => {
    try {
      const { missing, bag, cacheFile } = state;
      for (let b = 0; b < missing.length; b += 32) {
        const batch = missing.slice(b, b + 32);
        const vecs = await embed(settings, batch.map(i => `${index.chunks[i].title || index.chunks[i].file || ''}\n${index.chunks[i].text}`.slice(0, 6000)));
        batch.forEach((i, k) => { if (vecs[k]) bag[index.chunks[i].hash] = vecs[k]; });
      }
      if (cacheFile) store.writeJson(cacheFile, { model: e.model, vectors: bag });
      index.vectors = index.chunks.map(c => (c.hash ? bag[c.hash] || null : null));
      index.vectorModel = e.model;
    } catch { /* silent background prewarm */ } finally {
      backgroundIndexing.delete(key);
    }
  })();
}

async function ensureEmbeddings(index, settings, onStatus) {
  const e = settings.embedding || {};
  if (!e.enabled || !e.baseUrl || !e.model) return null;
  const state = loadCachedVectors(index, settings);
  if (!state) return null;
  const { vectors, missing, limit } = state;
  if (missing.length === 0) return vectors;
  // Never block the user's question on cold embedding indexing:
  // warm the cache in the background and use cached vectors if mostly ready (>=75%),
  // otherwise fall back immediately to fast BM25 (<30ms).
  warmEmbeddingsInBackground(index, settings);
  if (limit > 0 && (limit - missing.length) / limit >= 0.75) return vectors;
  return null;
}

function prewarm(record) {
  try {
    const settings = store.loadSettings();
    if (!settings.embedding?.enabled || !record) return;
    const content = store.loadWikiContent(record);
    if (!content || !content.pages?.length) return;
    const index = getIndex({
      owner: record.owner,
      repo: record.repo,
      pages: content.pages,
      repoDir: record.repoDir,
      cacheDir: store.wikiDir(record.owner, record.repo),
    });
    warmEmbeddingsInBackground(index, settings);
  } catch { /* ignore */ }
}

function cosine(a, b) {
  let dot = 0; let na = 0; let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/* ---------------- index & retrieval ---------------- */

function getIndex({ owner, repo, pages, repoDir, cacheDir }) {
  const key = `${owner}/${repo}`.toLowerCase() + (repoDir ? '' : ':pages');
  const stamp = pages.map(p => p.path + (p.markdown || '').length).join('|');
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) return hit;
  const chunks = [...wikiChunks(pages), ...codeChunks(repoDir)];
  const index = { stamp, chunks, bm25: buildBm25(chunks), cacheDir, repoDir };
  cache.set(key, index);
  return index;
}

async function retrieve(index, settings, question, k, onStatus) {
  const kwAll = index.bm25(question);
  const kw = kwAll.slice(0, 80);
  const kwWiki = kwAll.filter(x => index.chunks[x.i].kind === 'wiki').slice(0, 20);
  let ranked = kw.map(x => x.i);
  let rankedWiki = kwWiki.map(x => x.i);
  try {
    const vectors = await ensureEmbeddings(index, settings, onStatus);
    if (vectors) {
      const [qv] = await embed(settings, [question]);
      const scored = vectors.map((v, i) => ({ i, s: v ? cosine(qv, v) : -1 }));
      const sem = [...scored].sort((a, b) => b.s - a.s).slice(0, 80);
      const semWiki = scored.filter(x => index.chunks[x.i].kind === 'wiki').sort((a, b) => b.s - a.s).slice(0, 20);
      const fused = new Map();
      const fusedWiki = new Map();
      kw.forEach((x, r) => fused.set(x.i, (fused.get(x.i) || 0) + (index.chunks[x.i].kind === 'wiki' ? 1.2 : 1) / (60 + r)));
      sem.forEach((x, r) => fused.set(x.i, (fused.get(x.i) || 0) + (index.chunks[x.i].kind === 'wiki' ? 1.2 : 1) / (60 + r)));
      kwWiki.forEach((x, r) => fusedWiki.set(x.i, (fusedWiki.get(x.i) || 0) + 1.2 / (60 + r)));
      semWiki.forEach((x, r) => fusedWiki.set(x.i, (fusedWiki.get(x.i) || 0) + 1 / (60 + r)));
      ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
      rankedWiki = [...fusedWiki.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
    }
  } catch (err) {
    if (onStatus) onStatus(`Semantic search unavailable (${err.message.slice(0, 80)}); using keyword search`);
  }
  // Keep a healthy wiki + code mix so thousands of code chunks never drown out wiki pages.
  const picked = [];
  const pickedIdx = new Set();
  const perFile = new Map();
  const tryAdd = i => {
    if (pickedIdx.has(i)) return false;
    const c = index.chunks[i];
    if (!c) return false;
    const f = c.file || c.page;
    if ((perFile.get(f) || 0) >= 3) return false;
    perFile.set(f, (perFile.get(f) || 0) + 1);
    pickedIdx.add(i);
    picked.push(c);
    return true;
  };
  const wikiTarget = Math.max(3, Math.ceil(k * 0.4));
  let wikiAdded = 0;
  for (const i of rankedWiki) {
    if (wikiAdded >= wikiTarget) break;
    if (tryAdd(i)) wikiAdded++;
  }
  // If neither BM25 nor embeddings surfaced any wiki chunk, include opening wiki sections.
  if (wikiAdded === 0) {
    for (let i = 0; i < index.chunks.length && wikiAdded < Math.min(2, k); i++) {
      if (index.chunks[i].kind === 'wiki' && tryAdd(i)) wikiAdded++;
    }
  }
  for (const i of ranked) {
    if (picked.length >= k) break;
    tryAdd(i);
  }
  return picked;
}

/* ---------------- answering ---------------- */

function fenceLang(file) {
  const ext = String(file).split('.').pop();
  return /^[a-z0-9]+$/i.test(ext) ? ext : '';
}

function buildMessages({ owner, repo, question, history, contexts, agent, overview, attachments }) {
  const ctx = contexts.map((c, n) => (c.kind === 'wiki'
    ? `[${n + 1}] Wiki page: ${c.title} (${c.page})\n${c.text}`
    : `[${n + 1}] Source file ${c.file}:L${c.start}-L${c.end}\n\`\`\`${fenceLang(c.file)}\n${c.text}\n\`\`\``)).join('\n\n');
  const system = [
    `You are Safe4wiki's assistant for the repository ${owner}/${repo}. You answer questions about its documentation and code.`,
    'Use the context below (wiki sections and source excerpts). If it does not contain the answer, say what is missing instead of guessing.',
    'Cite code as [path/to/file.ext:L10-L24] right after the sentence it supports, using paths and line numbers exactly as given in the context.',
    'Write clear Markdown: short paragraphs, lists, tables when they help, and a ```mermaid diagram (flowchart or sequenceDiagram) when explaining a flow.',
    'Answer in the language the question is written in.',
    agent ? 'You are running inside the repository folder: you may open more files to check details, but do not change anything.' : '',
  ].filter(Boolean).join('\n');
  const msgs = [{ role: 'system', content: system }];
  for (const h of history || []) {
    if (h.q) msgs.push({ role: 'user', content: h.q });
    if (h.a) msgs.push({ role: 'assistant', content: String(h.a).slice(0, 4000) });
  }
  msgs.push({
    role: 'user',
    content: `${overview ? `Wiki overview:\n${overview}\n\n` : ''}Context:\n\n${ctx || '(no matching context found)'}${attachedText(attachments)}\n\nQuestion: ${question}`,
  });
  return msgs;
}

/** Files the person attached to a question (text only, already size-limited). */
function attachedText(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return '';
  return attachments.map(a => `\n\nAttached by the user: ${a.name}\n\`\`\`${fenceLang(a.name)}\n${a.text}\n\`\`\``).join('');
}

async function streamOpenAI(profile, messages, onDelta, signal) {
  const url = `${String(profile.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const key = resolveApiKey(profile.apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model: profile.model, messages, temperature: profile.temperature ?? 0.2, max_tokens: profile.maxTokens ?? 4096, stream: true }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} from ${url}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
  let full = '';
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices && j.choices[0] && j.choices[0].delta;
        const text = d && (d.content || '');
        if (text) { full += text; onDelta(text); }
      } catch { /* ignore keep-alives */ }
    }
  }
  return full;
}

async function streamOllama(profile, messages, onDelta, signal) {
  const url = `${String(profile.baseUrl || 'http://localhost:11434').replace(/\/+$/, '')}/api/chat`;
  const baseBody = {
    model: profile.model,
    messages,
    stream: true,
    options: { temperature: profile.temperature ?? 0.2, num_ctx: ollamaContextSize(profile), num_predict: profile.maxTokens ?? 4096 },
  };
  const post = payload => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  let res = await post({ ...baseBody, think: profile.think ?? false });
  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 300);
    if (/think/i.test(errText)) {
      res = await post(baseBody);
      if (!res.ok || !res.body) {
        const body2 = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`HTTP ${res.status} from ${url}: ${body2}`);
      }
    } else {
      throw new Error(`HTTP ${res.status} from ${url}: ${errText}`);
    }
  }
  if (!res.body) throw new Error(`HTTP ${res.status} from ${url}: empty body`);
  let full = '';
  let buf = '';
  const decoder = new TextDecoder();
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        const text = j.message && j.message.content;
        if (text) { full += text; onDelta(text); }
      } catch { /* ignore */ }
    }
  }
  return full;
}

/** Strips <think> blocks while streaming. */
function thinkFilter(onDelta) {
  let inThink = false;
  let pending = '';
  return text => {
    pending += text;
    let out = '';
    for (;;) {
      if (inThink) {
        const end = pending.indexOf('</think>');
        if (end < 0) { pending = pending.slice(-8); break; }
        pending = pending.slice(end + 8); inThink = false;
      } else {
        const start = pending.indexOf('<think>');
        if (start < 0) {
          const keep = pending.lastIndexOf('<');
          if (keep >= 0 && pending.length - keep < 7) { out += pending.slice(0, keep); pending = pending.slice(keep); } else { out += pending; pending = ''; }
          break;
        }
        out += pending.slice(0, start); pending = pending.slice(start + 7); inThink = true;
      }
    }
    if (out) onDelta(out);
  };
}

async function answer({ owner, repo, question, history, mode, modelName, pages, attachments, emit, signal }) {
  const settings = store.loadSettings();
  const record = store.findWikiRecord(owner, repo);
  let wikiPages = pages;
  let repoDir = null;
  let cacheDir = null;
  if (record) {
    const content = store.loadWikiContent(record);
    if (content) wikiPages = content.pages;
    repoDir = record.repoDir;
    cacheDir = store.wikiDir(record.owner, record.repo);
  }
  if (!wikiPages || !wikiPages.length) throw new Error('This wiki has no pages to search yet.');
  const name = modelName && settings.models[modelName] ? modelName : (settings.chatModel || settings.default);
  const profile = settings.models[name];
  if (!profile) throw new Error('No model is set up. Open Model settings to add one.');

  emit('status', { message: 'Searching the wiki and the code…' });
  const index = getIndex({ owner, repo, pages: wikiPages, repoDir, cacheDir });
  const deep = mode === 'deep';
  const budget = Math.max(6000, Math.min((profile.contextChars || 24000) * 0.7, deep ? 90000 : 24000));
  const candidates = await retrieve(index, settings, `${question} ${(history || []).slice(-1).map(h => h.q).join(' ')}`, deep ? 28 : 10, m => emit('status', { message: m }));
  const contexts = [];
  let used = 0;
  for (const c of candidates) {
    if (used + c.text.length > budget) continue;
    contexts.push(c);
    used += c.text.length;
  }
  // If retrieval returned nothing (e.g. broad or cross-language overview question),
  // fall back to the opening wiki sections so the model always has grounded context.
  if (contexts.length === 0) {
    for (const c of index.chunks) {
      if (c.kind !== 'wiki') continue;
      if (used + c.text.length > Math.min(budget, 8000)) break;
      contexts.push(c);
      used += c.text.length;
      if (contexts.length >= 3) break;
    }
  }
  const overview = wikiPages.slice(0, 60).map(p => `- ${p.title} (${p.path})`).join('\n');
  emit('sources', {
    sources: contexts.filter(c => c.kind === 'code').map(c => ({ file: c.file, start: c.start, end: c.end, snippet: c.text })),
    pages: [...new Map(contexts.filter(c => c.kind === 'wiki').map(c => [c.page, { path: c.page, title: c.title }])).values()],
  });

  const agent = profile.provider === 'agent-cli';
  const messages = buildMessages({ owner, repo, question, history, contexts, agent, overview, attachments });
  emit('status', { message: `Asking ${name}…` });
  const onDelta = thinkFilter(text => emit('delta', { text }));
  let full;
  if (profile.provider === 'openai') full = await streamOpenAI(profile, messages, onDelta, signal);
  else if (profile.provider === 'ollama') full = await streamOllama(profile, messages, onDelta, signal);
  else {
    let streamed = 0;
    const onChunk = profile.provider === 'agent-cli' ? chunk => { streamed += chunk.length; onDelta(chunk); } : undefined;
    const res = await chatDetailed({ ...profile, cwd: repoDir || profile.cwd }, messages, { retries: 1, cwd: repoDir || undefined, signal, onChunk });
    full = res.content;
    if (!streamed) onDelta(full);
  }
  emit('done', { model: name, answer: full.replace(/<think>[\s\S]*?<\/think>/g, '').trim() });
}

module.exports = { answer, invalidate, prewarm, tokenize, wikiChunks, codeChunks, buildBm25, retrieve, thinkFilter, buildMessages, streamOllama };

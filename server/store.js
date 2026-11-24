'use strict';
/**
 * Everything RepoWiki keeps on disk lives in one data folder
 * (REPOWIKI_HOME, default ~/.repowiki):
 *   settings.json          model profiles, chat/search, publish targets (mode 600)
 *   wikis/<owner__repo>/   wiki.json + the engine's output (<lang>/content, <lang>/meta)
 *   repos/<owner__repo>/   clones of Git repositories
 *   exports/               HTML exports
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveRealPath(target) {
  const abs = path.resolve(target);
  const tail = [];
  let cur = abs;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    return path.join(fs.realpathSync(cur), ...tail);
  } catch {
    return abs;
  }
}

const HOME = resolveRealPath(process.env.REPOWIKI_HOME || path.join(os.homedir(), '.repowiki'));
const SETTINGS_FILE = path.join(HOME, 'settings.json');

const DEFAULT_SETTINGS = {
  default: 'inkling-2-mini',
  chatModel: '',
  maxPages: 'auto',
  language: 'en',
  template: 'standard',
  models: {
    'inkling-2-mini': { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'inkling-2-mini:latest', think: false, contextChars: 48000, contextSize: 24576, maxTokens: 16384 },
    ollama: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b', contextChars: 48000, maxTokens: 8192 },
    'claude-code': { provider: 'agent-cli', command: 'claude', args: ['-p', '--output-format', 'text', '--permission-mode', 'plan'], contextChars: 60000, timeoutMs: 900000 },
  },
  embedding: { enabled: false, baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', apiKey: '' },
  publish: { method: 'ssh' },
  gitTokens: {},
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data, mode = 0o600) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode, flag: 'wx' });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, mode); } catch { /* ignore */ }
}

function loadSettings() {
  const saved = readJson(SETTINGS_FILE, null);
  if (!saved) return JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    embedding: { ...DEFAULT_SETTINGS.embedding, ...(saved.embedding || {}) },
    publish: { ...(saved.publish || {}) },
    gitTokens: { ...(saved.gitTokens || {}) },
    models: saved.models || {},
  };
}

function saveSettings(settings) {
  writeJson(SETTINGS_FILE, settings, 0o600);
}

const SECRET_KEYS = ['apiKey', 'token'];
const isEnvRef = v => typeof v === 'string' && v.startsWith('env:');

/** Settings as sent to the browser: secrets replaced by "hasKey"/"hasToken". */
function publicSettings(s) {
  const mask = obj => {
    const out = { ...obj };
    for (const k of SECRET_KEYS) {
      if (out[k] && !isEnvRef(out[k])) {
        out[k === 'apiKey' ? 'hasKey' : 'hasToken'] = true;
        out[k] = '';
      }
    }
    return out;
  };
  const models = {};
  for (const [n, p] of Object.entries(s.models || {})) models[n] = mask(p);
  return {
    default: s.default,
    chatModel: s.chatModel,
    maxPages: s.maxPages,
    language: s.language,
    template: s.template,
    models,
    embedding: mask(s.embedding || {}),
    publish: mask(s.publish || {}),
    dataDir: HOME,
  };
}

function samePublishDestination(prev = {}, next = {}) {
  if (!prev.method || prev.method !== next.method) return false;
  if (prev.method === 'github') return String(prev.repoUrl || '').trim() === String(next.repoUrl || '').trim();
  if (prev.method === 'cloudflare') {
    return String(prev.accountId || '').trim() === String(next.accountId || '').trim()
      && String(prev.project || '').trim() === String(next.project || '').trim();
  }
  if (prev.method === 'netlify') return String(prev.siteId || '').trim() === String(next.siteId || '').trim();
  return false;
}

/** Applies settings from the browser, keeping saved secrets only when their bound destination is unchanged. */
function mergeSettings(current, incoming) {
  const keep = (prev = {}, next = {}, canKeepSecret = () => false) => {
    const out = { ...next };
    delete out.hasKey; delete out.hasToken;
    for (const k of SECRET_KEYS) {
      if ((out[k] === '' || out[k] === undefined) && prev[k] && next[`has${k === 'apiKey' ? 'Key' : 'Token'}`] && canKeepSecret(prev, out, k)) {
        out[k] = prev[k];
      }
      if (out[k] === '') delete out[k];
    }
    return out;
  };
  const sameModelDest = (prev, next) => prev.provider === next.provider && String(prev.baseUrl || '') === String(next.baseUrl || '');
  const sameEmbedDest = (prev, next) => String(prev.baseUrl || '') === String(next.baseUrl || '');
  const models = {};
  for (const [name, p] of Object.entries(incoming.models || {})) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) throw new Error(`Invalid profile name: ${name}`);
    const provider = p.provider;
    if (!['openai', 'anthropic', 'ollama', 'llamacpp', 'agent-cli'].includes(provider)) throw new Error(`Unknown provider for ${name}`);
    models[name] = keep(current.models[name], p, sameModelDest);
  }
  const next = {
    ...current,
    default: models[incoming.default] ? incoming.default : Object.keys(models)[0] || '',
    chatModel: models[incoming.chatModel] ? incoming.chatModel : '',
    maxPages: (incoming.maxPages === 'auto' || incoming.maxPages === '' || incoming.maxPages === null || incoming.maxPages === undefined || Number(incoming.maxPages) === 0)
      ? 'auto'
      : Math.max(3, Math.min(200, Number(incoming.maxPages) || 36)),
    language: /^[A-Za-z0-9-]{2,10}$/.test(incoming.language || '') ? incoming.language : 'en',
    template: incoming.template === 'minimal' ? 'minimal' : 'standard',
    models,
    embedding: keep(current.embedding, incoming.embedding || current.embedding, sameEmbedDest),
  };
  if (incoming.publish) next.publish = keep(current.publish, incoming.publish, samePublishDestination);
  return next;
}

/* ---------------- wikis ---------------- */

const safePart = s => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'repo';
const wikiKey = (owner, repo) => `${safePart(owner)}__${safePart(repo)}`;
const wikiDir = (owner, repo) => path.join(HOME, 'wikis', wikiKey(owner, repo));
const repoCloneDir = (owner, repo) => path.join(HOME, 'repos', wikiKey(owner, repo));

function listWikiRecords() {
  const dir = path.join(HOME, 'wikis');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .map(n => readJson(path.join(dir, n, 'wiki.json'), null))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function findWikiRecord(owner, repo) {
  const direct = readJson(path.join(wikiDir(owner, repo), 'wiki.json'), null);
  if (direct) return direct;
  const lower = `${owner}/${repo}`.toLowerCase();
  return listWikiRecords().find(w => `${w.owner}/${w.repo}`.toLowerCase() === lower) || null;
}

function saveWikiRecord(record) {
  record.updatedAt = new Date().toISOString();
  writeJson(path.join(wikiDir(record.owner, record.repo), 'wiki.json'), record);
  return record;
}

function contentDir(record) {
  return path.join(wikiDir(record.owner, record.repo), record.language || 'en', 'content');
}

/** Reads a generated wiki (catalog + markdown pages) in the shape the browser uses. */
function loadWikiContent(record) {
  const lang = record.language || 'en';
  const base = wikiDir(record.owner, record.repo);
  const catalog = readJson(path.join(base, lang, 'meta', 'catalog.json'), null);
  if (!catalog || !Array.isArray(catalog.pages)) return null;
  const content = path.join(base, lang, 'content');
  const pages = [];
  for (const p of catalog.pages) {
    const file = path.resolve(content, p.path);
    if (!file.startsWith(content + path.sep)) continue;
    let markdown;
    try { markdown = fs.readFileSync(file, 'utf8'); } catch { continue; }
    pages.push({ path: p.path, title: p.title, parent: p.parent || null, description: p.description || '', files: p.dependent_files || [], markdown });
  }
  // A landing index page that only lists other pages goes last.
  pages.sort((a, b) => (a.path === 'index.md') - (b.path === 'index.md'));
  return {
    id: `${record.owner}/${record.repo}`,
    owner: record.owner,
    repo: record.repo,
    description: record.description || (pages[0] && pages[0].description) || '',
    lastIndexed: record.lastIndexed || catalog.generatedAt,
    commit: record.commit || '',
    model: catalog.model || record.model,
    generatedBy: record.generatedBy || catalog.generatedBy || catalog.model || record.model || '',
    plannedPages: record.plannedPages || null,
    source: sourceInfo(record),
    pages,
  };
}

function sourceInfo(record) {
  const src = record.source || {};
  if (src.type === 'git') {
    const m = String(src.url || '').match(/^(?:https?:\/\/|git@)([^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (m && /github\.com|gitlab\.com|bitbucket\.org|gitea|codeberg/.test(m[1])) {
      return { type: 'github', url: `https://${m[1]}/${m[2]}/${m[3]}`, commit: record.commitFull || record.commit || 'HEAD' };
    }
    return { type: 'local', root: record.repoDir };
  }
  return { type: 'local', root: record.repoDir };
}

function jobLogFile(owner, repo) {
  return path.join(wikiDir(owner, repo), 'job.log');
}

/**
 * If a generation run was stopped or failed mid-way, copies any completed pages
 * from the newest staging folder into the live wiki and rebuilds catalog.json
 * so the user can immediately read what was already generated and resume later.
 */
function promotePartialStage(record) {
  if (!record) return { promoted: 0, total: 0 };
  const lang = record.language || 'en';
  const langDir = path.join(wikiDir(record.owner, record.repo), lang);
  let entries = [];
  try { entries = fs.readdirSync(langDir, { withFileTypes: true }); } catch { return { promoted: 0, total: 0 }; }

  const stages = entries
    .filter(e => e.isDirectory() && e.name.startsWith('.content.stage-'))
    .map(e => {
      const full = path.join(langDir, e.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
      return { name: e.name, full, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const stage of stages) {
    const stageState = readJson(path.join(stage.full, '.state.json'), null);
    const metaMap = stageState && stageState.pageMetadata && typeof stageState.pageMetadata === 'object'
      ? stageState.pageMetadata
      : null;
    const hasPendingPlan = Array.isArray(stageState?.pendingPlan) && stageState.pendingPlan.length > 0;
    if ((!metaMap || !Object.keys(metaMap).length) && !hasPendingPlan) continue;

    const liveContent = path.join(langDir, 'content');
    const liveMeta = path.join(langDir, 'meta');
    ensureDir(liveContent);
    ensureDir(liveMeta);

    const liveStatePath = path.join(liveContent, '.state.json');
    const liveState = readJson(liveStatePath, { model: record.model || stageState.model || '', pages: {}, pageMetadata: {} });
    if (!liveState.pages || typeof liveState.pages !== 'object') liveState.pages = {};
    if (!liveState.pageMetadata || typeof liveState.pageMetadata !== 'object') liveState.pageMetadata = {};

    let promoted = 0;
    for (const [relPath, meta] of Object.entries(metaMap || {})) {
      if (!relPath || relPath.includes('..') || path.isAbsolute(relPath)) continue;
      const srcFile = path.resolve(stage.full, relPath);
      const dstFile = path.resolve(liveContent, relPath);
      if (!srcFile.startsWith(stage.full + path.sep) || !dstFile.startsWith(liveContent + path.sep)) continue;
      if (!fs.existsSync(srcFile)) continue;
      ensureDir(path.dirname(dstFile));
      fs.copyFileSync(srcFile, dstFile);
      liveState.pageMetadata[relPath] = { ...meta, path: relPath };
      if (stageState.pages && stageState.pages[relPath]) {
        liveState.pages[relPath] = stageState.pages[relPath];
      }
      promoted++;
    }

    if (promoted === 0 && !hasPendingPlan) continue;

    if (hasPendingPlan) liveState.pendingPlan = stageState.pendingPlan;
    liveState.model = stageState.model || liveState.model || record.model || '';
    liveState.generatedAt = new Date().toISOString();
    writeJson(liveStatePath, liveState);

    const published = Object.values(liveState.pageMetadata).filter(m => {
      if (!m || !m.path) return false;
      const f = path.resolve(liveContent, m.path);
      return f.startsWith(liveContent + path.sep) && fs.existsSync(f);
    });
    const byPath = new Map(published.map(m => [m.path, m]));
    const parentByChild = new Map();
    for (const m of published) {
      if (!m.isLanding || !Array.isArray(m.child_paths)) continue;
      for (const child of m.child_paths) {
        if (byPath.has(child) && !parentByChild.has(child)) parentByChild.set(child, m.path);
      }
    }
    const catalog = {
      repo: record.repo,
      model: liveState.model || record.model || '',
      generatedBy: record.generatedBy || liveState.model || record.model || '',
      language: lang,
      generatedAt: liveState.generatedAt,
      partial: true,
      pages: published.map(m => ({
        path: m.path,
        title: m.title,
        description: m.description || '',
        dependent_files: Array.isArray(m.dependent_files) ? m.dependent_files : [],
        parent: parentByChild.get(m.path) || null,
        isLanding: !!m.isLanding,
        quality: m.quality || 'ok',
        protected: m.curated === true || m.externallyModified === true,
      })),
    };
    if (published.length > 0) writeJson(path.join(liveMeta, 'catalog.json'), catalog);

    // Clean up promoted stage directories
    const suffix = stage.name.slice('.content.stage-'.length);
    try { fs.rmSync(stage.full, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(langDir, `.meta.stage-${suffix}`), { recursive: true, force: true }); } catch { /* ignore */ }
    return { promoted, total: catalog.pages.length, planned: hasPendingPlan ? stageState.pendingPlan.length : 0 };
  }
  return { promoted: 0, total: 0, planned: 0 };
}

module.exports = {
  HOME,
  ensureDir,
  readJson,
  writeJson,
  loadSettings,
  saveSettings,
  publicSettings,
  mergeSettings,
  samePublishDestination,
  safePart,
  wikiKey,
  wikiDir,
  repoCloneDir,
  jobLogFile,
  listWikiRecords,
  findWikiRecord,
  saveWikiRecord,
  contentDir,
  loadWikiContent,
  promotePartialStage,
  sourceInfo,
};

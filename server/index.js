'use strict';
/**
 * RepoWiki local server. Serves the built app (dist/) and the /api used by it.
 * Listens on 127.0.0.1 only and refuses requests from other sites, because it
 * can read folders, run model backends and agent CLIs, and publish.
 *
 *   npm run build   (once)
 *   npm start       -> http://localhost:4317
 */
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const jobs = require('./jobs');
const rag = require('./rag');
const { exportSite, exportSingleHtml, zipDir, printPdf } = require('./export');
const { publish } = require('./publish');
const { chatDetailed, resolveApiKey, resolveAgentNode } = require('./engine/providers');
const { isSensitiveName } = require('./engine/scan');
const { hostOf } = require('./git');

const PORT = Number(process.env.PORT || 4317);
const DIST = path.join(__dirname, '..', 'dist');
const ALLOWED_TEST_CLIS = new Set(['claude', 'codex', 'gemini', 'opencode', 'dsh', 'zcode']);

function loadOrCreateSessionToken() {
  store.ensureDir(store.HOME);
  try { fs.chmodSync(store.HOME, 0o700); } catch { /* ignore */ }
  const tokenFile = path.join(store.HOME, '.session-token');
  try {
    const lst = fs.lstatSync(tokenFile);
    if (!lst.isSymbolicLink() && lst.isFile()) {
      const existing = fs.readFileSync(tokenFile, 'utf8').trim();
      if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    }
  } catch { /* generate fresh token */ }
  const token = crypto.randomBytes(32).toString('hex');
  try { fs.unlinkSync(tokenFile); } catch { /* ignore */ }
  fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(tokenFile, 0o600); } catch { /* ignore */ }
  return token;
}

const SESSION_TOKEN = loadOrCreateSessionToken();
const SESSION_COOKIE = 's4w_session';

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function validSessionToken(candidate) {
  if (typeof candidate !== 'string' || candidate.length !== SESSION_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(SESSION_TOKEN, 'utf8'));
  } catch { return false; }
}

function hasValidSession(req) {
  const hdr = req.headers['x-safe4wiki-token'];
  if (typeof hdr === 'string' && validSessionToken(hdr.trim())) return true;
  const cookies = parseCookies(req.headers.cookie);
  return validSessionToken(cookies[SESSION_COOKIE]);
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.json': 'application/json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

/* ---------------- helpers ---------------- */

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf ? 'application/octet-stream' : typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}
const fail = (res, status, message, extra = {}) => send(res, status, { error: message, ...extra });

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Request too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => {
      const text = Buffer.concat(parts).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sse(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': ok\n\n');
  const keep = setInterval(() => res.write(': ping\n\n'), 15000);
  res.on('close', () => clearInterval(keep));
  return (type, data) => { if (!res.writableEnded) res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
}

/** Only this computer, same-origin pages, and authenticated local sessions. */
function isLoopbackHost(req) {
  const host = String(req.headers.host || '');
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

function allowed(req, url) {
  if (!isLoopbackHost(req)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (origin !== new URL(`http://${req.headers.host}`).origin) return false;
    } catch { return false; }
  }
  // Allow minimal unauthenticated liveness check on loopback for launcher script.
  if (url && url.pathname === '/api/health' && req.method === 'GET') return true;
  return hasValidSession(req);
}

function nameFromSource(source) {
  if (source.type === 'git') {
    const m = String(source.url).match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (m) return [m[1], m[2]];
    return ['git', 'repo'];
  }
  return ['local', path.basename(String(source.path).replace(/[\\/]+$/, '')) || 'project'];
}

function wikiResponse(record) {
  const active = jobs.findActiveJob(record.owner, record.repo);
  const jobObj = active || (record.jobId ? jobs.jobs.get(record.jobId) : null);
  const job = jobs.publicJob(jobObj);
  const content = store.loadWikiContent(record);
  const effectiveStatus = active ? (active.status === 'running' ? 'generating' : 'queued') : record.status;
  return {
    wiki: content,
    status: effectiveStatus,
    error: record.error || null,
    job: job || ((effectiveStatus === 'failed' || effectiveStatus === 'paused') ? { id: null, status: effectiveStatus, error: record.error || null } : null),
  };
}

function readLogTail(file, maxBytes = 200 * 1024) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function sq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function openTerminalCommand(shellCmd, fallbackCmd) {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      const asStr = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const script = [
        'tell application "Terminal"',
        '  activate',
        `  do script ${asStr(shellCmd)}`,
        'end tell',
      ].join('\n');
      const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => reject(new Error(`Could not open Terminal: ${e.message}`)));
      child.on('close', code => (code === 0 ? resolve({ ok: true }) : reject(new Error(err.trim() || `osascript exited with ${code}`))));
      return;
    }
    reject(new Error(`Run in your terminal: ${fallbackCmd || shellCmd}`));
  });
}

function openLogTerminal(logFile) {
  store.ensureDir(path.dirname(logFile));
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, 'Waiting for log output…\n');
  const tailCmd = `clear; echo "=== Safe4wiki Live Log ==="; tail -n 100 -f ${sq(logFile)}`;
  return openTerminalCommand(tailCmd, `tail -f ${sq(logFile)}`).then(() => ({ ok: true, path: logFile }));
}

function buildCliAuthCommand(command) {
  const cmd = String(command || '').trim();
  if (cmd === 'zcode') {
    const isolated = path.join(store.HOME, 'zcode-cli');
    store.ensureDir(isolated);
    const resources = '/Applications/ZCode.app/Contents/Resources';
    const bundle = path.join(resources, 'glm', 'zcode.cjs');
    const config = path.join(resources, 'config', 'provider', 'zcode-builtin.json');
    if (process.platform === 'darwin' && fs.existsSync(bundle) && fs.existsSync(config)) {
      const nodeBin = resolveAgentNode(process.env);
      if (!nodeBin) throw new Error('ZCode CLI requires Node.js 22.13 or newer (with node:sqlite). Install Node 22+ or 24 via nvm/Homebrew.');
      return {
        label: 'ZCode (Z.AI)',
        loginCmd: `ZCODE_DATA_BASE_DIR=${sq(isolated)} ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=${sq(config)} ${sq(nodeBin)} ${sq(bundle)} login zai`,
      };
    }
    return { label: 'ZCode (Z.AI)', loginCmd: `ZCODE_DATA_BASE_DIR=${sq(isolated)} zcode login zai` };
  }
  if (cmd === 'claude') return { label: 'Claude Code', loginCmd: 'claude auth login' };
  if (cmd === 'codex') return { label: 'Codex', loginCmd: 'codex login' };
  if (cmd === 'opencode') {
    const nodeBin = resolveAgentNode(process.env);
    const prefix = nodeBin ? `PATH=${sq(path.dirname(nodeBin))}:$PATH ` : '';
    return { label: 'OpenCode', loginCmd: `${prefix}opencode auth login` };
  }
  if (cmd === 'gemini') return { label: 'Gemini CLI', loginCmd: 'gemini' };
  return null;
}

function openCliAuthTerminal(command) {
  const info = buildCliAuthCommand(command);
  if (!info) return Promise.reject(new Error(`No interactive sign-in command configured for '${command || '(empty)'}'.`));
  const shellCmd = `clear; echo "=== Safe4wiki · ${info.label} Sign-In ==="; echo "Finish sign-in in your browser/terminal, then return to Safe4wiki and click Test."; echo ""; ${info.loginCmd}`;
  return openTerminalCommand(shellCmd, info.loginCmd).then(() => ({ ok: true, command: info.loginCmd, label: info.label }));
}

/* ---------------- routes ---------------- */

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
  const method = req.method;
  const route = parts.slice(1);

  if (route[0] === 'health') {
    return send(res, 200, hasValidSession(req) ? { app: 'safe4wiki', version: 1, dataDir: store.HOME } : { app: 'safe4wiki', version: 1 });
  }

  if (route[0] === 'settings' && route.length === 1) {
    if (method === 'GET') return send(res, 200, store.publicSettings(store.loadSettings()));
    if (method === 'PUT') {
      const next = store.mergeSettings(store.loadSettings(), await readBody(req));
      store.saveSettings(next);
      return send(res, 200, store.publicSettings(next));
    }
  }

  if (route[0] === 'models' && method === 'POST') {
    if (route[1] === 'zcode-auth' || route[1] === 'cli-auth') {
      const body = route[1] === 'cli-auth' ? await readBody(req) : { command: 'zcode' };
      try {
        return send(res, 200, await openCliAuthTerminal(body.command || 'zcode'));
      } catch (err) {
        return fail(res, 400, err.message);
      }
    }
    const body = await readBody(req);
    const settings = store.loadSettings();
    const saved = settings.models[body.name] || {};
    const { apiKey: savedKey, ...savedSafe } = saved;
    const profile = { ...savedSafe, ...(body.profile || {}) };
    const allowSavedKey = !body.profile || !!body.profile.hasKey;
    if (!profile.apiKey && savedKey && allowSavedKey && (saved.baseUrl || '') === (profile.baseUrl || '')) {
      profile.apiKey = savedKey;
    }
    delete profile.hasKey;
    // Reject unsaved transient env: references unless they match the saved profile's exact baseUrl & apiKey.
    if (typeof profile.apiKey === 'string' && profile.apiKey.startsWith('env:')) {
      const sameSavedEnv = savedKey === profile.apiKey && (saved.baseUrl || '') === (profile.baseUrl || '');
      if (!sameSavedEnv && !resolveApiKey(profile.apiKey)) {
        return fail(res, 400, 'Environment variable references are restricted to standard LLM API key names.');
      }
      if (!sameSavedEnv && body.profile && body.profile.baseUrl && saved.baseUrl && body.profile.baseUrl !== saved.baseUrl) {
        return fail(res, 400, 'Save the updated base URL before testing an environment API key reference.');
      }
    }
    if (route[1] === 'test') {
      const started = Date.now();
      let testCwd = null;
      try {
        if (profile.provider === 'agent-cli') {
          const cmd = String(profile.command || '').trim();
          const savedCmd = String(saved.command || '').trim();
          if (!ALLOWED_TEST_CLIS.has(cmd) && (!savedCmd || cmd !== savedCmd)) {
            return fail(res, 400, `Save the custom CLI profile before testing arbitrary commands (${cmd || 'empty'}).`);
          }
        }
        testCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'safe4wiki-test-'));
        const testRetries = (profile.provider === 'agent-cli' && profile.command === 'zcode') ? 1 : 0;
        const r = await chatDetailed({ ...profile, cwd: testCwd }, [{ role: 'user', content: 'Reply with exactly one word: ready' }], { retries: testRetries, maxTokens: 64, timeoutMs: 120000, cwd: testCwd });
        const reply = String(r.content || '').trim();
        if (!/\bready\b/i.test(reply) && reply.length > 40) {
          return fail(res, 400, `Model did not follow the test prompt (check CLI arguments / stdin). Replied: “${reply.slice(0, 180)}”`);
        }
        return send(res, 200, { ok: true, reply: reply.slice(0, 200), ms: Date.now() - started });
      } catch (err) { return fail(res, 400, err.message.slice(0, 500)); }
      finally {
        if (testCwd) { try { fs.rmSync(testCwd, { recursive: true, force: true }); } catch { /* ignore */ } }
      }
    }
    if (route[1] === 'list') {
      try {
        if (profile.provider === 'agent-cli' && String(profile.command || '').trim() === 'codex') {
          const cachePath = path.join(os.homedir(), '.codex', 'models_cache.json');
          if (fs.existsSync(cachePath)) {
            const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            const models = (Array.isArray(cache?.models) ? cache.models : [])
              .filter(m => m && m.slug && m.visibility !== 'hide')
              .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
              .map(m => String(m.slug));
            if (models.length) return send(res, 200, { models: [...new Set(models)] });
          }
          return send(res, 200, { models: [] });
        }
        if (profile.provider === 'agent-cli' && String(profile.command || '').trim() === 'opencode') {
          const env = { ...process.env, NO_COLOR: '1' };
          const nodeBin = resolveAgentNode(env);
          if (nodeBin) env.PATH = [path.dirname(nodeBin), env.PATH].filter(Boolean).join(path.delimiter);
          const list = await new Promise(resolve => {
            const child = spawn('opencode', ['models'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
            let out = '';
            const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} resolve([]); }, 6000);
            child.stdout.on('data', d => { out += d; });
            child.on('error', () => { clearTimeout(t); resolve([]); });
            child.on('close', () => {
              clearTimeout(t);
              const lines = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split(/\r?\n/).map(s => s.trim()).filter(s => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:@-]+$/.test(s));
              const score = m => (/^opencode\/.*deepseek.*free/i.test(m) ? 0 : /^opencode\/.*free/i.test(m) ? 1 : /deepseek/i.test(m) ? 2 : /^opencode\//.test(m) ? 3 : 4);
              resolve([...new Set(lines)].sort((a, b) => score(a) - score(b) || a.localeCompare(b)).slice(0, 300));
            });
          });
          return send(res, 200, { models: list });
        }
        const base = String(profile.baseUrl || '').replace(/\/+$/, '');
        if (profile.provider === 'ollama') {
          const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) });
          const j = await r.json();
          return send(res, 200, { models: (j.models || []).map(m => m.name) });
        }
        const key = resolveApiKey(profile.apiKey || '');
        const r = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(4000) });
        const j = await r.json();
        return send(res, 200, { models: (j.data || []).map(m => m.id).slice(0, 300) });
      } catch { return send(res, 200, { models: [] }); }
    }
  }

  if (route[0] === 'pick-folder' && method === 'POST') {
    const picked = await pickFolder().catch(err => ({ error: err.message }));
    if (picked.error) return fail(res, 400, picked.error);
    return send(res, 200, picked);
  }

  if (route[0] === 'wikis' && route.length === 1) {
    if (method === 'GET') {
      return send(res, 200, {
        wikis: store.listWikiRecords().map(r => ({
          owner: r.owner, repo: r.repo, description: r.description, status: r.status,
          source: { type: r.source.type }, lastIndexed: r.lastIndexed, model: r.model,
          generatedBy: r.generatedBy || r.model || '',
          plannedPages: r.plannedPages || null,
        })),
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const settings = store.loadSettings();
      const src = body.source || {};
      let source;
      if (src.type === 'local') {
        const p = String(src.path || '').replace(/^~(?=\/|$)/, os.homedir()).trim();
        if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) return fail(res, 400, `Folder not found: ${p || '(empty)'}`);
        source = { type: 'local', path: fs.realpathSync(p) };
      } else if (src.type === 'git') {
        const u = String(src.url || '').trim();
        if (!/^(https:\/\/|http:\/\/|git@|ssh:\/\/)[^\s]+$/i.test(u)) return fail(res, 400, 'Enter a Git address (https://… or git@…)');
        if (src.branch && !/^(?!-)[A-Za-z0-9._/-]+$/.test(src.branch)) return fail(res, 400, 'Invalid branch name');
        source = { type: 'git', url: u.replace(/^(https?:\/\/)[^@/]+@/i, '$1'), branch: src.branch || undefined };
        if (src.token) { settings.gitTokens[hostOf(u)] = String(src.token); store.saveSettings(settings); }
      } else return fail(res, 400, 'Choose a folder or a Git repository');

      const model = body.model && settings.models[body.model] ? body.model : settings.default;
      if (!settings.models[model]) return fail(res, 400, 'Add a model first in Model settings.');

      let [owner, repo] = nameFromSource(source);
      const rawName = String(body.name || '').trim();
      if (rawName) {
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(rawName)) {
          return fail(res, 400, 'Name must be in owner/repo format (letters, digits, ., _, -)');
        }
        [owner, repo] = rawName.split('/');
      }
      owner = store.safePart(owner); repo = store.safePart(repo);
      let existing = store.findWikiRecord(owner, repo);
      const sameSource = existing && JSON.stringify({ ...existing.source, branch: undefined }) === JSON.stringify({ ...source, branch: undefined });
      if (existing && !sameSource) {
        let n = 2;
        while (store.findWikiRecord(owner, `${repo}-${n}`)) n++;
        repo = `${repo}-${n}`;
        existing = null;
      }
      const record = existing || { owner, repo, source, createdAt: new Date().toISOString(), language: settings.language || 'en' };
      const active = jobs.findActiveJob(owner, repo, 'generate');
      if (active) return send(res, 200, { owner, repo, job: jobs.publicJob(active) });
      record.source = source;
      record.maxPages = body.maxPages ? Math.max(3, Math.min(200, Number(body.maxPages))) : record.maxPages;
      record.status = 'queued';
      store.saveWikiRecord(record);
      const job = jobs.enqueue({ kind: 'generate', owner, repo, model, token: src.token || undefined });
      return send(res, 200, { owner, repo, job: jobs.publicJob(job) });
    }
  }

  if (route[0] === 'wikis' && route.length >= 3) {
    const [owner, repo, action] = [route[1], route[2], route[3]];
    const record = store.findWikiRecord(owner, repo);
    if (!record) {
      if (!action && method === 'GET') return send(res, 200, { wiki: null, status: null });
      return fail(res, 404, 'No local wiki with that name');
    }
    if (!action && method === 'GET') return send(res, 200, wikiResponse(record));
    if (!action && method === 'DELETE') {
      jobs.cancelForDelete(record.owner, record.repo);
      fs.rmSync(store.wikiDir(record.owner, record.repo), { recursive: true, force: true });
      if (record.source.type === 'git') fs.rmSync(store.repoCloneDir(record.owner, record.repo), { recursive: true, force: true });
      rag.invalidate(record.owner, record.repo);
      return send(res, 200, { ok: true });
    }
    if (action === 'refresh' && method === 'POST') {
      const active = jobs.findActiveJob(record.owner, record.repo, 'generate');
      if (active) return send(res, 200, { job: jobs.publicJob(active) });
      const body = await readBody(req);
      const settings = store.loadSettings();
      const model = (body.model && settings.models[body.model])
        ? body.model
        : (settings.default && settings.models[settings.default] ? settings.default : record.model);
      if (!model || !settings.models[model]) return fail(res, 400, 'Add a model first in Model settings.');
      const resume = body.force ? false : (body.resume !== undefined ? !!body.resume : (record.status === 'paused' || record.status === 'failed'));
      const job = jobs.enqueue({ kind: 'generate', owner: record.owner, repo: record.repo, model, force: !!body.force, resume });
      record.status = record.status === 'ready' ? 'generating' : 'queued';
      record.model = model;
      record.jobId = job.id;
      store.saveWikiRecord(record);
      return send(res, 200, { job: jobs.publicJob(job) });
    }
    if (action === 'log' && method === 'GET') {
      const file = store.jobLogFile(record.owner, record.repo);
      return send(res, 200, { path: file, log: readLogTail(file) });
    }
    if (action === 'open-log' && method === 'POST') {
      const file = store.jobLogFile(record.owner, record.repo);
      try {
        return send(res, 200, await openLogTerminal(file));
      } catch (err) {
        return fail(res, 400, err.message, { path: file });
      }
    }
    if (action === 'file' && method === 'GET') {
      if (!record.repoDir || !fs.existsSync(record.repoDir)) {
        return fail(res, 404, 'Repository files are not available locally');
      }
      const rawRel = String(url.searchParams.get('path') || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rawRel || rawRel.includes('\0')) return fail(res, 400, 'Missing file path');
      const isBlockedRel = relPath => relPath.split('/').some(seg => seg === '.git') || isSensitiveName(path.basename(relPath));
      if (isBlockedRel(rawRel)) {
        return fail(res, 403, 'Sensitive files cannot be previewed');
      }
      let repoRoot; let realTarget;
      try {
        repoRoot = fs.realpathSync(record.repoDir);
        const candidate = path.resolve(repoRoot, rawRel);
        realTarget = fs.realpathSync(candidate);
      } catch {
        return fail(res, 404, 'File not found');
      }
      if (realTarget !== repoRoot && !realTarget.startsWith(`${repoRoot}${path.sep}`)) {
        return fail(res, 403, 'Path outside repository');
      }
      const relFromRoot = path.relative(repoRoot, realTarget).split(path.sep).join('/');
      if (isBlockedRel(relFromRoot)) {
        return fail(res, 403, 'Sensitive files cannot be previewed');
      }
      const st = fs.statSync(realTarget);
      if (!st.isFile()) return fail(res, 400, 'Not a file');
      if (st.size > 300 * 1024) return fail(res, 413, 'File too large to preview (>300 KB)');
      const content = fs.readFileSync(realTarget, 'utf8');
      if (content.slice(0, 4000).includes('\u0000')) return fail(res, 415, 'Binary file cannot be previewed');
      const rel = path.relative(repoRoot, realTarget).split(path.sep).join('/');
      return send(res, 200, { path: rel, totalLines: content.split('\n').length, content });
    }
    if (action === 'edit' && method === 'POST') {
      const body = await readBody(req);
      const settings = store.loadSettings();
      if (!['modify', 'supplement', 'rewrite'].includes(body.op)) return fail(res, 400, 'Unknown operation');
      if (!String(body.instruction || '').trim()) return fail(res, 400, 'Describe the change');
      const editModel = (body.model && settings.models[body.model])
        ? body.model
        : (settings.default && settings.models[settings.default] ? settings.default : record.model);
      const job = jobs.enqueue({ kind: 'edit', owner: record.owner, repo: record.repo, model: editModel, page: String(body.path || ''), op: body.op, instruction: String(body.instruction).slice(0, 4000) });
      const emit = sse(res);
      await new Promise(resolve => {
        const listener = e => {
          if (e.type === 'job_done') { emit('done', {}); resolve(); }
          else if (e.type === 'job_error') { emit('error', { message: e.message }); resolve(); }
          else emit('event', e);
        };
        job.listeners.add(listener);
        res.on('close', () => { job.listeners.delete(listener); resolve(); });
      });
      return res.end();
    }
  }

  if (route[0] === 'jobs' && route[1]) {
    const job = jobs.jobs.get(route[1]);
    if (!job) return fail(res, 404, 'Unknown job');
    if (route[2] === 'cancel' && method === 'POST') { jobs.cancel(job.id); return send(res, 200, { ok: true }); }
    if (route[2] === 'pause' && method === 'POST') { jobs.pause(job.id); return send(res, 200, { ok: true }); }
    if (route[2] === 'log' && method === 'GET') {
      const file = job.logFile || store.jobLogFile(job.owner, job.repo);
      return send(res, 200, { path: file, log: readLogTail(file) });
    }
    if (route[2] === 'open-log' && method === 'POST') {
      const file = job.logFile || store.jobLogFile(job.owner, job.repo);
      try {
        return send(res, 200, await openLogTerminal(file));
      } catch (err) {
        return fail(res, 400, err.message, { path: file });
      }
    }
    if (route[2] === 'events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      const write = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
      for (const e of job.events) write(e);
      if (job.progress) write(job.progress);
      if (job.status === 'done' || job.status === 'failed' || job.status === 'paused') return res.end();
      const listener = e => { write(e); if (e.type === 'job_done' || e.type === 'job_error' || e.type === 'job_paused') res.end(); };
      job.listeners.add(listener);
      const keep = setInterval(() => res.write(': ping\n\n'), 15000);
      res.on('close', () => { job.listeners.delete(listener); clearInterval(keep); });
      return undefined;
    }
  }

  if (route[0] === 'chat' && method === 'POST') {
    const body = await readBody(req);
    const emit = sse(res);
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    try {
      await rag.answer({
        owner: String(body.owner || ''), repo: String(body.repo || ''), question: String(body.question || '').slice(0, 4000),
        history: Array.isArray(body.history) ? body.history.slice(-4) : [], mode: body.mode, modelName: body.model,
        pages: Array.isArray(body.pages) ? body.pages : null, emit, signal: controller.signal,
        attachments: (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 5)
          .map(a => ({ name: String(a.name || 'file').replace(/[^\w.@/-]+/g, '_').slice(0, 120), text: String(a.text || '').slice(0, 40000) })),
      });
    } catch (err) {
      if (!controller.signal.aborted) emit('error', { message: err.message });
    }
    return res.end();
  }

  if (route[0] === 'export' && route[1] === 'pdf' && method === 'POST') {
    const body = await readBody(req);
    try {
      const pdf = await printPdf({ port: PORT, owner: String(body.owner), repo: String(body.repo), paper: body.paper === 'Letter' ? 'Letter' : 'A4', page: body.page ? String(body.page) : undefined, sessionToken: SESSION_TOKEN });
      return send(res, 200, Buffer.from(pdf), { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${store.safePart(body.owner)}-${store.safePart(body.repo)}.pdf"` });
    } catch (err) { return fail(res, err.code === 'no_browser' ? 501 : 500, err.message, { code: err.code }); }
  }

  if (route[0] === 'export' && route[1] === 'html' && method === 'POST') {
    const body = await readBody(req);
    const w = body.wiki || {};
    const fmt = body.format || 'single';
    if (fmt === 'single') {
      const html = await exportSingleHtml({ port: PORT, wiki: w, sessionToken: SESSION_TOKEN });
      const filename = `${store.safePart(w.owner)}-${store.safePart(w.repo)}-docs.html`;
      if (body.folder) {
        const folder = path.resolve(String(body.folder).replace(/^~(?=\/|$)/, os.homedir()));
        if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) {
          return fail(res, 400, 'Refusing to export into a symbolic link folder.');
        }
        fs.mkdirSync(folder, { recursive: true });
        const dest = path.join(folder, filename);
        try {
          if (fs.lstatSync(dest).isSymbolicLink()) {
            return fail(res, 400, 'Refusing to overwrite a symbolic link target file.');
          }
        } catch { /* dest does not exist yet */ }
        fs.writeFileSync(dest, html, 'utf8');
        return send(res, 200, { file: dest, folder });
      }
      return send(res, 200, Buffer.from(html, 'utf8'), {
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      });
    }
    if (fmt === 'folder') {
      const folder = body.folder ? path.resolve(String(body.folder).replace(/^~(?=\/|$)/, os.homedir())) : path.join(store.HOME, 'exports', `${store.safePart(w.owner)}-${store.safePart(w.repo)}`);
      if (fs.existsSync(folder) && fs.lstatSync(folder).isSymbolicLink()) {
        return fail(res, 400, 'Refusing to export into a symbolic link folder.');
      }
      if (fs.existsSync(folder) && fs.readdirSync(folder).length && !fs.existsSync(path.join(folder, 'wiki-data.js'))) {
        return fail(res, 400, 'That folder already has other files in it. Choose an empty folder.');
      }
      const r = exportSite(w, folder);
      return send(res, 200, { folder: r.dir, pages: r.pages });
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repowiki-export-'));
    try {
      exportSite(w, path.join(tmp, 'site'));
      const zip = zipDir(path.join(tmp, 'site'));
      return send(res, 200, zip, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${store.safePart(w.owner)}-${store.safePart(w.repo)}-site.zip"` });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  if (route[0] === 'publish' && method === 'POST') {
    const body = await readBody(req);
    const emit = sse(res);
    const settings = store.loadSettings();
    const target = { ...(body.target || {}) };
    const saved = settings.publish || {};
    if (!target.token && saved.token && target.hasToken && store.samePublishDestination(saved, target)) target.token = saved.token;
    delete target.hasToken;
    settings.publish = { ...target };
    store.saveSettings(settings);
    try {
      const r = await publish(body.wiki || {}, target, message => emit('log', { message }));
      emit('done', r);
    } catch (err) { emit('error', { message: err.message }); }
    return res.end();
  }

  return fail(res, 404, 'Not found');
}

function pickFolder() {
  return new Promise((resolve, reject) => {
    let cmd; let args;
    if (process.platform === 'darwin') { cmd = 'osascript'; args = ['-e', 'POSIX path of (choose folder with prompt "Choose the project folder")']; }
    else if (process.platform === 'win32') {
      cmd = 'powershell'; args = ['-NoProfile', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }'];
    } else { cmd = 'zenity'; args = ['--file-selection', '--directory']; }
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('error', () => reject(new Error('No folder picker on this system: type the path instead.')));
    child.on('close', () => resolve({ path: out.trim().replace(/\/$/, '') || '' }));
  });
}

/* ---------------- static ---------------- */

const STATIC_SECURITY_HEADERS = {
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
};

const AUTH_PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Safe4wiki — Session Unlock</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0c11;color:#eef1f6;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}.card{max-width:460px;width:90%;padding:28px;border-radius:14px;border:1px solid rgba(226,188,108,.25);background:#12151e}h1{margin:0 0 8px;font-size:20px;color:#f2d896}p{margin:0 0 16px;font-size:14px;line-height:1.5;color:#9da7ba}code{color:#e8cc8a;font-size:12.5px}form{display:flex;gap:8px}input{flex:1;padding:10px 12px;border-radius:8px;border:1px solid #2b3244;background:#0b0e15;color:#fff;font-family:ui-monospace,Menlo,monospace;font-size:13px}button{padding:10px 16px;border-radius:8px;border:0;background:#d8ae58;color:#0b0e15;font-weight:700;cursor:pointer}</style></head><body><div class="card"><h1>Safe4wiki Local Session</h1><p>Open the launch link printed in your terminal, or paste the local session token from <code>~/.repowiki/.session-token</code>:</p><form method="GET" action="/"><input name="token" type="password" placeholder="Paste 64-char session token" autocomplete="off" required><button type="submit">Unlock</button></form></div></body></html>`;

function serveStatic(req, res, url) {
  // Exchange one-time ?token=<SESSION_TOKEN> on loopback navigation for an HttpOnly SameSite=Strict cookie
  // and immediately redirect to strip the token from the URL bar and browser history.
  const qToken = url.searchParams.get('token');
  const site = req.headers['sec-fetch-site'];
  if (qToken && isLoopbackHost(req) && site !== 'cross-site' && site !== 'same-site' && validSessionToken(qToken)) {
    const cleanParams = new URLSearchParams(url.searchParams);
    cleanParams.delete('token');
    const cleanPath = `${url.pathname}${cleanParams.toString() ? '?' + cleanParams.toString() : ''}`;
    res.writeHead(302, {
      ...STATIC_SECURITY_HEADERS,
      'set-cookie': `${SESSION_COOKIE}=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
      location: cleanPath.startsWith('/') && !cleanPath.startsWith('//') ? cleanPath : '/',
      'cache-control': 'no-store',
    });
    return res.end();
  }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return fail(res, 400, 'Malformed URL'); }
  const file = path.resolve(DIST, `.${rel}`);
  if (file !== DIST && !file.startsWith(`${DIST}${path.sep}`)) return fail(res, 403, 'Forbidden');
  let target = file;
  try {
    const st = fs.statSync(target);
    if (st.isDirectory()) target = path.join(target, 'index.html');
  } catch { target = null; }
  if (!target || !fs.existsSync(target)) {
    const ext = path.extname(rel).toLowerCase();
    if (rel.startsWith('/assets/') || (ext && MIME[ext])) return fail(res, 404, 'Not found');
    target = path.join(DIST, 'index.html');
  }
  if (!fs.existsSync(target)) return send(res, 500, 'The app is not built yet. Run: npm run build');
  try {
    const realDist = fs.realpathSync(DIST);
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realDist && !realTarget.startsWith(`${realDist}${path.sep}`)) {
      return fail(res, 403, 'Forbidden');
    }
    target = realTarget;
  } catch { return fail(res, 404, 'Not found'); }
  const ext = path.extname(target);
  if (ext === '.html' && !hasValidSession(req)) {
    res.writeHead(200, { ...STATIC_SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(AUTH_PAGE_HTML);
  }
  const headers = {
    ...STATIC_SECURITY_HEADERS,
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': target.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
  rel = null;
  return undefined;
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); } catch { return fail(res, 400, 'Malformed URL'); }
  if (url.pathname.startsWith('/api/')) {
    if (!allowed(req, url)) return fail(res, 403, 'Safe4wiki only accepts authenticated requests from this computer.');
    try { return await api(req, res, url); } catch (err) {
      if (!res.headersSent) return fail(res, 500, err.message);
      try { res.end(); } catch { /* ignore */ }
      return undefined;
    }
  }
  return serveStatic(req, res, url);
});

store.ensureDir(store.HOME);
jobs.recoverInterrupted();
server.listen(PORT, '127.0.0.1', () => {
  const link = `http://localhost:${PORT}/?token=${SESSION_TOKEN}`;
  console.log(`Safe4wiki is running at ${link}\nData folder: ${store.HOME}\nPress Ctrl+C to stop.`);
  if (!process.env.REPOWIKI_NO_OPEN && process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [link], { stdio: 'ignore', detached: true }).unref();
  }
});

'use strict';
/**
 * RepoWiki local server. Serves the built app (dist/) and the /api used by it.
 * Listens on 127.0.0.1 only and refuses requests from other sites, because it
 * can read folders, run model backends and agent CLIs, and publish.
 *
 *   npm run build   (once)
 *   npm start       -> http://localhost:4317
 */
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
const { chatDetailed, resolveApiKey } = require('./engine/providers');
const { hostOf } = require('./git');

const PORT = Number(process.env.PORT || 4317);
const DIST = path.join(__dirname, '..', 'dist');
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

/** Only this computer, and only pages served by this server. */
function allowed(req) {
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return origin === new URL(`http://${host}`).origin; } catch { return false; }
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
    job: job || (effectiveStatus === 'failed' ? { id: null, status: 'failed', error: record.error } : null),
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

function openLogTerminal(logFile) {
  store.ensureDir(path.dirname(logFile));
  if (!fs.existsSync(logFile)) fs.writeFileSync(logFile, 'Waiting for log output…\n');
  const sq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const tailCmd = `clear; echo "=== Safe4wiki Live Log ==="; tail -n 100 -f ${sq(logFile)}`;
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      const asStr = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      const script = [
        'tell application "Terminal"',
        '  activate',
        `  do script ${asStr(tailCmd)}`,
        'end tell',
      ].join('\n');
      const child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.on('error', e => reject(new Error(`Could not open Terminal: ${e.message}`)));
      child.on('close', code => (code === 0 ? resolve({ ok: true, path: logFile }) : reject(new Error(err.trim() || `osascript exited with ${code}`))));
      return;
    }
    reject(new Error(`Run in your terminal: tail -f ${sq(logFile)}`));
  });
}

/* ---------------- routes ---------------- */

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
  const method = req.method;
  const route = parts.slice(1);

  if (route[0] === 'health') return send(res, 200, { app: 'safe4wiki', version: 1, dataDir: store.HOME });

  if (route[0] === 'settings' && route.length === 1) {
    if (method === 'GET') return send(res, 200, store.publicSettings(store.loadSettings()));
    if (method === 'PUT') {
      const next = store.mergeSettings(store.loadSettings(), await readBody(req));
      store.saveSettings(next);
      return send(res, 200, store.publicSettings(next));
    }
  }

  if (route[0] === 'models' && method === 'POST') {
    const body = await readBody(req);
    const settings = store.loadSettings();
    const saved = settings.models[body.name] || {};
    const profile = { ...saved, ...(body.profile || {}) };
    if (!profile.apiKey && saved.apiKey) profile.apiKey = saved.apiKey;
    delete profile.hasKey;
    if (route[1] === 'test') {
      const started = Date.now();
      try {
        const r = await chatDetailed({ ...profile, cwd: os.tmpdir() }, [{ role: 'user', content: 'Reply with exactly one word: ready' }], { retries: 0, maxTokens: 64, timeoutMs: 120000, cwd: os.tmpdir() });
        const reply = String(r.content || '').trim();
        if (!/\bready\b/i.test(reply) && reply.length > 40) {
          return fail(res, 400, `Model did not follow the test prompt (check CLI arguments / stdin). Replied: “${reply.slice(0, 180)}”`);
        }
        return send(res, 200, { ok: true, reply: reply.slice(0, 200), ms: Date.now() - started });
      } catch (err) { return fail(res, 400, err.message.slice(0, 500)); }
    }
    if (route[1] === 'list') {
      try {
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
        if (!/^(https:\/\/|http:\/\/|git@|ssh:\/\/)[^\s]+$/.test(u)) return fail(res, 400, 'Enter a Git address (https://… or git@…)');
        if (src.branch && !/^[A-Za-z0-9._/-]+$/.test(src.branch)) return fail(res, 400, 'Invalid branch name');
        source = { type: 'git', url: u.replace(/^https:\/\/[^@/]+@/, 'https://'), branch: src.branch || undefined };
        if (src.token) { settings.gitTokens[hostOf(u)] = String(src.token); store.saveSettings(settings); }
      } else return fail(res, 400, 'Choose a folder or a Git repository');

      const model = body.model && settings.models[body.model] ? body.model : settings.default;
      if (!settings.models[model]) return fail(res, 400, 'Add a model first in Model settings.');

      let [owner, repo] = nameFromSource(source);
      if (body.name && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(body.name)) [owner, repo] = body.name.split('/');
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
      const job = jobs.enqueue({ kind: 'generate', owner: record.owner, repo: record.repo, model, force: !!body.force });
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
      const baseName = path.basename(rawRel).toLowerCase();
      if ((baseName === '.env' || (baseName.startsWith('.env.') && !/example|sample|template/.test(baseName)))
        || /\.(pem|key|p12|pfx)$/.test(baseName) || /^id_(rsa|ed25519|ecdsa)/.test(baseName)) {
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
      if (job.status === 'done' || job.status === 'failed') return res.end();
      const listener = e => { write(e); if (e.type === 'job_done' || e.type === 'job_error') res.end(); };
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
      const pdf = await printPdf({ port: PORT, owner: String(body.owner), repo: String(body.repo), paper: body.paper === 'Letter' ? 'Letter' : 'A4', page: body.page ? String(body.page) : undefined });
      return send(res, 200, Buffer.from(pdf), { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${store.safePart(body.owner)}-${store.safePart(body.repo)}.pdf"` });
    } catch (err) { return fail(res, err.code === 'no_browser' ? 501 : 500, err.message, { code: err.code }); }
  }

  if (route[0] === 'export' && route[1] === 'html' && method === 'POST') {
    const body = await readBody(req);
    const w = body.wiki || {};
    const fmt = body.format || 'single';
    if (fmt === 'single') {
      const html = await exportSingleHtml({ port: PORT, wiki: w });
      const filename = `${store.safePart(w.owner)}-${store.safePart(w.repo)}-docs.html`;
      if (body.folder) {
        const folder = path.resolve(String(body.folder).replace(/^~(?=\/|$)/, os.homedir()));
        fs.mkdirSync(folder, { recursive: true });
        const dest = path.join(folder, filename);
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
    if (!target.token && saved.token && target.hasToken) target.token = saved.token;
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

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  const file = path.resolve(DIST, `.${rel}`);
  if (!file.startsWith(DIST)) return fail(res, 403, 'Forbidden');
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
  const ext = path.extname(target);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': target.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
  rel = null;
  return undefined;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    if (!allowed(req)) return fail(res, 403, 'Safe4wiki only accepts requests from this computer.');
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
  const link = `http://localhost:${PORT}`;
  console.log(`Safe4wiki is running at ${link}\nData folder: ${store.HOME}\nPress Ctrl+C to stop.`);
  if (!process.env.REPOWIKI_NO_OPEN && process.argv.includes('--open')) {
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    spawn(opener, [link], { stdio: 'ignore', detached: true }).unref();
  }
});

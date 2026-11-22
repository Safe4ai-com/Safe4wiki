'use strict';
/**
 * Generation and page-edit jobs. One engine run at a time (local models share
 * one GPU); the rest wait in a queue. Every event is kept so a page opened
 * later can replay the progress.
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { cloneOrUpdate, headCommit, hostOf } = require('./git');

const jobs = new Map();
const queue = [];
let running = null;

function newJob(fields) {
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    status: 'queued',
    events: [],
    listeners: new Set(),
    createdAt: new Date().toISOString(),
    startedAt: null,
    progress: null,
    lastProgressLogAt: 0,
    logFile: fields.owner && fields.repo ? store.jobLogFile(fields.owner, fields.repo) : null,
    ...fields,
  };
  jobs.set(job.id, job);
  return job;
}

function formatLogLine(e) {
  const ts = (() => {
    try { return new Date(e.ts || Date.now()).toTimeString().slice(0, 8); } catch { return ''; }
  })();
  switch (e.type) {
    case 'job_queued': return `[${ts}] Queued (position #${e.position || 1})`;
    case 'job_started': return `[${ts}] Job started`;
    case 'clone_started': return `[${ts}] Cloning ${e.url}…`;
    case 'clone_done': return `[${ts}] Cloned (${e.commit || 'HEAD'})`;
    case 'run_started': return `[${ts}] Model: ${e.model} (${e.provider}${e.modelId ? ` · ${e.modelId}` : ''})`;
    case 'scan_started': return `[${ts}] Scanning repository…`;
    case 'scan_done': return `[${ts}] Scanned ${e.files} files`;
    case 'plan_started': return `[${ts}] Planning wiki pages…`;
    case 'plan_retry': return `[${ts}] Plan retry #${e.attempt || ''}: ${e.codes || ''}`;
    case 'plan_ready': return `[${ts}] Plan ready: ${(e.pages || []).length} pages`;
    case 'page_start': return `[${ts}] Writing ${e.path}…`;
    case 'page_retry': return `[${ts}] Retrying ${e.path} (attempt ${e.attempt || ''}): ${e.codes || ''}`;
    case 'page_done': return `[${ts}] ${e.status === 'generated' ? 'Wrote' : e.status === 'skipped' ? 'Unchanged' : 'Saved'} ${e.path}${e.chars ? ` (${e.chars} chars)` : ''}`;
    case 'page_fail': return `[${ts}] FAILED ${e.path}: ${e.message}`;
    case 'page_note': return `[${ts}] Note (${e.path}): ${e.message}`;
    case 'model_progress':
      return e.phase === 'reading_prompt'
        ? `[${ts}] Model reading prompt…`
        : e.phase === 'thinking'
          ? `[${ts}] Thinking… ${e.tokens || 0} tokens${e.tokPerSec ? ` (${e.tokPerSec} tok/s)` : ''} · ${Math.round((e.elapsedMs || 0) / 1000)}s`
          : `[${ts}] Generating… ${e.tokens || 0} tokens${e.tokPerSec ? ` (${e.tokPerSec} tok/s)` : ''} · ${Math.round((e.elapsedMs || 0) / 1000)}s`;
    case 'run_note': return `[${ts}] ${e.message}`;
    case 'run_finished': return `[${ts}] Finished generation.`;
    case 'job_done': return `[${ts}] Job done.`;
    case 'job_error': return `[${ts}] ERROR: ${e.message}`;
    case 'log': return `[${ts}] ${e.message}`;
    default: return e.message ? `[${ts}] ${e.message}` : null;
  }
}

function appendLog(job, line) {
  if (!job.logFile || !line) return;
  try {
    store.ensureDir(path.dirname(job.logFile));
    fs.appendFileSync(job.logFile, `${line}\n`);
  } catch { /* ignore */ }
}

function push(job, event) {
  const e = { ts: new Date().toISOString(), ...event };
  if (e.type === 'model_progress') {
    job.progress = e;
    const now = Date.now();
    if (now - (job.lastProgressLogAt || 0) >= 8000 || e.phase === 'reading_prompt') {
      job.lastProgressLogAt = now;
      appendLog(job, formatLogLine(e));
    }
    for (const l of job.listeners) { try { l(e); } catch { /* ignore */ } }
    return;
  }
  if (e.type === 'page_start' || e.type === 'page_done' || e.type === 'page_fail' || e.type === 'job_done' || e.type === 'job_error') {
    job.progress = null;
  }
  job.events.push(e);
  if (job.events.length > 2000) job.events.splice(0, job.events.length - 2000);
  appendLog(job, formatLogLine(e));
  for (const l of job.listeners) { try { l(e); } catch { /* ignore */ } }
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    model: job.model,
    error: job.error || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    progress: job.progress || null,
    logFile: job.logFile || null,
  };
}

/** Writes the engine config for one run: only the chosen profile, with its key. */
function writeRunConfig(record, settings, modelName, repoDir) {
  const profile = { ...(settings.models[modelName] || {}) };
  if (!settings.models[modelName]) throw new Error(`Model profile “${modelName}” does not exist any more.`);
  if (profile.provider === 'agent-cli') profile.cwd = repoDir;
  const config = {
    default: modelName,
    language: record.language || settings.language || 'en',
    maxPages: record.maxPages || settings.maxPages || 'auto',
    template: settings.template || 'standard',
    models: { [modelName]: profile },
  };
  const file = path.join(store.wikiDir(record.owner, record.repo), `.run-config-${process.pid}.json`);
  store.writeJson(file, config, 0o600);
  return file;
}

function runWorker(job, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'worker.js'), JSON.stringify(payload)], {
      cwd: payload.repoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    job.child = child;
    let buf = '';
    let failure = null;
    child.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { e = { type: 'log', message: line }; }
        if (e.type === 'worker_error') failure = e.message;
        else if (e.type !== 'worker_done') push(job, e);
      }
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });
    child.on('close', code => {
      job.child = null;
      if (job.cancelled) reject(new Error('Stopped.'));
      else if (code === 0) resolve();
      else reject(new Error(failure || stderr.trim().split('\n').pop() || `engine exited with ${code}`));
    });
  });
}

async function prepareSource(job, record, settings) {
  const src = record.source;
  if (src.type === 'local') {
    if (!fs.existsSync(src.path) || !fs.statSync(src.path).isDirectory()) throw new Error(`Folder not found: ${src.path}`);
    record.repoDir = fs.realpathSync(src.path);
    const head = await headCommit(record.repoDir);
    record.commit = head.short; record.commitFull = head.full;
    return;
  }
  const dir = store.repoCloneDir(record.owner, record.repo);
  const token = job.token || settings.gitTokens[hostOf(src.url)] || '';
  push(job, { type: 'clone_started', url: src.url });
  const head = await cloneOrUpdate({ url: src.url, branch: src.branch, token, dir, onLine: line => push(job, { type: 'log', message: line }) });
  record.repoDir = dir;
  record.commit = head.short; record.commitFull = head.full;
  push(job, { type: 'clone_done', commit: head.short });
}

function readDescription(repoDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
    if (pkg.description) return String(pkg.description).slice(0, 240);
  } catch { /* ignore */ }
  for (const name of ['README.md', 'readme.md', 'README']) {
    try {
      const text = fs.readFileSync(path.join(repoDir, name), 'utf8');
      const para = text.split(/\n\s*\n/).map(s => s.trim()).find(s => s && !s.startsWith('#') && !s.startsWith('<') && !s.startsWith('[!') && !s.startsWith('!['));
      if (para) return para.replace(/\s+/g, ' ').replace(/[*_`]/g, '').slice(0, 240);
    } catch { /* ignore */ }
  }
  return '';
}

async function execute(job) {
  const settings = store.loadSettings();
  const record = store.findWikiRecord(job.owner, job.repo);
  if (!record) throw new Error('Wiki record missing');
  job.startedAt = new Date().toISOString();
  if (job.logFile) {
    try {
      store.ensureDir(path.dirname(job.logFile));
      fs.writeFileSync(job.logFile, `=== Safe4wiki ${job.kind} job ${job.id} (${job.owner}/${job.repo}) · ${job.startedAt} ===\n`);
    } catch { /* ignore */ }
  }
  record.status = 'generating';
  record.jobId = job.id;
  record.error = null;
  store.saveWikiRecord(record);
  let configFile = null;
  try {
    await prepareSource(job, record, settings);
    if (!record.description) record.description = readDescription(record.repoDir);
    store.saveWikiRecord(record);
    if (job.cancelled) throw new Error('Stopped.');
    configFile = writeRunConfig(record, settings, job.model, record.repoDir);
    const out = store.contentDir(record);
    await runWorker(job, {
      kind: job.kind,
      repoDir: record.repoDir,
      config: configFile,
      model: job.model,
      out,
      force: !!job.force,
      page: job.page,
      op: job.op,
      instruction: job.instruction,
    });
    record.status = 'ready';
    record.model = job.model;
    if (job.kind !== 'edit') record.lastIndexed = new Date().toISOString();
    store.saveWikiRecord(record);
    try { require('./rag').prewarm(record); } catch { /* ignore */ }
  } catch (err) {
    const partial = job.kind !== 'edit' ? store.promotePartialStage(record) : { promoted: 0, total: 0 };
    if (partial.promoted > 0) {
      record.model = job.model;
      record.lastIndexed = new Date().toISOString();
      push(job, { type: 'run_note', message: `Saved ${partial.promoted} generated page(s) before stopping (${partial.total} total available).` });
    }
    record.status = 'failed';
    record.error = err.message;
    store.saveWikiRecord(record);
    throw err;
  } finally {
    if (configFile) { try { fs.unlinkSync(configFile); } catch { /* ignore */ } }
  }
}

function pump() {
  if (running || !queue.length) return;
  const job = queue.shift();
  running = job;
  job.status = 'running';
  push(job, { type: 'job_started' });
  execute(job)
    .then(() => { job.status = 'done'; push(job, { type: 'job_done' }); })
    .catch(err => { job.status = 'failed'; job.error = err.message; push(job, { type: 'job_error', message: err.message }); })
    .finally(() => {
      running = null;
      require('./rag').invalidate(job.owner, job.repo);
      setImmediate(pump);
    });
}

function findActiveJob(owner, repo, kind = 'generate') {
  const key = `${owner}/${repo}`.toLowerCase();
  if (running && running.kind === kind && `${running.owner}/${running.repo}`.toLowerCase() === key) return running;
  return queue.find(j => j.kind === kind && `${j.owner}/${j.repo}`.toLowerCase() === key) || null;
}

function enqueue(fields) {
  if (fields.kind !== 'edit') {
    const active = findActiveJob(fields.owner, fields.repo, fields.kind || 'generate');
    if (active) return active;
  }
  const job = newJob(fields);
  queue.push(job);
  const record = store.findWikiRecord(job.owner, job.repo);
  if (record && job.kind !== 'edit') {
    record.status = record.status === 'ready' ? 'ready' : 'queued';
    record.jobId = job.id;
    store.saveWikiRecord(record);
  }
  push(job, { type: 'job_queued', position: queue.length });
  setImmediate(pump);
  return job;
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;
  const targets = [job];
  const sameRunning = running && running.id !== job.id && running.owner === job.owner && running.repo === job.repo ? running : null;
  if (sameRunning) targets.push(sameRunning);
  for (const target of targets) {
    target.cancelled = true;
    const qi = queue.indexOf(target);
    if (qi >= 0) {
      queue.splice(qi, 1);
      target.status = 'failed';
      target.error = 'Stopped.';
      push(target, { type: 'job_error', message: 'Stopped.' });
      if (!sameRunning) {
        const record = store.findWikiRecord(target.owner, target.repo);
        if (record) {
          store.promotePartialStage(record);
          record.status = 'failed';
          record.error = 'Stopped.';
          store.saveWikiRecord(record);
        }
      }
    }
    if (target.child) target.child.kill('SIGTERM');
  }
  return true;
}

/** Wikis left "generating" by a previous server run can't still be running. */
function recoverInterrupted() {
  for (const r of store.listWikiRecords()) {
    const partial = store.promotePartialStage(r);
    if (r.status === 'generating' || r.status === 'queued') {
      r.status = 'failed';
      r.error = partial.promoted > 0
        ? `The app was closed while this wiki was being written (${partial.promoted} generated page(s) saved). Press “Continue generating” to finish.`
        : 'The app was closed while this wiki was being written. Press “Try again”.';
      if (partial.promoted > 0 && !r.lastIndexed) r.lastIndexed = new Date().toISOString();
      store.saveWikiRecord(r);
    } else if (partial.promoted > 0) {
      if (!r.lastIndexed) r.lastIndexed = new Date().toISOString();
      store.saveWikiRecord(r);
    }
  }
}

module.exports = { jobs, enqueue, cancel, publicJob, recoverInterrupted, push, findActiveJob };

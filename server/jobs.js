'use strict';
/**
 * Generation and page-edit jobs.
 * Local GPU models (Ollama, llama.cpp, localhost servers) share one GPU slot so
 * they never thrash VRAM, while cloud APIs and Agent CLIs run in parallel across
 * different repositories (never two jobs on the same repo at once).
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { cloneOrUpdate, headCommit, hostOf } = require('./git');

const MAX_PARALLEL_JOBS = 4;
const jobs = new Map();
const queue = [];
const running = new Set();

function jobSlotKey(job, settings) {
  const models = settings?.models || {};
  const profile = models[job.model] || models[settings?.default] || null;
  if (!profile) return 'local-gpu';
  if (profile.provider === 'ollama' || profile.provider === 'llamacpp') return 'local-gpu';
  if ((profile.provider === 'openai' || profile.provider === 'anthropic')
    && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(String(profile.baseUrl || ''))) {
    return 'local-gpu';
  }
  return null;
}

function repoKey(job) {
  return `${job.owner || ''}/${job.repo || ''}`.toLowerCase();
}

function canStartJob(job, activeJobs, settings, maxParallel = MAX_PARALLEL_JOBS) {
  const active = Array.isArray(activeJobs) ? activeJobs : [...activeJobs];
  if (active.length >= maxParallel) return false;
  const rk = repoKey(job);
  if (active.some(a => repoKey(a) === rk)) return false;
  const slot = jobSlotKey(job, settings);
  if (slot && active.some(a => jobSlotKey(a, settings) === slot)) return false;
  return true;
}

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

function formatGeneratedBy(modelName, profile) {
  if (!profile) return String(modelName || '');
  const eff = profile.reasoningEffort ? ` · ${profile.reasoningEffort}` : '';
  if (profile.provider === 'agent-cli') {
    const cmd = String(profile.command || modelName || '').trim();
    const m = String(profile.model || '').trim();
    if (m) {
      const shortM = m.includes('/') ? m.split('/').pop() : m;
      return `${shortM} (${cmd}${eff})`;
    }
    return `${modelName || cmd} (${cmd}${eff})`;
  }
  if (profile.provider === 'llamacpp') {
    const f = String(profile.modelPath || '').split('/').pop() || modelName;
    return `${f} (GGUF)`;
  }
  const m = String(profile.model || modelName || '').trim();
  const prov = profile.provider === 'ollama' ? 'Ollama' : profile.provider === 'anthropic' ? 'Anthropic' : 'API';
  return m ? `${m} (${prov})` : String(modelName || '');
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
    let failureCode = '';
    child.stdout.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { e = { type: 'log', message: line }; }
        if (e.type === 'worker_error') { failure = e.message; failureCode = e.code || ''; }
        else if (e.type !== 'worker_done') push(job, e);
      }
    });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });
    child.on('close', code => {
      job.child = null;
      if (job.paused) {
        const err = new Error('Paused. All completed pages were saved.');
        err.code = 'paused';
        reject(err);
      } else if (job.cancelled) {
        reject(new Error('Stopped.'));
      } else if (code === 0) {
        resolve();
      } else {
        const err = new Error(failure || stderr.trim().split('\n').pop() || `engine exited with ${code}`);
        if (failureCode) err.code = failureCode;
        reject(err);
      }
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
  const isEdit = job.kind === 'edit';
  if (!isEdit) {
    record.status = 'generating';
    record.jobId = job.id;
    record.error = null;
    store.saveWikiRecord(record);
  }
  let configFile = null;
  try {
    await prepareSource(job, record, settings);
    if (!record.description) record.description = readDescription(record.repoDir);
    if (!isEdit && !job.deleted) store.saveWikiRecord(record);
    if (job.deleted) throw new Error('Deleted.');
    if (job.paused) { const e = new Error('Paused.'); e.code = 'paused'; throw e; }
    if (job.cancelled) throw new Error('Stopped.');
    const modelLabel = formatGeneratedBy(job.model, settings.models?.[job.model]);
    configFile = writeRunConfig(record, settings, job.model, record.repoDir);
    const out = store.contentDir(record);
    await runWorker(job, {
      kind: job.kind,
      repoDir: record.repoDir,
      config: configFile,
      model: job.model,
      out,
      force: !!job.force,
      resume: !!job.resume,
      page: job.page,
      op: job.op,
      instruction: job.instruction,
    });
    if (job.deleted) return;
    if (!isEdit) {
      record.status = 'ready';
      record.model = job.model;
      record.generatedBy = modelLabel;
      delete record.plannedPages;
      record.lastIndexed = new Date().toISOString();
      store.saveWikiRecord(record);
    }
    try {
      const rag = require('./rag');
      rag.invalidate(job.owner, job.repo);
      rag.prewarm(record);
    } catch { /* ignore */ }
  } catch (err) {
    if (job.deleted) throw err;
    if (isEdit) throw err;
    const isPaused = !!(job.paused || err.code === 'paused');
    const modelLabel = formatGeneratedBy(job.model, settings.models?.[job.model]);
    record.generatedBy = record.generatedBy || modelLabel;
    const partial = store.promotePartialStage(record);
    if (partial.promoted > 0) {
      record.model = job.model;
      record.generatedBy = modelLabel;
      record.lastIndexed = new Date().toISOString();
      push(job, { type: 'run_note', message: `Saved ${partial.promoted} generated page(s) (${partial.total}${partial.planned ? ` / ${partial.planned}` : ''} total saved).` });
    }
    if (partial.planned > 0) record.plannedPages = partial.planned;
    record.status = isPaused ? 'paused' : 'failed';
    record.error = err.message;
    store.saveWikiRecord(record);
    throw err;
  } finally {
    if (configFile) { try { fs.unlinkSync(configFile); } catch { /* ignore */ } }
  }
}

function pump() {
  if (!queue.length) return;
  const settings = store.loadSettings();
  let i = 0;
  while (i < queue.length && running.size < MAX_PARALLEL_JOBS) {
    const job = queue[i];
    if (!canStartJob(job, running, settings, MAX_PARALLEL_JOBS)) {
      i++;
      continue;
    }
    queue.splice(i, 1);
    running.add(job);
    job.status = 'running';
    push(job, { type: 'job_started' });
    execute(job)
      .then(() => { job.status = 'done'; push(job, { type: 'job_done' }); })
      .catch(err => {
        const isPaused = !!(job.paused || err.code === 'paused');
        job.status = isPaused ? 'paused' : 'failed';
        job.error = err.message;
        push(job, { type: isPaused ? 'job_paused' : 'job_error', message: err.message });
        require('./rag').invalidate(job.owner, job.repo);
      })
      .finally(() => {
        running.delete(job);
        setImmediate(pump);
      });
  }
}

function findActiveJob(owner, repo, kind = 'generate') {
  const key = `${owner}/${repo}`.toLowerCase();
  for (const r of running) {
    if (r.kind === kind && repoKey(r) === key) return r;
  }
  return queue.find(j => j.kind === kind && repoKey(j) === key) || null;
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

function cancel(id, { pause = false } = {}) {
  const job = jobs.get(id);
  if (!job) return false;
  const targets = [job];
  for (const r of running) {
    if (r.id !== job.id && r.owner === job.owner && r.repo === job.repo) targets.push(r);
  }
  const hasRunningSibling = targets.length > 1;
  for (const target of targets) {
    if (pause) target.paused = true;
    target.cancelled = true;
    const qi = queue.indexOf(target);
    if (qi >= 0) {
      queue.splice(qi, 1);
      target.status = pause ? 'paused' : 'failed';
      target.error = pause ? 'Paused.' : 'Stopped.';
      push(target, { type: pause ? 'job_paused' : 'job_error', message: target.error });
      if (!hasRunningSibling) {
        const record = store.findWikiRecord(target.owner, target.repo);
        if (record) {
          const partial = store.promotePartialStage(record);
          if (partial.planned > 0) record.plannedPages = partial.planned;
          record.status = pause ? 'paused' : 'failed';
          record.error = target.error;
          store.saveWikiRecord(record);
        }
      }
    }
    if (target.child) target.child.kill('SIGTERM');
  }
  return true;
}

function pause(id) {
  return cancel(id, { pause: true });
}

function cancelForDelete(owner, repo) {
  const key = `${owner}/${repo}`.toLowerCase();
  for (let i = queue.length - 1; i >= 0; i--) {
    if (repoKey(queue[i]) === key) {
      const target = queue.splice(i, 1)[0];
      target.deleted = true;
      target.cancelled = true;
      target.status = 'failed';
      target.error = 'Deleted.';
      push(target, { type: 'job_error', message: 'Deleted.' });
    }
  }
  for (const r of running) {
    if (repoKey(r) === key) {
      r.deleted = true;
      r.cancelled = true;
      if (r.child) r.child.kill('SIGTERM');
    }
  }
}

/** Wikis left "generating" by a previous server run can't still be running. */
function recoverInterrupted() {
  for (const r of store.listWikiRecords()) {
    const partial = store.promotePartialStage(r);
    if (r.status === 'generating' || r.status === 'queued') {
      if (partial.planned > 0) r.plannedPages = partial.planned;
      r.status = (partial.promoted > 0 || partial.planned > 0) ? 'paused' : 'failed';
      r.error = partial.promoted > 0
        ? `Paused when the app closed (${partial.promoted} generated page(s) saved). Click “Resume” to continue without starting over.`
        : 'The app was closed while this wiki was being written. Click “Resume” or “Try again”.';
      if (partial.promoted > 0 && !r.lastIndexed) r.lastIndexed = new Date().toISOString();
      store.saveWikiRecord(r);
    } else if (partial.promoted > 0) {
      if (!r.lastIndexed) r.lastIndexed = new Date().toISOString();
      store.saveWikiRecord(r);
    }
  }
}

module.exports = { jobs, enqueue, cancel, pause, cancelForDelete, publicJob, recoverInterrupted, push, findActiveJob, jobSlotKey, canStartJob, formatGeneratedBy };

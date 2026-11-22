'use strict';
/**
 * Runs one engine operation in its own process (so a run can be stopped and a
 * crashing model backend can't take the server down). Reads a JSON job from
 * argv[2], prints one JSON event per line on stdout.
 */
const { generateWiki, modifyWiki } = require('./engine/api');
const { setProgressHook } = require('./engine/providers');

const job = JSON.parse(process.argv[2] || '{}');
const emit = e => { try { process.stdout.write(`${JSON.stringify(e)}\n`); } catch { /* ignore */ } };
setProgressHook(info => emit({ type: 'model_progress', ...info }));

// The engine logs retries with console.warn; keep them as events.
console.warn = (...a) => emit({ type: 'log', message: a.join(' ') });
console.log = (...a) => emit({ type: 'log', message: a.join(' ') });

(async () => {
  try {
    const opts = { config: job.config, model: job.model, out: job.out, template: job.template, force: !!job.force };
    if (job.kind === 'edit') {
      await modifyWiki(job.repoDir, { ...opts, modify: job.page, op: job.op, instruction: job.instruction }, emit);
    } else {
      await generateWiki(job.repoDir, opts, emit);
    }
    emit({ type: 'worker_done' });
    process.exit(0);
  } catch (err) {
    emit({ type: 'worker_error', code: err.code || 'error', message: err.message });
    process.exit(1);
  }
})();

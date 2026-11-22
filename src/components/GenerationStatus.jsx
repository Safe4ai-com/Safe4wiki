import { useEffect, useRef, useState } from 'react';
import { api, wikiApiPath } from '../lib/api.js';
import { useApp } from '../lib/context';

/** Formats violation codes whether the engine emitted an array or a CSV string. */
function formatCodes(codes) {
  if (Array.isArray(codes)) return codes.filter(Boolean).join(', ');
  if (typeof codes === 'string') return codes.split(',').map(s => s.trim()).filter(Boolean).join(', ');
  return '';
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTime(ts) {
  if (!ts) return '';
  try { return new Date(ts).toTimeString().slice(0, 8); } catch { return ''; }
}

/** Turns engine events into one readable line each. */
export function describeEvent(e) {
  switch (e.type) {
    case 'job_queued': return e.position > 1 ? `Waiting in queue (position #${e.position})…` : 'Queued…';
    case 'job_started': return 'Starting worker…';
    case 'clone_started': return `Cloning ${e.url}…`;
    case 'clone_done': return `Cloned (${e.commit || 'latest commit'})`;
    case 'run_started': return `Using model “${e.model}” (${e.provider}${e.modelId ? ` · ${e.modelId}` : ''})`;
    case 'scan_started': return 'Scanning repository files…';
    case 'scan_done': return `Read the repository: ${e.files} files`;
    case 'plan_started': return 'Planning the wiki…';
    case 'plan_retry': {
      const detail = formatCodes(e.codes);
      return detail ? `Plan needed another try (${detail})` : 'Plan needed another try';
    }
    case 'plan_ready': return `Plan ready: ${(e.pages || []).length} pages`;
    case 'page_start': return `Writing ${e.path}…`;
    case 'page_retry': {
      const detail = formatCodes(e.codes);
      return detail ? `Retrying ${e.path} (${detail})` : `Retrying ${e.path}`;
    }
    case 'page_done': return `${e.status === 'generated' ? 'Wrote' : e.status === 'skipped' ? 'Unchanged' : 'Saved'} ${e.path}${e.chars ? ` (${e.chars} chars)` : ''}`;
    case 'page_fail': return `Failed ${e.path}: ${e.message}`;
    case 'run_finished': return 'Done.';
    case 'run_error': return `Error: ${e.message}`;
    case 'job_error': return `Error: ${e.message}`;
    case 'log': return e.message;
    default: return e.message || null;
  }
}

export default function GenerationStatus({ owner, repo, job, status, onDone, onDeleted }) {
  const app = useApp();
  const [events, setEvents] = useState([]);
  const [liveProgress, setLiveProgress] = useState(job?.progress || null);
  const [state, setState] = useState(status);
  const [retrying, setRetrying] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [showLog, setShowLog] = useState(true);
  const [showModelInfo, setShowModelInfo] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef(null);

  useEffect(() => { setState(status); }, [status]);

  useEffect(() => {
    if (state === 'done' || state === 'failed') return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [state]);

  useEffect(() => {
    if (!job?.id) return undefined;
    setEvents([]);
    setLiveProgress(job?.progress || null);
    const es = new EventSource(`/api/jobs/${encodeURIComponent(job.id)}/events`);
    es.onmessage = msg => {
      try {
        const e = JSON.parse(msg.data);
        if (e.type === 'model_progress') {
          setLiveProgress(e);
          return;
        }
        if (e.type === 'page_start' || e.type === 'page_done' || e.type === 'page_fail' || e.type === 'job_done' || e.type === 'job_error') {
          setLiveProgress(null);
        }
        setEvents(list => [...list, e]);
        if (e.type === 'job_done') {
          setState('done');
          es.close();
          setTimeout(onDone, 400);
        }
        if (e.type === 'job_error') {
          setState('failed');
          setStopping(false);
          es.close();
          // Reload in case partial pages were promoted and can now be displayed
          setTimeout(onDone, 500);
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* the browser retries on its own */ };
    return () => es.close();
  }, [job?.id, onDone]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [events.length, showLog]);

  const plan = [...events].reverse().find(e => e.type === 'plan_ready');
  const total = plan ? plan.pages.length : 0;
  const doneEvents = events.filter(e => e.type === 'page_done' || e.type === 'page_fail');
  const done = doneEvents.length;
  const failedPages = events.filter(e => e.type === 'page_fail').length;
  const activePageEvent = [...events].reverse().find(e => e.type === 'page_start' || e.type === 'page_done' || e.type === 'page_fail');
  const activePage = activePageEvent && activePageEvent.type === 'page_start' ? activePageEvent : null;
  const lastStepEvent = [...events].reverse().find(e => ['plan_started', 'page_start', 'page_retry', 'scan_started', 'clone_started', 'job_started'].includes(e.type));

  const pct = total
    ? Math.min(99, Math.max(5, Math.round((done / total) * 100)))
    : events.some(e => e.type === 'plan_started')
      ? 10
      : events.some(e => e.type === 'scan_done')
        ? 6
        : 3;

  const startedAtMs = job?.startedAt ? Date.parse(job.startedAt)
    : events[0]?.ts ? Date.parse(events[0].ts) : null;
  const elapsedMs = startedAtMs ? Math.max(0, now - startedAtMs) : 0;
  const stepElapsedMs = lastStepEvent?.ts ? Math.max(0, now - Date.parse(lastStepEvent.ts)) : 0;

  const failed = state === 'failed';
  const lines = events
    .map(e => ({ ts: formatTime(e.ts), text: describeEvent(e) }))
    .filter(item => item.text);
  const runStarted = [...events].reverse().find(e => e.type === 'run_started');
  const profile = job?.model ? app.settings?.models?.[job.model] : null;
  const modelDetail = runStarted?.modelId || profile?.model || profile?.command || (profile?.modelPath ? String(profile.modelPath).split('/').pop() : '');
  const modelLabel = job?.model
    ? (modelDetail && modelDetail !== job.model ? `${job.model} (${modelDetail})` : job.model)
    : '';

  let liveText = 'Starting…';
  if (activePage) {
    if (liveProgress && liveProgress.phase === 'generating') {
      liveText = `Writing ${activePage.path} · ${liveProgress.tokens || 0} tokens${liveProgress.tokPerSec ? ` · ${liveProgress.tokPerSec} tok/s` : ''} · ${formatDuration(stepElapsedMs)}`;
    } else if (liveProgress && liveProgress.phase === 'thinking') {
      liveText = `Thinking about ${activePage.path} · ${liveProgress.tokens || 0} tokens${liveProgress.tokPerSec ? ` · ${liveProgress.tokPerSec} tok/s` : ''} · ${formatDuration(stepElapsedMs)}`;
    } else if (liveProgress && liveProgress.phase === 'reading_prompt') {
      liveText = `Reading source files for ${activePage.path}… · ${formatDuration(stepElapsedMs)}`;
    } else {
      liveText = `Writing ${activePage.path}… · ${formatDuration(stepElapsedMs)}`;
    }
  } else if (events.some(e => e.type === 'plan_started') && !plan) {
    if (liveProgress && liveProgress.phase === 'generating') {
      liveText = `Planning pages · ${liveProgress.tokens || 0} tokens${liveProgress.tokPerSec ? ` · ${liveProgress.tokPerSec} tok/s` : ''} · ${formatDuration(stepElapsedMs)}`;
    } else if (liveProgress && liveProgress.phase === 'thinking') {
      liveText = `Thinking about wiki plan · ${liveProgress.tokens || 0} tokens${liveProgress.tokPerSec ? ` · ${liveProgress.tokPerSec} tok/s` : ''} · ${formatDuration(stepElapsedMs)}`;
    } else if (liveProgress && liveProgress.phase === 'reading_prompt') {
      liveText = `Model reading wiki plan prompt… · ${formatDuration(stepElapsedMs)}`;
    } else {
      liveText = `Planning wiki structure… · ${formatDuration(stepElapsedMs)}`;
    }
  } else if (events.some(e => e.type === 'scan_started') && !events.some(e => e.type === 'scan_done')) {
    liveText = `Scanning repository files… · ${formatDuration(stepElapsedMs)}`;
  } else if (lines.length) {
    liveText = `${lines[lines.length - 1].text}${stepElapsedMs ? ` · ${formatDuration(stepElapsedMs)}` : ''}`;
  }

  const openInTerminal = async () => {
    try {
      await api.post(`${wikiApiPath(owner, repo)}/open-log`, {});
      app.showToast('Opened live log in Terminal');
    } catch (err) {
      app.showToast(err.message);
    }
  };

  const copyLog = () => {
    const text = lines.map(l => (l.ts ? `[${l.ts}] ${l.text}` : l.text)).join('\n');
    navigator.clipboard?.writeText(text).then(() => app.showToast('Log copied')).catch(() => app.showToast('Copy failed'));
  };

  const stopJob = async () => {
    if (!job?.id) return;
    setStopping(true);
    try {
      await api.post(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, {});
    } catch { /* ignore */ }
  };

  return (
    <div className="gen-card">
      <h1>{failed ? 'Generation stopped' : 'Writing the wiki…'}</h1>
      <p className="muted" style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span>{owner}/{repo}</span>
        {modelLabel && (
          <button
            type="button"
            className="pill"
            onClick={() => setShowModelInfo(v => !v)}
            title="Click to inspect model parameters"
          >
            model: {modelLabel} {showModelInfo ? '▴' : '▾'}
          </button>
        )}
      </p>
      {showModelInfo && profile && (
        <div className="notice" style={{ fontSize: 12.5, padding: '10px 12px', marginBottom: 12 }}>
          <dl className="model-kv">
            <div className="model-kv-row"><dt>Profile</dt><dd>{job.model}</dd></div>
            <div className="model-kv-row"><dt>Provider</dt><dd>{profile.provider}</dd></div>
            {profile.model && <div className="model-kv-row"><dt>Model</dt><dd>{profile.model}</dd></div>}
            {profile.command && <div className="model-kv-row"><dt>Command</dt><dd>{[profile.command, ...(profile.args || [])].join(' ')}</dd></div>}
            {profile.baseUrl && <div className="model-kv-row"><dt>Endpoint</dt><dd>{profile.baseUrl}</dd></div>}
            {profile.contextChars && <div className="model-kv-row"><dt>Code context / page</dt><dd>{Number(profile.contextChars).toLocaleString()} chars (~{Math.max(1, Math.round(Number(profile.contextChars) / 4000))}k tok)</dd></div>}
            {profile.contextSize && <div className="model-kv-row"><dt>Context window</dt><dd>{profile.contextSize} tok</dd></div>}
            {profile.maxTokens && <div className="model-kv-row"><dt>Max tokens</dt><dd>{profile.maxTokens}</dd></div>}
            {profile.think !== undefined && <div className="model-kv-row"><dt>Thinking</dt><dd>{String(profile.think)}</dd></div>}
          </dl>
          <div style={{ marginTop: 8 }}>
            <button type="button" className="inline-link" onClick={() => app.openDialog('settings', { initialModel: job.model })}>Configure model</button>
          </div>
        </div>
      )}

      {!failed && (
        <>
          <div className="gen-stats">
            <strong>
              {total > 0 ? `${done} / ${total} pages · ${pct}%` : `${pct}%`}
              {failedPages > 0 ? ` (${failedPages} failed)` : ''}
            </strong>
            <span className="muted">Elapsed {formatDuration(elapsedMs)}</span>
          </div>
          <div className="progress" aria-label="Progress"><div style={{ width: `${pct}%` }} /></div>
          <div className="gen-live" role="status" aria-live="polite">
            <span className="live-dot" aria-hidden="true" />
            <span>{liveText}</span>
          </div>
        </>
      )}

      {failed && (
        <div className="notice err">
          {job?.error || [...events].reverse().find(e => e.type === 'job_error')?.message || 'The run failed. Check the model settings and try again.'}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12, marginBottom: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {failed ? (
          <>
            <button
              type="button"
              className="btn btn-blue"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                api.post(`${wikiApiPath(owner, repo)}/refresh`, { model: app.settings?.default || undefined })
                  .then(onDone)
                  .catch(e => { setRetrying(false); app.showToast(e.message); });
              }}
            >
              {retrying ? 'Starting…' : 'Try again'}
            </button>
            <button type="button" className="btn" onClick={() => app.openDialog('settings')}>Model settings</button>
            <button type="button" className="btn btn-danger" onClick={() => app.openDialog('delete', { owner, repo, onDeleted })}>Delete</button>
          </>
        ) : (
          <button type="button" className="btn" disabled={stopping} onClick={stopJob}>
            {stopping ? 'Stopping & saving pages…' : 'Stop'}
          </button>
        )}
        <button type="button" className="btn" onClick={() => setShowLog(v => !v)}>
          {showLog ? 'Hide log' : 'Live log'}
        </button>
        <button type="button" className="btn" onClick={openInTerminal} title="Open live tail -f in macOS Terminal">
          Open in Terminal
        </button>
        {showLog && lines.length > 0 && (
          <button type="button" className="btn" onClick={copyLog}>Copy log</button>
        )}
      </div>

      {showLog && (
        <div className="log log-terminal" ref={logRef}>
          {lines.map((l, i) => (
            <div key={i}>
              {l.ts && <span className="log-ts">[{l.ts}] </span>}
              {l.text}
            </div>
          ))}
          {!lines.length && <div>Waiting for the engine…</div>}
        </div>
      )}
    </div>
  );
}

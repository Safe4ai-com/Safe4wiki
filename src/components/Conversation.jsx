import { useEffect, useMemo, useRef, useState } from 'react';
import Markdown from './Markdown.jsx';
import CodeViewer from './CodeViewer.jsx';
import {
  ArrowUp, BoltIcon, BrainIcon, CheckIcon, CopyIcon, MaximizeIcon, MinimizeIcon,
  PaperclipIcon, RefreshIcon, SparkleIcon, ThumbDownIcon, ThumbUpIcon, TrashIcon, XIcon,
} from './Icons.jsx';
import { ModeMenu } from './ChatBox.jsx';
import { useApp } from '../lib/context';
import { stream } from '../lib/api.js';
import { searchSections } from '../lib/search.js';

const MAX_FILES = 5;
const MAX_FILE_BYTES = 200 * 1024;
const INLINE_CITE_RE = /\[([^\]\s:`]+?\.[A-Za-z0-9_+-]+):L?(\d+)(?:\s*[-–]\s*L?(\d+))?\]/g;

function extractAnswerCitations(markdown) {
  const out = [];
  const seen = new Set();
  for (const m of String(markdown || '').matchAll(INLINE_CITE_RE)) {
    const file = m[1].replace(/^\.?\//, '');
    const start = Number(m[2]) || null;
    const end = Number(m[3]) || start;
    const key = `${file}:${start || ''}-${end || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, start, end });
  }
  return out;
}

function offlineAnswer(pages, question, base) {
  const hits = searchSections(pages, question, 5);
  if (!hits.length) {
    return { hits, text: 'No part of this wiki matches the question. Try other words, or start the Safe4wiki app on your computer to ask your model.' };
  }
  const lines = hits.map(h => {
    const excerpt = h.text.length > 320 ? `${h.text.slice(0, 320)}…` : h.text;
    return `#### [${h.heading}](${base}/${h.page.slug}${h.anchor ? `#${h.anchor}` : ''})\n\n${excerpt}`;
  });
  return { hits, text: `These parts of the wiki match your question best:\n\n${lines.join('\n\n')}` };
}

function AnswerSkeleton() {
  const widths = [74, 88, 52, 60, 82, 40];
  return (
    <div className="as-answer-card as-skel-card" aria-hidden="true">
      {widths.map((w, i) => (
        <div key={i} className="shimmer-bar" style={{ width: `${w}%`, animationDelay: `${i * 55}ms` }} />
      ))}
    </div>
  );
}

function Turn({
  turn, wiki, origin, pages, base, history, update, retry, resolveLink, onNavigate, onInspectFile, activeFile,
}) {
  const app = useApp();
  const started = useRef(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (started.current || turn.status) return;
    started.current = true;
    const t0 = Date.now();
    if (!app.server) {
      const { hits, text } = offlineAnswer(pages, turn.q, base);
      update({
        status: 'done',
        offline: true,
        answer: text,
        ms: Date.now() - t0,
        statusText: `Found ${hits.length} matching section${hits.length === 1 ? '' : 's'}`,
      });
      return;
    }
    update({ status: 'thinking', answer: '', statusText: 'Searching wiki & code…', startedAt: t0 });
    const body = {
      owner: wiki.owner,
      repo: wiki.repo,
      question: turn.q,
      mode: turn.mode,
      model: turn.model || undefined,
      history: history.map(h => ({ q: h.q, a: h.answer || '' })),
      pages: origin === 'local' ? undefined : pages.map(p => ({ path: p.path, title: p.title, markdown: p.markdown })),
      attachments: turn.files || [],
    };
    let answer = '';
    let flushTimer = null;
    const flushAnswer = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      update({ status: 'streaming', answer });
    };
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(flushAnswer, 65);
    };
    stream('/api/chat', body, (type, data) => {
      if (type === 'status') {
        const text = String(data.message || '').trim();
        update({ statusText: text });
      } else if (type === 'sources') {
        const sources = data.sources || [];
        const pageRefs = data.pages || [];
        update({
          sources,
          pageRefs,
          statusText: `Found ${pageRefs.length} wiki page${pageRefs.length === 1 ? '' : 's'} & ${sources.length} code match${sources.length === 1 ? '' : 'es'}`,
        });
      } else if (type === 'delta') {
        answer += data.text || '';
        scheduleFlush();
      } else if (type === 'done') {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        update({
          status: 'done',
          resolvedModel: data.model,
          answer: data.answer || answer,
          ms: Date.now() - t0,
        });
      } else if (type === 'error') {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        update({ status: 'error', error: data.message, ms: Date.now() - t0 });
      }
    }).then(() => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      update(t => (t.status === 'done' || t.status === 'error' ? {} : { status: 'done', answer, ms: Date.now() - t0 }));
    }).catch(err => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      update({ status: 'error', error: err.message, ms: Date.now() - t0 });
    });
  }, [app.server, base, history, origin, pages, turn, update, wiki]);

  const wikiRefs = (turn.pageRefs || [])
    .map(ref => pages.find(p => p.path === ref.path))
    .filter(Boolean);
  const codeRefs = useMemo(() => {
    const inline = extractAnswerCitations(turn.answer);
    const retrieved = turn.sources || [];
    const merged = [];
    const seen = new Set();
    for (const r of [...inline, ...retrieved]) {
      const key = `${r.file}:${r.start || ''}-${r.end || ''}`;
      if (!r.file || seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
    return merged;
  }, [turn.answer, turn.sources]);

  const thinking = turn.status === 'thinking' || !turn.status;
  const streaming = turn.status === 'streaming';
  const modeLabel = turn.mode === 'deep' ? 'Deep' : 'Fast';
  const modelName = turn.resolvedModel || turn.model || app.settings?.chatModel || app.settings?.default || '';
  const modelProfile = modelName ? app.settings?.models?.[modelName] : null;
  const modelId = modelProfile?.model || modelProfile?.command || '';
  const modelDisplay = modelName ? (modelId && modelId !== modelName ? `${modelName} (${modelId})` : modelName) : '';

  const copy = () => {
    navigator.clipboard?.writeText(turn.answer || '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => app.showToast('Copying is blocked by the browser.'));
  };

  return (
    <div className="as-turn">
      <div className="as-q-head">
        <h2 className="as-q-title">{turn.q}</h2>
        <div className="as-q-meta">
          <span className="as-pill">
            {turn.mode === 'deep' ? <BrainIcon size={12} /> : <BoltIcon size={12} />}
            {modeLabel}
          </span>
          {modelDisplay && <span className="as-pill as-pill-muted">{modelDisplay}</span>}
          {(thinking || streaming) && (
            <span className="as-live-pill">
              <span className="as-spinner" aria-hidden="true" />
              <span>{streaming ? 'Writing answer…' : (turn.statusText || 'Searching…')}</span>
            </span>
          )}
          {turn.status === 'done' && turn.ms ? (
            <span className="as-pill as-pill-muted">{(turn.ms / 1000).toFixed(1)}s</span>
          ) : null}
        </div>
        {(turn.files || []).length > 0 && (
          <div className="as-files" style={{ justifyContent: 'flex-start', marginTop: 8 }}>
            {turn.files.map(f => <span key={f.name} className="as-file"><PaperclipIcon size={13} />{f.name}</span>)}
          </div>
        )}
      </div>

      {turn.offline && (
        <div className="as-note">The Safe4wiki app isn’t running on this computer, so this answer only searches the wiki text. Start the app to get answers from your own model, with the code as context.</div>
      )}

      {thinking && !turn.answer && <AnswerSkeleton />}

      {turn.answer ? (
        <div className="as-answer-card">
          <div className="as-answer">
            <Markdown
              markdown={turn.answer}
              source={wiki.source}
              resolveLink={resolveLink}
              onNavigate={onNavigate}
              onInspectFile={onInspectFile}
              streaming={streaming}
            />
          </div>
          {streaming && <div className="as-stream-caret" aria-hidden="true" />}
        </div>
      ) : null}

      {turn.status === 'error' && <div className="notice err" style={{ marginTop: 10 }}>{turn.error}</div>}

      {(wikiRefs.length > 0 || codeRefs.length > 0) && (turn.status === 'done' || streaming) && (
        <div className="as-sources">
          {wikiRefs.length > 0 && (
            <div className="as-source-row">
              <span className="as-src-label">Wiki</span>
              <div className="turn-pages">
                {wikiRefs.map(p => (
                  <a key={p.slug} href={`${base}/${p.slug}`} onClick={e => { e.preventDefault(); onNavigate(`${base}/${p.slug}`); }}>
                    {p.num} {p.title}
                  </a>
                ))}
              </div>
            </div>
          )}
          {codeRefs.length > 0 && (
            <div className="as-source-row">
              <span className="as-src-label">Code</span>
              <div className="as-code-chips">
                {codeRefs.slice(0, 10).map((r, idx) => (
                  <button
                    key={`${r.file}-${r.start || idx}`}
                    type="button"
                    className={`as-cite-btn${activeFile === r.file ? ' on' : ''}`}
                    title={`Inspect ${r.file}${r.start ? ` lines ${r.start}-${r.end || r.start}` : ''}`}
                    onClick={() => onInspectFile(r)}
                  >
                    <span>{r.file.split('/').pop()}</span>
                    {r.start && <span className="as-cite-ln">{r.start}{r.end && r.end !== r.start ? `–${r.end}` : ''}</span>}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {(turn.status === 'done' || turn.status === 'error') && (
        <div className="as-actions">
          <button type="button" aria-label="Good answer" aria-pressed={turn.feedback === 'up'} className={turn.feedback === 'up' ? 'on' : ''}
            onClick={() => update(t => ({ feedback: t.feedback === 'up' ? null : 'up' }))}><ThumbUpIcon /></button>
          <button type="button" aria-label="Bad answer" aria-pressed={turn.feedback === 'down'} className={turn.feedback === 'down' ? 'on' : ''}
            onClick={() => update(t => ({ feedback: t.feedback === 'down' ? null : 'down' }))}><ThumbDownIcon /></button>
          <button type="button" aria-label="Copy answer" onClick={copy} disabled={!turn.answer}>{copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}</button>
          <button type="button" aria-label="Ask again" onClick={retry}><RefreshIcon size={18} /></button>
        </div>
      )}
    </div>
  );
}

function readTextFile(file) {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_FILE_BYTES) { reject(new Error(`${file.name} is too big (over 200 KB). Attach a smaller part of it.`)); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const text = String(reader.result || '');
      if (text.slice(0, 4000).includes('\u0000')) reject(new Error(`${file.name} isn’t a text file. Attach code, logs or notes.`));
      else resolve({ name: file.name, text });
    };
    reader.readAsText(file);
  });
}

function Composer({ onAsk, mode, setMode, model, setModel, busy, autoFocus, floating }) {
  const app = useApp();
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const areaRef = useRef(null);
  const fileRef = useRef(null);

  useEffect(() => { if (autoFocus) areaRef.current?.focus(); }, [autoFocus]);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [text]);

  const submit = e => {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    onAsk(q, files);
    setText('');
    setFiles([]);
  };

  const attach = async list => {
    const picked = [...list].slice(0, MAX_FILES - files.length);
    if (list.length > picked.length) app.showToast(`Up to ${MAX_FILES} files per question.`);
    for (const f of picked) {
      try {
        const read = await readTextFile(f);
        setFiles(all => [...all.filter(x => x.name !== read.name), read]);
      } catch (err) { app.showToast(err.message); }
    }
  };

  return (
    <div className={floating ? 'as-composer-dock' : 'as-composer-wrap'}>
      <form className={`as-composer${busy ? ' busy' : ''}`} onSubmit={submit}
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); if (e.dataTransfer.files?.length) attach(e.dataTransfer.files); }}>
        {files.length > 0 && (
          <div className="as-files">
            {files.map(f => (
              <span key={f.name} className="as-file">
                <PaperclipIcon size={13} />{f.name}
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(all => all.filter(x => x.name !== f.name))}><XIcon size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={areaRef}
          value={text}
          rows={1}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e); }}
          placeholder="Ask a follow-up question…"
          aria-label="Ask a follow-up question"
        />
        <div className="as-composer-bar">
          <button type="button" className="as-icon-btn" aria-label="Attach a file" title="Attach a text file (code, log, notes)" onClick={() => fileRef.current?.click()}>
            <PaperclipIcon />
          </button>
          <input ref={fileRef} type="file" multiple hidden onChange={e => { attach(e.target.files || []); e.target.value = ''; }} />
          <ModeMenu mode={mode} setMode={setMode} model={model} setModel={setModel} />
          <button type="submit" className={`as-send${text.trim() && !busy ? ' ready' : ''}`} aria-label="Send question" disabled={busy}>
            {busy ? <span className="as-spinner" aria-hidden="true" /> : <ArrowUp />}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Split-view (or drawer) RAG workspace with live syntax-highlighted code inspector. */
export default function Conversation({
  wiki, origin, turns, setTurns, onClose, resolveLink, onNavigate, pages, base,
  onAsk, mode, setMode, model, setModel,
}) {
  const [split, setSplit] = useState(true);
  const [inspected, setInspected] = useState(null);
  const bodyRef = useRef(null);
  const busy = turns.some(t => t.status === 'thinking' || t.status === 'streaming' || !t.status);
  const lastTurn = turns[turns.length - 1] || null;
  const lastRun = lastTurn ? `${lastTurn.id}-${lastTurn.run || 0}` : '';

  // Collect all cited/retrieved code references from the latest turn (and earlier turns as fallback)
  const availableRefs = useMemo(() => {
    const out = [];
    const seen = new Set();
    const orderedTurns = [...turns].reverse();
    for (const t of orderedTurns) {
      const inline = extractAnswerCitations(t.answer);
      const sources = t.sources || [];
      for (const r of [...inline, ...sources]) {
        if (!r?.file) continue;
        const key = `${r.file}:${r.start || ''}-${r.end || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
      }
    }
    return out;
  }, [turns]);

  // A new question scrolls to the top of its turn, so the answer is read from its start.
  useEffect(() => {
    const body = bodyRef.current;
    const last = body?.querySelector('.as-turn:last-child');
    if (body && last) body.scrollTo({ top: last.offsetTop - 8, behavior: 'smooth' });
  }, [lastRun]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const patch = id => change => setTurns(all => all.map(t => (t.id === id ? { ...t, ...(typeof change === 'function' ? change(t) : change) } : t)));
  const retry = id => () => {
    setInspected(null);
    setTurns(all => all.map(t => (t.id === id
      ? { id: t.id, q: t.q, mode: t.mode, model: t.model, files: t.files, run: (t.run || 0) + 1 }
      : t)));
  };

  const handleInspectFile = ref => {
    if (!ref?.file) return;
    // Merge snippet if we already have one from retrieved sources
    const match = availableRefs.find(r => r.file === ref.file && r.snippet);
    setInspected({ ...ref, snippet: ref.snippet || match?.snippet, _turnId: lastTurn?.id || 'manual' });
    if (!split) setSplit(true);
  };

  const handleNavigate = href => {
    onClose();
    onNavigate(href);
  };

  const suggestions = [
    pages[0] ? `Explain ${pages[0].title}` : null,
    'How is the architecture organised?',
    'Where should I start reading the code?',
  ].filter(Boolean);

  const showCodePane = split && !!inspected;

  return (
    <aside className={`assistant${split ? ' split' : ''}${showCodePane ? ' has-code' : ''}`} aria-label="Assistant">
      <div className="as-head">
        <button type="button" className="as-back" onClick={onClose} title="Back to wiki">
          ← <span>{wiki.owner}/{wiki.repo}</span>
        </button>
        <div className="as-head-title">
          <SparkleIcon size={16} className="as-spark" />
          <span>RAG Assistant</span>
        </div>
        <div className="as-head-tools">
          {split && availableRefs.length > 0 && (
            <button
              type="button"
              className={`as-code-toggle hide-phone${showCodePane ? ' on' : ''}`}
              onClick={() => setInspected(cur => (cur ? null : { ...availableRefs[0], _turnId: lastTurn?.id || 'manual' }))}
              title={showCodePane ? 'Hide code inspector' : 'Open code inspector'}
            >
              {showCodePane ? 'Hide code' : `Code (${availableRefs.length})`}
            </button>
          )}
          <button
            type="button"
            className="as-icon-btn hide-phone"
            onClick={() => setSplit(s => !s)}
            aria-label={split ? 'Switch to side drawer' : 'Switch to full workspace'}
            title={split ? 'Switch to side drawer' : 'Switch to full workspace'}
          >
            {split ? <MinimizeIcon /> : <MaximizeIcon />}
          </button>
          <button type="button" className="as-icon-btn" onClick={() => { setTurns([]); setInspected(null); }} aria-label="Clear conversation" title="Clear conversation" disabled={!turns.length}>
            <TrashIcon />
          </button>
          <button type="button" className="as-icon-btn" onClick={onClose} aria-label="Close assistant" title="Close (Esc)">
            <XIcon size={20} />
          </button>
        </div>
      </div>

      <div className="as-workspace">
        <div className="as-left">
          <div className="as-body" ref={bodyRef}>
            {turns.length === 0 && (
              <div className="as-empty">
                <p>Ask anything about <strong>{wiki.owner}/{wiki.repo}</strong>. Answers use the wiki and source code; click any file citation to inspect the exact lines.</p>
                <div className="as-suggest">
                  {suggestions.map(s => <button key={s} type="button" onClick={() => onAsk(s, [])}>{s}</button>)}
                </div>
              </div>
            )}
            {turns.map((turn, i) => (
              <Turn
                key={`${turn.id}-${turn.run || 0}`}
                turn={turn}
                wiki={wiki}
                origin={origin}
                pages={pages}
                base={base}
                history={turns.slice(Math.max(0, i - 4), i)}
                resolveLink={resolveLink}
                onNavigate={handleNavigate}
                onInspectFile={handleInspectFile}
                activeFile={inspected?.file || ''}
                update={patch(turn.id)}
                retry={retry(turn.id)}
              />
            ))}
          </div>
        </div>

        {showCodePane && (
          <div className="as-right">
            <CodeViewer
              wiki={wiki}
              origin={origin}
              activeRef={inspected}
              availableRefs={availableRefs}
              onSelectRef={handleInspectFile}
              onClose={() => setInspected(null)}
              loading={busy && !inspected}
            />
          </div>
        )}
      </div>

      <Composer onAsk={onAsk} mode={mode} setMode={setMode} model={model} setModel={setModel} busy={busy} autoFocus floating={split} />
    </aside>
  );
}

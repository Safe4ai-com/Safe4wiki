import { useId, useRef, useState } from 'react';
import { useApp } from '../lib/context';
import { ArrowUp, BoltIcon, BrainIcon, ChevronDown, SparkleIcon } from './Icons.jsx';
import { useOutside } from './Header.jsx';

export const MODES = {
  fast: { label: 'Fast', hint: 'Quick answer from the closest matches', Icon: BoltIcon },
  deep: { label: 'Deep', hint: 'Reads more of the wiki and the code before answering', Icon: BrainIcon },
};

/** Fast / Deep switch plus the model that answers. Opens upwards. */
export function ModeMenu({ mode, setMode, model, setModel }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const profiles = Object.keys(app.settings?.models || {});
  const M = MODES[mode] || MODES.fast;
  const chosen = model || app.settings?.chatModel || app.settings?.default;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="mode-btn" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}>
        <M.Icon />
        <span>{M.label}</span>
        <ChevronDown />
      </button>
      {open && (
        <div className="menu" role="menu" style={{ bottom: 44, left: 0 }}>
          {Object.entries(MODES).map(([key, m]) => (
            <button key={key} type="button" role="menuitemradio" aria-checked={mode === key} onClick={() => { setMode(key); setOpen(false); }}>
              <m.Icon /><span>{m.label}{mode === key ? ' ✓' : ''}<span className="hint">{m.hint}</span></span>
            </button>
          ))}
          {profiles.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="hint" style={{ padding: '4px 10px' }}>Answer with</div>
              {profiles.map(p => (
                <button key={p} type="button" role="menuitemradio" aria-checked={chosen === p}
                  onClick={() => { setModel(p); setOpen(false); }}>
                  <span style={{ width: 16 }}>{chosen === p ? '✓' : ''}</span>
                  <span>{p}<span className="hint">{describeProfile(app.settings.models[p])}</span></span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact floating bar at the bottom of a wiki page; opens the right Assistant sidebar on submit. */
export default function ChatBox({ repoLabel, onAsk, busy, mode, setMode, model, setModel, turnCount = 0, onOpenChat }) {
  const [text, setText] = useState('');
  const inputId = useId();
  const input = useRef(null);

  const submit = e => {
    e?.preventDefault();
    const q = text.trim();
    if (!q || busy) return;
    onAsk(q);
    setText('');
  };

  return (
    <div className="chat-dock">
      <form className="chat-form" onSubmit={submit}>
        <ModeMenu mode={mode} setMode={setMode} model={model} setModel={setModel} />
        <input
          id={inputId}
          ref={input}
          className="chat-input"
          type="text"
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder={`Ask about ${repoLabel}…`}
          aria-label={`Ask a question about ${repoLabel}`}
          autoComplete="off"
        />
        {onOpenChat && turnCount > 0 && (
          <button
            type="button"
            className="chat-history-btn"
            onClick={onOpenChat}
            title="Open Assistant sidebar"
            aria-label={`Open Assistant conversation (${turnCount} messages)`}
          >
            <SparkleIcon size={14} />
            <span>{turnCount}</span>
          </button>
        )}
        <button type="submit" className={`send-btn${text.trim() && !busy ? ' ready' : ''}`} aria-label="Send question" disabled={!text.trim() || busy}>
          <ArrowUp size={15} />
        </button>
      </form>
    </div>
  );
}

export function describeProfile(p) {
  if (!p) return '';
  if (p.provider === 'agent-cli') {
    const parts = [`Agent CLI · ${p.command}`];
    if (p.model) parts.push(p.model);
    if (p.reasoningEffort) parts.push(`effort: ${p.reasoningEffort}`);
    return parts.join(' · ');
  }
  if (p.provider === 'llamacpp') return `GGUF file · ${String(p.modelPath || '').split('/').pop()}`;
  return `${p.model || ''} · ${p.provider === 'ollama' ? 'Ollama' : p.provider === 'anthropic' ? 'Anthropic-style API' : 'OpenAI-style API'}`;
}

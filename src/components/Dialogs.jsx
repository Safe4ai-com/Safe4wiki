import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Dialog, { NeedsServer } from './Dialog.jsx';
import { InfoIcon } from './Icons.jsx';
import PublishHelpModal from './PublishHelpModal.jsx';
import { describeProfile } from './ChatBox.jsx';
import { describeEvent } from './GenerationStatus.jsx';
import { useApp } from '../lib/context';
import { api, stream, wikiApiPath } from '../lib/api.js';
import { orderPages } from '../lib/wiki.js';

const LANGUAGES = [['en', 'English'], ['sr', 'Serbian (srpski)'], ['hr', 'Croatian'], ['bs', 'Bosnian'], ['de', 'German'], ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['ru', 'Russian'], ['zh', 'Chinese'], ['ja', 'Japanese']];

/* ------------------------------------------------------------------ */
/* Model profiles                                                       */
/* ------------------------------------------------------------------ */

export const PRESETS = [
  { group: 'On this computer', id: 'inkling-2-mini', label: 'Inkling 2 Mini (Ollama)', profile: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'inkling-2-mini:latest', think: false, contextChars: 48000, contextSize: 24576, maxTokens: 16384 } },
  { group: 'On this computer', id: 'ollama', label: 'Ollama', profile: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen3.5:9b', contextChars: 48000, maxTokens: 8192 } },
  { group: 'On this computer', id: 'lmstudio', label: 'LM Studio', profile: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'local-model', contextChars: 48000, maxTokens: 8192 } },
  { group: 'On this computer', id: 'llamacpp-server', label: 'llama.cpp server / vLLM', profile: { provider: 'openai', baseUrl: 'http://localhost:8080/v1', model: 'local-model', contextChars: 48000, maxTokens: 8192 } },
  { group: 'On this computer', id: 'gguf', label: '.gguf file (no server)', profile: { provider: 'llamacpp', modelPath: '', contextSize: 32768, contextChars: 48000, maxTokens: 8192 } },
  { group: 'Online API', id: 'openai', label: 'OpenAI-compatible API', profile: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', apiKey: '', contextChars: 120000, maxTokens: 12288, concurrency: 3 } },
  { group: 'Online API', id: 'anthropic', label: 'Anthropic-compatible API', profile: { provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', apiKey: '', contextChars: 120000, maxTokens: 12288, concurrency: 3 } },
  { group: 'Online API', id: 'openrouter', label: 'OpenRouter / Groq / DeepSeek / GLM…', profile: { provider: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: '', apiKey: '', contextChars: 120000, maxTokens: 12288, concurrency: 3 } },
  { group: 'Agent CLI', id: 'deepseek-harness', label: 'DeepSeek Harness', profile: { provider: 'agent-cli', command: 'dsh', args: ['--profile', 'headless', '{prompt}'], env: { DSH_PERMISSION_MODE: 'read-only' }, contextChars: 120000, timeoutMs: 900000 } },
  { group: 'Agent CLI', id: 'zcode', label: 'ZCode', profile: { provider: 'agent-cli', command: 'zcode', args: ['--mode', 'plan', '--no-color', '--prompt', '{prompt}'], contextChars: 120000, timeoutMs: 900000 } },
  { group: 'Agent CLI', id: 'claude', label: 'Claude Code', profile: { provider: 'agent-cli', command: 'claude', args: ['-p', '--output-format', 'text'], contextChars: 120000, timeoutMs: 900000 } },
  { group: 'Agent CLI', id: 'codex', label: 'Codex CLI', profile: { provider: 'agent-cli', command: 'codex', args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-'], contextChars: 120000, timeoutMs: 900000 } },
  { group: 'Agent CLI', id: 'gemini', label: 'Gemini CLI', profile: { provider: 'agent-cli', command: 'gemini', args: ['-p', '{prompt}'], contextChars: 120000, timeoutMs: 900000 } },
  { group: 'Agent CLI', id: 'opencode', label: 'OpenCode', profile: { provider: 'agent-cli', command: 'opencode', args: ['run', '{prompt}'], contextChars: 120000, timeoutMs: 900000 } },
  { group: 'Agent CLI', id: 'custom-cli', label: 'Other command', profile: { provider: 'agent-cli', command: '', args: [], contextChars: 120000, timeoutMs: 900000 } },
];

const CONTEXT_PRESETS = [
  { value: 32000, label: '32k', title: 'Fast · small local models (~8k tokens)' },
  { value: 48000, label: '48k', title: 'Balanced local default (~12k tokens)' },
  { value: 120000, label: '120k', title: 'Large cloud & Agent CLI default (~30k tokens)' },
  { value: 200000, label: '200k', title: 'XL context for big models (~50k tokens)' },
];

function parseCliArgs(text) {
  const args = [];
  let cur = '';
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; }
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) { cur += text[++i]; }
      else { cur += ch; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { cur += text[++i]; hasToken = true; continue; }
    if (/\s/.test(ch)) {
      if (hasToken) { args.push(cur); cur = ''; hasToken = false; }
      continue;
    }
    cur += ch;
    hasToken = true;
  }
  if (hasToken) args.push(cur);
  return args;
}

function formatCliArgs(args) {
  return (Array.isArray(args) ? args : []).map(a => {
    const s = String(a);
    if (!s) return '""';
    if (!/\s/.test(s)) return s;
    return s.includes('"') && !s.includes("'") ? `'${s}'` : `"${s.replace(/(["\\])/g, '\\$1')}"`;
  }).join(' ');
}

const CLI_AUTH_INFO = {
  zcode: {
    label: 'ZCode (Z.AI)',
    button: 'Sign in to ZCode (Z.AI)',
    note: 'ZCode CLI signs into an isolated folder (~/.repowiki/zcode-cli) so ZCode Desktop never clears it. Z.AI OAuth sessions expire after ~5 hours — click below whenever you need to re-authenticate in your browser.',
  },
  claude: {
    label: 'Claude Code',
    button: 'Sign in to Claude Code',
    note: 'Runs `claude auth login` in Terminal and opens Anthropic browser sign-in.',
  },
  codex: {
    label: 'Codex',
    button: 'Sign in to Codex',
    note: 'Runs `codex login` in Terminal and opens OpenAI browser sign-in.',
  },
  opencode: {
    label: 'OpenCode',
    button: 'Sign in to OpenCode',
    note: 'Runs `opencode auth login` in Terminal to connect your provider credentials.',
  },
  gemini: {
    label: 'Gemini CLI',
    button: 'Sign in to Gemini CLI',
    note: 'Launches `gemini` in Terminal so you can complete Google OAuth sign-in if not already authenticated.',
  },
};

function cliEffortSpec(command, model) {
  const cmd = String(command || '').trim();
  const m = String(model || '').toLowerCase();
  if (cmd === 'claude') return { via: '--effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'] };
  if (cmd === 'codex') return { via: '-c model_reasoning_effort', levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
  if (cmd === 'dsh') return { via: '--patch reasoningEffort', levels: ['disabled', 'low', 'medium', 'high', 'max'] };
  if (cmd === 'opencode') return { via: '--model #variant', levels: ['low', 'medium', 'high', 'max'], hint: 'Appended as #variant when a model is selected above.' };
  if (cmd === 'zcode') {
    if (/glm-5\.3/.test(m)) return { via: 'provider_config reasoningLevel', levels: ['low', 'high', 'max'] };
    if (/glm-5\.2/.test(m)) return { via: 'provider_config reasoningLevel', levels: ['disabled', 'high', 'max'] };
    if (/glm-5-turbo|glm-5\.1|glm-5v|glm-4/.test(m)) return { via: 'provider_config reasoningLevel', levels: ['disabled', 'enabled'] };
    return { via: 'provider_config reasoningLevel', levels: ['disabled', 'low', 'high', 'max', 'enabled'] };
  }
  return null;
}

const CLI_MODEL_HINTS = {
  dsh: {
    via: '--patch',
    defaultLabel: 'CLI default (deepseek-v4-flash)',
    placeholder: 'Leave empty for CLI default (deepseek-v4-flash)',
    presets: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-flash', 'deepseek-v4-flash-vision-exp'],
  },
  zcode: {
    via: 'provider_config',
    defaultLabel: 'CLI default',
    placeholder: 'Leave empty for CLI default (e.g. GLM-5.3, GLM-5.3-Flash)',
    presets: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo', 'GLM-5.1', 'GLM-5v-Turbo'],
  },
  claude: {
    via: '--model',
    defaultLabel: 'CLI default',
    placeholder: 'Leave empty for CLI default (e.g. claude-sonnet-5-5, opus, fable)',
    presets: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-2', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  codex: {
    via: '--model',
    defaultLabel: 'CLI default',
    placeholder: 'Leave empty for ~/.codex/config.toml default (e.g. gpt-6.2-sol)',
    presets: ['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'],
  },
  gemini: {
    via: '-m',
    defaultLabel: 'CLI default',
    placeholder: 'Leave empty for CLI default (e.g. gemini-3.8-flash, gemini-3.0-pro)',
    presets: ['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.0-pro', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  },
  opencode: {
    via: '-m',
    defaultLabel: 'CLI default',
    placeholder: 'Type to search all OpenCode models (e.g. opencode/deepseek-v4.1-flash-free)',
    presets: [
      'opencode/deepseek-v4.1-flash-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/flint-40b-free',
      'opencode/hy4-flash-free',
      'opencode/big-pickle',
      'deepseek/deepseek-v4-pro',
    ],
  },
};

function thinkToSelect(think) {
  if (think === false) return 'false';
  if (typeof think === 'string' && think) return think;
  return '';
}

function selectToThink(value) {
  if (value === '') return undefined;
  if (value === 'false') return false;
  return value;
}

function formatContextShort(chars) {
  if (!chars) return '';
  const k = Math.round(chars / 1000);
  return `${k}k chars/page`;
}

function ModelConfigModal({
  initialName,
  initialProfile,
  isNew,
  isDefault,
  isChatModel,
  existingNames,
  onSave,
  onCancel,
  onRemove,
}) {
  const app = useApp();
  const [name, setName] = useState(initialName);
  const [profile, setProfile] = useState(() => ({ ...initialProfile }));
  const [useForWiki, setUseForWiki] = useState(isDefault);
  const [useForChat, setUseForChat] = useState(isChatModel);
  const [authOnSave, setAuthOnSave] = useState(!!(isNew && initialProfile?.provider === 'agent-cli' && initialProfile?.command === 'zcode'));
  const [authBusy, setAuthBusy] = useState(false);
  const [ollamaModels, setOllamaModels] = useState([]);
  const [argsText, setArgsText] = useState(() => formatCliArgs(initialProfile.args));
  const [testState, setTestState] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const lastArgsRef = useRef(initialProfile.args);

  useEffect(() => {
    if (profile.args !== lastArgsRef.current) {
      lastArgsRef.current = profile.args;
      setArgsText(formatCliArgs(profile.args));
    }
  }, [profile.args]);

  useEffect(() => {
    const cliCmd = profile.provider === 'agent-cli' ? String(profile.command || '').trim() : '';
    const isLiveCli = cliCmd === 'opencode' || cliCmd === 'codex';
    if (!isLiveCli && profile.provider !== 'ollama' && !/localhost|127\.0\.0\.1/.test(profile.baseUrl || '')) return;
    api.post('/api/models/list', { profile }).then(r => setOllamaModels(r.models || [])).catch(() => setOllamaModels([]));
  }, [profile.provider, profile.baseUrl, profile.command]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = profile;
  const set = (k, v) => setProfile(prev => {
    const next = { ...prev };
    if (v === undefined) delete next[k];
    else next[k] = v;
    return next;
  });
  const num = (k, v) => set(k, v === '' ? undefined : Number(v));
  const cliModelHint = p.provider === 'agent-cli' ? CLI_MODEL_HINTS[String(p.command || '').trim()] : null;
  const cliEffort = p.provider === 'agent-cli' ? cliEffortSpec(p.command, p.model) : null;
  const cliAuth = p.provider === 'agent-cli' ? CLI_AUTH_INFO[String(p.command || '').trim()] : null;

  const onArgsChange = value => {
    setArgsText(value);
    const parsed = parseCliArgs(value);
    lastArgsRef.current = parsed;
    set('args', parsed);
  };

  const cleanName = name.trim().replace(/[^A-Za-z0-9._-]/g, '-');
  const nameConflict = isNew && (!cleanName || existingNames.includes(cleanName));
  const approxTokens = Math.max(1, Math.round((Number(p.contextChars) || 48000) / 4000));

  const runTest = async () => {
    setError('');
    setTestState({ state: 'running' });
    try {
      const r = await api.post('/api/models/test', { name: cleanName || initialName, profile });
      setTestState({ state: 'ok', text: r.reply, ms: r.ms });
    } catch (err) {
      setTestState({ state: 'bad', text: err.message });
    }
  };

  const runCliAuth = async () => {
    setError('');
    setAuthBusy(true);
    try {
      const r = await api.post('/api/models/cli-auth', { command: p.command });
      app.showToast(`Opened Terminal for ${r.label || p.command} sign-in — complete auth in your browser.`);
    } catch (err) {
      setError(err.message);
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSave = async () => {
    if (isNew && !cleanName) { setError('Enter a profile name.'); return; }
    if (isNew && existingNames.includes(cleanName)) { setError(`A profile named “${cleanName}” already exists.`); return; }
    if (profile.provider === 'agent-cli' && !String(profile.command || '').trim()) {
      setError('Enter the CLI command name (e.g. claude, codex, opencode).');
      return;
    }
    if (profile.provider === 'llamacpp' && !String(profile.modelPath || '').trim()) {
      setError('Enter the path to your .gguf model file.');
      return;
    }
    if (['openai', 'anthropic', 'ollama'].includes(profile.provider)) {
      if (!String(profile.baseUrl || '').trim()) { setError('Enter the server address (base URL).'); return; }
      if (!String(profile.model || '').trim()) { setError('Enter a model name.'); return; }
    }
    for (const [k, label] of [['contextChars', 'Code context'], ['maxTokens', 'Max answer tokens'], ['contextSize', 'Context window'], ['concurrency', 'Pages in parallel'], ['timeoutMs', 'Timeout']]) {
      if (profile[k] !== undefined && (!Number.isFinite(Number(profile[k])) || Number(profile[k]) <= 0)) {
        setError(`${label} must be a positive number.`);
        return;
      }
    }
    setError('');
    setSaving(true);
    try {
      await onSave({ name: isNew ? cleanName : initialName, profile, useForWiki, useForChat });
      if (profile.provider === 'agent-cli' && CLI_AUTH_INFO[String(profile.command || '').trim()] && authOnSave) {
        api.post('/api/models/cli-auth', { command: profile.command })
          .then(r => app.showToast(`Opened Terminal for ${r.label || profile.command} sign-in — complete auth in your browser.`))
          .catch(err => app.showToast(err.message));
      }
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Dialog
      nested
      title={isNew ? `Add model · ${cleanName || initialName}` : `Configure “${initialName}”`}
      onClose={onCancel}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: 8, flexWrap: 'wrap' }}>
          <div>
            {!isNew && (
              <button type="button" className="btn btn-danger" onClick={onRemove} disabled={saving}>Remove</button>
            )}
          </div>
          <div className="dialog-foot-group">
            <button type="button" className="btn" onClick={runTest} disabled={testState?.state === 'running' || saving}>
              {testState?.state === 'running' ? 'Testing…' : 'Test'}
            </button>
            <button type="button" className="btn" onClick={onCancel} disabled={saving}>Cancel</button>
            <button type="button" className="btn btn-blue" onClick={handleSave} disabled={saving || nameConflict}>
              {saving ? 'Saving…' : 'Save model'}
            </button>
          </div>
        </div>
      }
    >
      <div className="notice" style={{ fontSize: 12.5, padding: '8px 12px', marginBottom: 14 }}>
        {isNew
          ? 'Pre-filled with working defaults — you can save right away or customize the model and context size below.'
          : 'Working defaults are already configured. Adjust only what you want to customize.'}
      </div>

      {isNew && (
        <label className="field"><span>Profile name</span>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. ollama-qwen" />
          {nameConflict && cleanName && <small style={{ color: '#dc2626' }}>A profile named “{cleanName}” already exists.</small>}
        </label>
      )}

      {p.provider === 'agent-cli' ? (
        <>
          <div className="row">
            <label className="field"><span>Command</span><input className="input" value={p.command || ''} onChange={e => set('command', e.target.value)} placeholder="claude" /></label>
            <label className="field"><span>Arguments</span>
              <input className="input" value={argsText} onChange={e => onArgsChange(e.target.value)} placeholder="-p --output-format text" />
            </label>
          </div>
          {cliModelHint && (() => {
            const cliCmd = String(p.command || '').trim();
            const liveCliModels = (cliCmd === 'opencode' || cliCmd === 'codex') ? ollamaModels : [];
            const pills = liveCliModels.length
              ? (cliCmd === 'opencode'
                ? [...new Set([...liveCliModels.filter(m => /free|deepseek/i.test(m)).slice(0, 6), ...liveCliModels.slice(0, 6)])].slice(0, 6)
                : liveCliModels.slice(0, 6))
              : cliModelHint.presets;
            return (
              <div className="field">
                <span>Model (passed via <code>{cliModelHint.via}</code>)</span>
                <input
                  className="input"
                  list={liveCliModels.length ? `cli-models-${initialName}` : undefined}
                  value={p.model || ''}
                  onChange={e => set('model', e.target.value || undefined)}
                  placeholder={cliModelHint.placeholder}
                />
                {liveCliModels.length > 0 && (
                  <datalist id={`cli-models-${initialName}`}>
                    {liveCliModels.map(m => <option key={m} value={m} />)}
                  </datalist>
                )}
                <div className="preset-pills">
                  <button
                    type="button"
                    className={`preset-pill${!p.model ? ' on' : ''}`}
                    onClick={() => set('model', undefined)}
                  >
                    {cliModelHint.defaultLabel}
                  </button>
                  {pills.map(m => (
                    <button
                      key={m}
                      type="button"
                      className={`preset-pill${p.model === m ? ' on' : ''}`}
                      onClick={() => set('model', m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                {liveCliModels.length > 0 && (
                  <small>
                    Loaded {liveCliModels.length} models from{' '}
                    <code>{cliCmd === 'codex' ? '~/.codex/models_cache.json' : 'opencode models'}</code>
                    {' '}— click the field or type to filter all of them.
                  </small>
                )}
              </div>
            );
          })()}
          {cliEffort && (
            <div className="field">
              <span>Reasoning effort (passed via <code>{cliEffort.via}</code>)</span>
              <div className="preset-pills" style={{ marginTop: 2 }}>
                <button
                  type="button"
                  className={`preset-pill${!p.reasoningEffort ? ' on' : ''}`}
                  onClick={() => set('reasoningEffort', undefined)}
                >
                  CLI default
                </button>
                {cliEffort.levels.map(lvl => (
                  <button
                    key={lvl}
                    type="button"
                    className={`preset-pill${p.reasoningEffort === lvl ? ' on' : ''}`}
                    onClick={() => set('reasoningEffort', lvl)}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
              {cliEffort.hint && <small>{cliEffort.hint}</small>}
            </div>
          )}
          <small className="muted" style={{ display: 'block', marginTop: -6, marginBottom: 12, fontSize: 12 }}>
            Runs inside the repository folder and sends the prompt via stdin or where <code>{'{prompt}'}</code> appears.
          </small>
          {p.command === 'dsh' && <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>DeepSeek Harness uses <code>deepseek-v4-flash</code> by default. Pick a model or reasoning effort above to override it per run via <code>--patch</code>.</p>}
          {cliAuth && (
            <div className="config-card" style={{ marginTop: 4, marginBottom: 12 }}>
              <div className="config-card-title">{cliAuth.label} authentication</div>
              <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px', lineHeight: '18px' }}>
                {cliAuth.note}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-blue" style={{ height: 30 }} onClick={runCliAuth} disabled={authBusy}>
                  {authBusy ? 'Opening Terminal…' : cliAuth.button}
                </button>
                <label className="check" style={{ marginBottom: 0, fontSize: 12.5 }}>
                  <input type="checkbox" checked={authOnSave} onChange={e => setAuthOnSave(e.target.checked)} />
                  <span>Open sign-in in Terminal when saving</span>
                </label>
              </div>
            </div>
          )}
        </>
      ) : p.provider === 'llamacpp' ? (
        <label className="field"><span>Path to the .gguf file</span><input className="input" value={p.modelPath || ''} onChange={e => set('modelPath', e.target.value)} placeholder="/Users/me/models/qwen2.5-coder-7b-q4_k_m.gguf" />
          <small>For direct GGUF use, install the optional runtime first with <code>npm install node-llama-cpp</code> in the app folder.</small>
        </label>
      ) : (
        <>
          <div className="row">
            <label className="field"><span>Provider</span>
              <select className="select" value={p.provider} onChange={e => set('provider', e.target.value)}>
                <option value="openai">OpenAI-compatible (/chat/completions)</option>
                <option value="anthropic">Anthropic-compatible (/v1/messages)</option>
                <option value="ollama">Ollama (native)</option>
              </select>
            </label>
            <label className="field"><span>Model</span>
              <input className="input" list={`models-${initialName}`} value={p.model || ''} onChange={e => set('model', e.target.value)} placeholder="model name" />
              <datalist id={`models-${initialName}`}>{ollamaModels.map(m => <option key={m} value={m} />)}</datalist>
              {ollamaModels.length > 0 && (
                <small>
                  {p.model && !ollamaModels.includes(p.model) ? `“${p.model}” not found on server. Available: ` : 'Available on server: '}
                  {ollamaModels.slice(0, 8).map(m => (
                    <button key={m} type="button" className="pill" style={{ marginRight: 4, marginTop: 4 }} onClick={() => set('model', m)}>{m}</button>
                  ))}
                </small>
              )}
            </label>
          </div>
          <label className="field"><span>Address (base URL)</span><input className="input" value={p.baseUrl || ''} onChange={e => set('baseUrl', e.target.value)} /></label>
          <label className="field">
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span>API key</span>
              {p.hasKey && !p.apiKey && (
                <button
                  type="button"
                  className="inline-link"
                  style={{ fontSize: 12 }}
                  onClick={() => setProfile(prev => { const next = { ...prev }; delete next.hasKey; delete next.apiKey; return next; })}
                >
                  Clear saved key
                </button>
              )}
            </span>
            <input className="input" type="password" autoComplete="off" value={p.apiKey || ''} onChange={e => set('apiKey', e.target.value)}
              placeholder={p.hasKey ? 'Saved (type to replace)' : 'Not needed for local servers. env:NAME reads an environment variable'} />
          </label>
        </>
      )}

      <div className="config-card">
        <div className="config-card-title">Code context &amp; generation</div>
        <label className="field" style={{ marginBottom: (p.provider === 'ollama' || p.provider === 'llamacpp') ? 12 : 0 }}>
          <span>Code context per page (characters)</span>
          <input className="input" type="number" min="8000" step="4000" value={p.contextChars ?? ''} onChange={e => num('contextChars', e.target.value)} placeholder="48000" />
          <div className="preset-pills">
            {CONTEXT_PRESETS.map(cp => (
              <button
                key={cp.value}
                type="button"
                className={`preset-pill${Number(p.contextChars) === cp.value ? ' on' : ''}`}
                title={cp.title}
                onClick={() => set('contextChars', cp.value)}
              >
                {cp.label}
              </button>
            ))}
          </div>
          <small>
            How much source code Safe4wiki attaches per wiki page (≈ {approxTokens}k tokens). This is a per-page prompt budget, not the model’s total context window.
          </small>
        </label>

        {(p.provider === 'ollama' || p.provider === 'llamacpp') && (
          <div className="row" style={{ marginTop: 10 }}>
            <label className="field" style={{ marginBottom: 0 }}>
              <span>Context window (tokens, num_ctx)</span>
              <input className="input" type="number" min="4096" step="4096" value={p.contextSize ?? ''} onChange={e => num('contextSize', e.target.value)} placeholder="Auto" />
            </label>
            {p.provider === 'ollama' && (
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Thinking mode</span>
                <select className="select" value={thinkToSelect(p.think)} onChange={e => set('think', selectToThink(e.target.value))}>
                  <option value="">Auto (model default)</option>
                  <option value="false">Off (fastest for wikis)</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
            )}
          </div>
        )}
      </div>

      <div style={{ marginBottom: 12 }}>
        <label className="check">
          <input type="checkbox" checked={useForWiki} disabled={isDefault && !isNew} onChange={e => setUseForWiki(e.target.checked)} />
          <span>Use as default model for <strong>Wiki generation</strong>{isDefault && !isNew ? <span className="muted"> (currently active)</span> : null}</span>
        </label>
        <label className="check" style={{ marginBottom: 0 }}>
          <input type="checkbox" checked={useForChat} onChange={e => setUseForChat(e.target.checked)} />
          <span>Use as dedicated model for <strong>RAG Chat</strong></span>
        </label>
      </div>

      <details style={{ marginBottom: 12 }}>
        <summary className="muted" style={{ cursor: 'pointer', fontSize: 13, marginBottom: 10 }}>More parameters</summary>
        <div className="row">
          <label className="field"><span>Max answer tokens</span><input className="input" type="number" value={p.maxTokens ?? ''} onChange={e => num('maxTokens', e.target.value)} placeholder="Auto" /></label>
          <label className="field"><span>Pages in parallel</span><input className="input" type="number" min="1" value={p.concurrency ?? ''} onChange={e => num('concurrency', e.target.value)} placeholder="1" /></label>
        </div>
        <div className="row">
          <label className="field"><span>Temperature</span><input className="input" type="number" step="0.1" value={p.temperature ?? ''} onChange={e => num('temperature', e.target.value)} placeholder="Default" /></label>
          {p.provider === 'agent-cli' && (
            <label className="field"><span>Timeout (seconds)</span>
              <input className="input" type="number" min="30" step="30" value={p.timeoutMs ? Math.round(p.timeoutMs / 1000) : ''} onChange={e => set('timeoutMs', e.target.value === '' ? undefined : Number(e.target.value) * 1000)} placeholder="900" />
            </label>
          )}
        </div>
      </details>

      {testState?.state === 'ok' && (
        <div className="notice" style={{ fontSize: 13, borderColor: '#9ad4a8', marginBottom: 0 }}>
          <strong>Connected</strong> · responded in {testState.ms} ms
        </div>
      )}
      {testState?.state === 'bad' && (
        <div className="notice err" style={{ fontSize: 13, marginBottom: 0 }}>
          <strong>Test failed:</strong> {testState.text}
        </div>
      )}
      {error && (
        <div className="notice err" style={{ fontSize: 13, marginTop: 10, marginBottom: 0 }}>{error}</div>
      )}
    </Dialog>
  );
}

export function SettingsDialog({ onClose, initialModel = '', initialTab = 'models' }) {
  const app = useApp();
  const [draft, setDraft] = useState(null);
  const [editing, setEditing] = useState(null); // { name, initialProfile, isNew, direct }
  const [tests, setTests] = useState({});
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState(initialTab);
  const openedInitialRef = useRef(false);

  useEffect(() => {
    if (!app.server) return;
    api.get('/api/settings').then(s => {
      setDraft(s);
      if (initialModel && s.models?.[initialModel] && !openedInitialRef.current) {
        openedInitialRef.current = true;
        setEditing({ name: initialModel, initialProfile: s.models[initialModel], isNew: false, direct: true });
      }
    }).catch(err => app.showToast(err.message));
  }, [app.server, initialModel]); // eslint-disable-line react-hooks/exhaustive-deps

  if (app.server === false) return <NeedsServer onClose={onClose} what="Choosing models" />;
  if (!draft) return <Dialog title="Models & settings" onClose={onClose}><p className="muted">Loading…</p></Dialog>;

  const models = draft.models || {};

  const addPreset = preset => {
    let base = preset.id;
    let n = 1;
    while (models[n === 1 ? base : `${base}-${n}`]) n++;
    const name = n === 1 ? base : `${base}-${n}`;
    setEditing({ name, initialProfile: { ...preset.profile }, isNew: true, direct: false });
  };

  const openEditor = name => {
    if (!models[name]) return;
    setEditing({ name, initialProfile: models[name], isNew: false, direct: false });
  };

  const persistDraft = async (nextDraft, toastMsg, closeAll = false) => {
    const saved = await api.put('/api/settings', nextDraft);
    setDraft(saved);
    await app.reloadSettings();
    if (toastMsg) app.showToast(toastMsg);
    if (closeAll) onClose();
  };

  const saveEditedModel = async ({ name, profile, useForWiki, useForChat }) => {
    const nextModels = { ...models, [name]: profile };
    const nextDefault = useForWiki ? name : (draft.default || name);
    let nextChat = draft.chatModel || '';
    if (useForChat) nextChat = name;
    else if (nextChat === name) nextChat = '';
    const nextDraft = { ...draft, models: nextModels, default: nextDefault, chatModel: nextChat };
    const wasDirect = !!editing?.direct;
    await persistDraft(nextDraft, `Saved “${name}”`, wasDirect);
    if (!wasDirect) setEditing(null);
  };

  const removeEditedModel = async () => {
    if (!editing) return;
    const target = editing.name;
    const nextModels = { ...models };
    delete nextModels[target];
    const first = Object.keys(nextModels)[0] || '';
    const nextDraft = {
      ...draft,
      models: nextModels,
      default: draft.default === target ? first : draft.default,
      chatModel: draft.chatModel === target ? '' : draft.chatModel,
    };
    const wasDirect = !!editing.direct;
    try {
      await persistDraft(nextDraft, `Removed “${target}”`, wasDirect);
      if (!wasDirect) setEditing(null);
    } catch (err) {
      app.showToast(err.message);
    }
  };

  const test = async name => {
    setTests(t => ({ ...t, [name]: { state: 'running' } }));
    try {
      const r = await api.post('/api/models/test', { name, profile: models[name] });
      setTests(t => ({ ...t, [name]: { state: 'ok', text: r.reply, ms: r.ms } }));
    } catch (err) {
      setTests(t => ({ ...t, [name]: { state: 'bad', text: err.message } }));
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await persistDraft(draft, 'Settings saved', true);
    } catch (err) { app.showToast(err.message); } finally { setSaving(false); }
  };

  const groups = [...new Set(PRESETS.map(p => p.group))];

  const formatModelSummary = name => {
    if (!name) return 'none';
    const p = models[name];
    const id = p?.model || p?.command || (p?.modelPath ? String(p.modelPath).split('/').pop() : '');
    return id && id !== name ? `${name} (${id})` : name;
  };

  return (
    <>
      <Dialog wide title="Models & settings" onClose={onClose} footer={<>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-blue" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </>}>
        <div className="seg">
          {[['models', 'Models'], ['chat', 'Chat & search'], ['general', 'Wiki defaults']].map(([k, l]) => (
            <button key={k} type="button" className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        {tab === 'models' && (
          <>
            <div className="notice" style={{ fontSize: 13, marginBottom: 12, padding: '8px 12px' }}>
              <strong>Wiki generation:</strong> {formatModelSummary(draft.default)}
              {' · '}
              <strong>RAG Chat:</strong> {draft.chatModel ? formatModelSummary(draft.chatModel) : (draft.default ? `${formatModelSummary(draft.default)} (same as wiki)` : 'none')}
              {' · '}
              <strong>Embeddings:</strong> {draft.embedding?.enabled ? (draft.embedding.model || 'on') : 'off'}
            </div>
            <div className="profile-list">
              {Object.entries(models).map(([name, p]) => (
                <div key={name} className={`profile-row${draft.default === name ? ' on' : ''}`} onClick={() => openEditor(name)}>
                  <input type="radio" name="default-model" checked={draft.default === name} onChange={() => setDraft(d => ({ ...d, default: name }))} onClick={e => e.stopPropagation()} aria-label={`Use ${name} for wiki generation`} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div>
                      {name}
                      {draft.default === name && <span className="pill ok" style={{ marginLeft: 8 }}>wiki</span>}
                      {(draft.chatModel === name || (!draft.chatModel && draft.default === name)) && <span className="pill" style={{ marginLeft: 6 }}>chat</span>}
                    </div>
                    <div className="meta">
                      {describeProfile(p)}
                      {p.contextChars ? ` · ${formatContextShort(p.contextChars)}` : ''}
                    </div>
                  </div>
                  {tests[name] && <span className={`pill ${tests[name].state === 'ok' ? 'ok' : tests[name].state === 'bad' ? 'bad' : ''}`} title={tests[name].text}>{tests[name].state === 'running' ? 'testing…' : tests[name].state === 'ok' ? `works · ${tests[name].ms} ms` : 'failed'}</span>}
                  {p.provider === 'agent-cli' && CLI_AUTH_INFO[String(p.command || '').trim()] && (
                    <button
                      type="button"
                      className="btn"
                      style={{ height: 28 }}
                      title={`Open Terminal to sign in to ${CLI_AUTH_INFO[String(p.command || '').trim()].label}`}
                      onClick={e => {
                        e.stopPropagation();
                        api.post('/api/models/cli-auth', { command: p.command })
                          .then(r => app.showToast(`Opened Terminal for ${r.label || p.command} sign-in — complete auth in your browser.`))
                          .catch(err => app.showToast(err.message));
                      }}
                    >
                      Auth
                    </button>
                  )}
                  <button type="button" className="btn" style={{ height: 28 }} onClick={e => { e.stopPropagation(); test(name); }}>Test</button>
                  <button type="button" className="btn" style={{ height: 28 }} onClick={e => { e.stopPropagation(); openEditor(name); }}>Configure</button>
                </div>
              ))}
              {!Object.keys(models).length && <div className="profile-row muted">No model yet. Add one below.</div>}
            </div>
            {Object.values(tests).some(t => t.state === 'bad') && (
              <div className="notice err" style={{ fontSize: 13 }}>{Object.entries(tests).filter(([, t]) => t.state === 'bad').map(([n, t]) => <div key={n}><b>{n}:</b> {t.text}</div>)}</div>
            )}
            <div style={{ marginBottom: 4 }}>
              {groups.map(g => (
                <div key={g} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
                  <span className="muted" style={{ width: 130, fontSize: 13 }}>Add · {g}</span>
                  {PRESETS.filter(p => p.group === g).map(p => <button key={p.id} type="button" className="btn" style={{ height: 28, fontSize: 13 }} onClick={() => addPreset(p)}>+ {p.label}</button>)}
                </div>
              ))}
            </div>
            <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
              Click any model (or <strong>Configure</strong>) to edit its parameters in a pop-up. All presets come with working defaults.
            </p>
          </>
        )}
        {tab === 'chat' && (
          <>
            <label className="field"><span>Model for chat answers</span>
              <select className="select" value={draft.chatModel || ''} onChange={e => setDraft(d => ({ ...d, chatModel: e.target.value }))}>
                <option value="">Same as the default model</option>
                {Object.keys(models).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={!!draft.embedding?.enabled} onChange={e => setDraft(d => ({ ...d, embedding: { ...d.embedding, enabled: e.target.checked } }))} />
              Use embeddings for smarter search (semantic + keyword)</label>
            {draft.embedding?.enabled && (
              <>
                <div className="row">
                  <label className="field"><span>Embeddings address (OpenAI-compatible)</span><input className="input" value={draft.embedding.baseUrl || ''} onChange={e => setDraft(d => ({ ...d, embedding: { ...d.embedding, baseUrl: e.target.value } }))} placeholder="http://localhost:11434/v1" /></label>
                  <label className="field"><span>Embeddings model</span><input className="input" value={draft.embedding.model || ''} onChange={e => setDraft(d => ({ ...d, embedding: { ...d.embedding, model: e.target.value } }))} placeholder="nomic-embed-text" /></label>
                </div>
                <label className="field"><span>API key</span><input className="input" type="password" value={draft.embedding.apiKey || ''} onChange={e => setDraft(d => ({ ...d, embedding: { ...d.embedding, apiKey: e.target.value } }))} placeholder={draft.embedding.hasKey ? 'Saved (type to replace)' : 'Not needed for Ollama'} /></label>
              </>
            )}
            <p className="muted" style={{ fontSize: 13 }}>Without embeddings, questions are matched with keyword search (BM25) over the wiki pages and the source files. With Ollama, run <code>ollama pull nomic-embed-text</code> once.</p>
          </>
        )}
        {tab === 'general' && (
          <>
            <div className="row">
              <label className="field"><span>Most pages per wiki</span>
                <input
                  className="input"
                  type="number"
                  min="3"
                  max="200"
                  value={draft.maxPages === 'auto' || !draft.maxPages ? '' : draft.maxPages}
                  onChange={e => setDraft(d => ({ ...d, maxPages: e.target.value === '' ? 'auto' : Number(e.target.value) }))}
                  placeholder="Auto (scales with repo size)"
                />
                <div className="preset-pills">
                  {[['auto', 'Auto (recommended)'], [20, '20'], [36, '36'], [60, '60']].map(([val, label]) => (
                    <button
                      key={String(val)}
                      type="button"
                      className={`preset-pill${(draft.maxPages || 'auto') === val ? ' on' : ''}`}
                      onClick={() => setDraft(d => ({ ...d, maxPages: val }))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <small>Auto picks 14–60 pages depending on repository file count so large repos aren’t squeezed.</small>
              </label>
              <label className="field"><span>Wiki language</span>
                <select className="select" value={draft.language || 'en'} onChange={e => setDraft(d => ({ ...d, language: e.target.value }))}>
                  {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span>Page style</span>
              <select className="select" value={draft.template || 'standard'} onChange={e => setDraft(d => ({ ...d, template: e.target.value }))}>
                <option value="standard">Standard: citations, sources and diagrams</option>
                <option value="minimal">Minimal: shorter pages</option>
              </select>
            </label>
            <p className="muted" style={{ fontSize: 13 }}>Data folder: <code>{draft.dataDir}</code></p>
          </>
        )}
      </Dialog>

      {editing && (
        <ModelConfigModal
          key={`${editing.name}-${editing.isNew ? 'new' : 'edit'}`}
          initialName={editing.name}
          initialProfile={editing.initialProfile}
          isNew={editing.isNew}
          isDefault={editing.isNew ? !draft.default : draft.default === editing.name}
          isChatModel={!editing.isNew && draft.chatModel === editing.name}
          existingNames={Object.keys(models)}
          onSave={saveEditedModel}
          onCancel={() => setEditing(null)}
          onRemove={removeEditedModel}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Add repo                                                            */
/* ------------------------------------------------------------------ */

export function AddRepoDialog({ onClose, prefill = {}, onStarted }) {
  const app = useApp();
  const navigate = useNavigate();
  const [kind, setKind] = useState(prefill.kind || 'local');
  const [path, setPath] = useState(prefill.path || '');
  const [url, setUrl] = useState(prefill.url || '');
  const [branch, setBranch] = useState('');
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [maxPages, setMaxPages] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (app.server === false) return <NeedsServer onClose={onClose} what="Generating a wiki" />;
  const models = Object.keys(app.settings?.models || {});
  const effectiveModel = model || app.settings?.default || '';

  const guess = kind === 'local'
    ? `local/${(path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '')}`
    : (() => { const m = url.match(/[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/); return m ? `${m[1]}/${m[2]}` : ''; })();

  const pick = async () => {
    try { const r = await api.post('/api/pick-folder'); if (r.path) setPath(r.path); } catch (err) { setError(err.message); }
  };
  const submit = async e => {
    e.preventDefault();
    setError('');
    if (!effectiveModel) { setError('Add a model first in Model settings.'); return; }
    setBusy(true);
    try {
      const r = await api.post('/api/wikis', {
        source: kind === 'local' ? { type: 'local', path } : { type: 'git', url, branch: branch || undefined, token: token || undefined },
        name: name || undefined,
        model: effectiveModel,
        maxPages: maxPages ? Number(maxPages) : undefined,
      });
      onClose();
      if (onStarted) onStarted();
      navigate(`/${r.owner}/${r.repo}`);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Dialog title="Add repository" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Cancel</button>
      <button type="submit" form="add-repo" className="btn btn-blue" disabled={busy}>{busy ? 'Starting…' : 'Generate wiki'}</button>
    </>}>
      <form id="add-repo" onSubmit={submit}>
        <div className="seg">
          <button type="button" className={kind === 'local' ? 'on' : ''} onClick={() => setKind('local')}>Folder on this computer</button>
          <button type="button" className={kind === 'git' ? 'on' : ''} onClick={() => setKind('git')}>Git repository (public or private)</button>
        </div>
        {kind === 'local' ? (
          <div className="field"><label htmlFor="repo-folder">Folder</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input id="repo-folder" className="input" value={path} onChange={e => setPath(e.target.value)} placeholder="/Users/me/projects/my-app" required />
              <button type="button" className="btn" onClick={pick}>Browse…</button>
            </div>
            <small>Safe4wiki reads this folder on your computer. Your selected model may process code remotely.</small>
          </div>
        ) : (
          <>
            <label className="field"><span>Repository address</span>
              <input className="input" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://github.com/me/private-repo or git@github.com:me/repo.git" required />
            </label>
            <div className="row">
              <label className="field"><span>Branch (optional)</span><input className="input" value={branch} onChange={e => setBranch(e.target.value)} placeholder="main" /></label>
              <label className="field"><span>Access token (private HTTPS repos)</span>
                <input className="input" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} placeholder="ghp_… / glpat-…" />
              </label>
            </div>
            <small className="muted" style={{ display: 'block', marginTop: -8, marginBottom: 14, fontSize: 12 }}>SSH addresses use your SSH keys. A token is kept only on this computer, for refreshing later; it is never written into the clone.</small>
          </>
        )}
        <div className="row">
          <label className="field"><span>Name in Safe4wiki</span><input className="input" value={name} onChange={e => setName(e.target.value)} placeholder={guess || 'owner/repo'} /></label>
          <label className="field"><span>Model</span>
            <select className="select" value={effectiveModel} onChange={e => setModel(e.target.value)}>
              {!models.length && <option value="">No models yet</option>}
              {models.map(m => <option key={m} value={m}>{m} — {describeProfile(app.settings.models[m])}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>Most pages</span><input className="input" type="number" min="3" max="200" value={maxPages} onChange={e => setMaxPages(e.target.value)} placeholder={app.settings?.maxPages && app.settings.maxPages !== 'auto' ? String(app.settings.maxPages) : 'Auto (scales with repo size)'} /></label>
        {!models.length && <div className="notice warn">No model is set up yet. <button type="button" style={{ textDecoration: 'underline' }} onClick={() => app.openDialog('settings')}>Add one</button>: a local Ollama model, an API, or an agent CLI.</div>}
        {error && <div className="notice err">{error}</div>}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Export & publish                                                     */
/* ------------------------------------------------------------------ */

function wikiPayload(wiki) {
  return {
    owner: wiki.owner, repo: wiki.repo, description: wiki.description, lastIndexed: wiki.lastIndexed,
    commit: wiki.commit, source: wiki.source, sample: !!wiki.sample,
    pages: (wiki.pages || []).map(p => ({ path: p.path, title: p.title, parent: p.parent, markdown: p.markdown })),
  };
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function safeDecodeSlug(segment) {
  try { return decodeURIComponent(segment || ''); } catch { return segment || ''; }
}

export function PdfDialog({ onClose, wiki }) {
  const app = useApp();
  const page = safeDecodeSlug(window.location.pathname.split('/')[3]);
  const [scope, setScope] = useState('all');
  const [paper, setPaper] = useState('A4');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ordered = useMemo(() => orderPages(wiki.pages || []), [wiki]);
  const currentSlug = page || ordered[0]?.slug;
  const printUrl = `/${wiki.owner}/${wiki.repo}/print?paper=${paper}${scope === 'page' ? `&page=${encodeURIComponent(currentSlug)}` : ''}`;

  const create = async () => {
    setError('');
    if (!app.server) { window.open(`${printUrl}&auto=1`, '_blank'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/export/pdf', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner: wiki.owner, repo: wiki.repo, paper, page: scope === 'page' ? currentSlug : undefined }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        if (j.code === 'no_browser') { window.open(`${printUrl}&auto=1`, '_blank'); setError(j.error); return; }
        throw new Error(j.error || `PDF failed (${res.status})`);
      }
      downloadBlob(await res.blob(), `${wiki.owner}-${wiki.repo}${scope === 'page' ? `-${currentSlug}` : ''}.pdf`);
      onClose();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Dialog title="Export to PDF" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={() => window.open(printUrl, '_blank')}>Preview</button>
      <button type="button" className="btn btn-blue" onClick={create} disabled={busy}>{busy ? 'Creating PDF…' : 'Create PDF'}</button>
    </>}>
      <div className="seg">
        <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>Whole wiki ({ordered.length} pages)</button>
        <button type="button" className={scope === 'page' ? 'on' : ''} onClick={() => setScope('page')}>This page only</button>
      </div>
      <label className="field"><span>Paper</span>
        <select className="select" value={paper} onChange={e => setPaper(e.target.value)}><option>A4</option><option>Letter</option></select>
      </label>
      <p className="muted" style={{ fontSize: 13 }}>The PDF has a cover, a numbered table of contents, every page with its diagrams drawn, source references, and page numbers.{!app.server && ' Without the local app it opens in your browser’s print window: choose “Save as PDF”.'}</p>
      {busy && <div className="progress"><div style={{ width: '60%' }} /></div>}
      {error && <div className="notice warn">{error}</div>}
    </Dialog>
  );
}

export function HtmlDialog({ onClose, wiki }) {
  const app = useApp();
  const [mode, setMode] = useState('single'); // 'single' | 'bundle'
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  if (app.server === false) return <NeedsServer onClose={onClose} what="Exporting HTML" />;

  const download = async () => {
    setBusy(true); setError(''); setResult('');
    try {
      const format = mode === 'single' ? 'single' : 'zip';
      const res = await fetch('/api/export/html', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wiki: wikiPayload(wiki), format }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Export failed');
      const filename = mode === 'single'
        ? `${wiki.owner}-${wiki.repo}-docs.html`
        : `${wiki.owner}-${wiki.repo}-site.zip`;
      downloadBlob(await res.blob(), filename);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const toFolder = async () => {
    setBusy(true); setError(''); setResult('');
    try {
      const r = await api.post('/api/export/html', {
        wiki: wikiPayload(wiki),
        format: mode === 'single' ? 'single' : 'folder',
        folder,
      });
      setResult(r.file || r.folder);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Export to HTML" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose}>Close</button>
      <button type="button" className="btn btn-blue" onClick={download} disabled={busy}>
        {busy ? 'Exporting…' : mode === 'single' ? 'Download .html' : 'Download .zip'}
      </button>
    </>}>
      <div className="seg">
        <button type="button" className={mode === 'single' ? 'on' : ''} onClick={() => { setMode('single'); setResult(''); setError(''); }}>Single HTML file (offline)</button>
        <button type="button" className={mode === 'bundle' ? 'on' : ''} onClick={() => { setMode('bundle'); setResult(''); setError(''); }}>Website bundle (for hosting)</button>
      </div>
      {mode === 'single' ? (
        <p style={{ marginTop: 0 }}>
          <b>One self-contained <code>.html</code> file</b> with sidebar navigation, search, light/dark theme, and all SVG diagrams embedded. Double-click to open offline in any browser — no server or extra folders needed.
        </p>
      ) : (
        <p style={{ marginTop: 0 }}>
          A static web app bundle (<code>index.html</code>, <code>assets/</code>, <code>wiki-data.js</code>) built for web servers (nginx, Cloudflare Pages, Netlify, GitHub Pages, or <b>Publish</b>). Needs an HTTP server — it does not open via double-click.
        </p>
      )}
      <label className="field"><span>Or save into a folder</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" value={folder} onChange={e => setFolder(e.target.value)} placeholder={mode === 'single' ? '/Users/me/Documents/Docs' : "/Users/me/Sites/my-docs (empty = Safe4wiki's exports folder)"} />
          <button type="button" className="btn" onClick={toFolder} disabled={busy || (mode === 'single' && !folder.trim())}>Save</button>
        </div>
      </label>
      {busy && <div className="progress"><div style={{ width: '65%' }} /></div>}
      {result && <div className="notice">Saved to <code>{result}</code></div>}
      {error && <div className="notice err">{error}</div>}
    </Dialog>
  );
}

const PUBLISH_METHODS = [
  ['ssh', 'My server (SSH / rsync)'],
  ['github', 'GitHub Pages'],
  ['cloudflare', 'Cloudflare Pages'],
  ['netlify', 'Netlify'],
  ['command', 'My own command'],
];

export function PublishDialog({ onClose, wiki }) {
  const app = useApp();
  const saved = app.settings?.publish || {};
  const [t, setT] = useState({ method: 'ssh', domain: '', ...saved });
  const [log, setLog] = useState([]);
  const [state, setState] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const logRef = useRef(null);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [log.length]);
  if (app.server === false) return <NeedsServer onClose={onClose} what="Publishing" />;
  const set = (k, v) => setT(x => ({ ...x, [k]: v }));
  const activeLabel = (PUBLISH_METHODS.find(([k]) => k === t.method) || PUBLISH_METHODS[0])[1];
  const field = (k, label, ph, type = 'text', hint) => (
    <label className="field"><span>{label}</span>
      <input className="input" type={type} autoComplete="off" value={t[k] || ''} onChange={e => set(k, e.target.value)} placeholder={ph} />
      {hint && <small>{hint}</small>}
    </label>
  );
  const publish = async () => {
    setLog([]); setState('running');
    try {
      await stream('/api/publish', { wiki: wikiPayload(wiki), target: t }, (type, data) => {
        if (type === 'log') setLog(l => [...l, data.message]);
        if (type === 'done') { setState('done'); setLog(l => [...l, data.url ? `Published: ${data.url}` : 'Published.']); }
        if (type === 'error') { setState('error'); setLog(l => [...l, `Error: ${data.message}`]); }
      });
      app.reloadSettings();
    } catch (err) { setState('error'); setLog(l => [...l, `Error: ${err.message}`]); }
  };
  return (
    <>
      <Dialog wide title="Publish to my subdomain" onClose={onClose} footer={<>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-blue" onClick={publish} disabled={state === 'running'}>{state === 'running' ? 'Publishing…' : 'Publish'}</button>
      </>}>
        <div className="publish-bar">
          <div className="seg">
            {PUBLISH_METHODS.map(([k, l]) => <button key={k} type="button" className={t.method === k ? 'on' : ''} onClick={() => set('method', k)}>{l}</button>)}
          </div>
          <button
            type="button"
            className="info-pill"
            onClick={() => setShowHelp(true)}
            title={`Setup guide for ${activeLabel}`}
            aria-label={`Setup guide for ${activeLabel}`}
          >
            <InfoIcon size={15} />
            <span>Setup guide</span>
          </button>
        </div>
        {field('domain', 'Subdomain', 'docs.mydomain.com', 'text', 'Point this name at the host (a CNAME record in your DNS). The site is built for the root of this address.')}
        {t.method === 'ssh' && (
          <>
            <div className="row">{field('host', 'Server', 'mydomain.com')}{field('user', 'User', 'deploy')}{field('port', 'Port', '22')}</div>
            {field('remotePath', 'Folder on the server', '/var/www/docs.mydomain.com', 'text', 'Uses your SSH key (ssh-agent / ~/.ssh). The folder’s old contents are replaced.')}
          </>
        )}
        {t.method === 'github' && (
          <>
            {field('repoUrl', 'Repository to publish into', 'git@github.com:me/docs-site.git')}
            <div className="row">{field('branch', 'Branch', 'gh-pages')}{field('token', 'Token (HTTPS only)', 'ghp_…', 'password')}</div>
            <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>A CNAME file for your subdomain is added. In the repository’s Pages settings, choose this branch.</p>
          </>
        )}
        {t.method === 'cloudflare' && (
          <div className="row">{field('project', 'Pages project name', 'my-docs')}{field('accountId', 'Account ID', '…')}{field('token', 'API token', '…', 'password')}</div>
        )}
        {t.method === 'netlify' && (
          <div className="row">{field('siteId', 'Site ID', '…')}{field('token', 'Personal access token', '…', 'password')}</div>
        )}
        {t.method === 'command' && field('command', 'Command', 'rsync -az --delete {dir}/ me@host:/var/www/docs/', 'text', '{dir} is replaced with the exported site folder.')}
        {(t.method === 'cloudflare' || t.method === 'netlify') && <p className="muted" style={{ fontSize: 13 }}>Add the subdomain under the project’s custom domains once; uses <code>npx</code> to run the official CLI.</p>}
        {log.length > 0 && <div className="log" ref={logRef}>{log.map((l, i) => <div key={i}>{l}</div>)}</div>}
      </Dialog>
      {showHelp && (
        <PublishHelpModal
          method={t.method}
          methods={PUBLISH_METHODS}
          target={t}
          onSelectMethod={m => set('method', m)}
          onClose={() => setShowHelp(false)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Edit a page                                                          */
/* ------------------------------------------------------------------ */

export function EditDialog({ onClose, wiki }) {
  const app = useApp();
  const ordered = useMemo(() => orderPages(wiki.pages || []), [wiki]);
  const page = safeDecodeSlug(window.location.pathname.split('/')[3]);
  const [path, setPath] = useState((ordered.find(p => p.slug === page) || ordered[0])?.path || '');
  const [op, setOp] = useState('modify');
  const [instruction, setInstruction] = useState('');
  const [log, setLog] = useState([]);
  const [state, setState] = useState('');
  const abortRef = useRef(null);
  const reloadTimerRef = useRef(null);

  useEffect(() => () => {
    if (abortRef.current) abortRef.current.abort();
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
  }, []);

  const handleClose = () => {
    if (abortRef.current) abortRef.current.abort();
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    onClose();
  };

  const run = async () => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState('running'); setLog([]);
    try {
      await stream(`${wikiApiPath(wiki.owner, wiki.repo)}/edit`, { path, op, instruction }, (type, data) => {
        if (controller.signal.aborted) return;
        if (type === 'event') { const line = describeEvent(data); if (line) setLog(l => [...l, line]); }
        if (type === 'done') {
          setState('done');
          reloadTimerRef.current = setTimeout(() => {
            if (!controller.signal.aborted) window.location.reload();
          }, 600);
        }
        if (type === 'error') { setState('error'); setLog(l => [...l, `Error: ${data.message}`]); }
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted && err?.name !== 'AbortError') {
        setState('error'); setLog(l => [...l, err.message]);
      }
    }
  };
  return (
    <Dialog title="Edit Wiki" onClose={handleClose} footer={<>
      <button type="button" className="btn" onClick={handleClose}>Cancel</button>
      <button type="button" className="btn btn-blue" onClick={run} disabled={!instruction.trim() || state === 'running'}>{state === 'running' ? 'Working…' : 'Apply'}</button>
    </>}>
      <label className="field"><span>Page</span>
        <select className="select" value={path} onChange={e => setPath(e.target.value)}>
          {ordered.map(p => <option key={p.path} value={p.path}>{p.num} {p.title}</option>)}
        </select>
      </label>
      <div className="seg">
        {[['modify', 'Change'], ['supplement', 'Add to it'], ['rewrite', 'Rewrite']].map(([k, l]) => <button key={k} type="button" className={op === k ? 'on' : ''} onClick={() => setOp(k)}>{l}</button>)}
      </div>
      <label className="field"><span>What should change?</span>
        <textarea className="textarea" value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="e.g. Add a sequence diagram of the login flow and explain the token refresh." />
      </label>
      <p className="muted" style={{ fontSize: 13 }}>Uses the default model ({app.settings?.default || 'none'}) and re-reads the files the page is based on.</p>
      {log.length > 0 && <div className="log">{log.map((l, i) => <div key={i}>{l}</div>)}</div>}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Delete wiki                                                         */
/* ------------------------------------------------------------------ */

export function DeleteDialog({ onClose, owner, repo, onDeleted }) {
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (app.server === false) return <NeedsServer onClose={onClose} what="Deleting a wiki" />;

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await api.del(wikiApiPath(owner, repo));
      app.showToast(`Deleted ${owner}/${repo}`);
      onClose();
      if (onDeleted) onDeleted();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Delete wiki" onClose={onClose} footer={<>
      <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className="btn btn-danger" onClick={confirm} disabled={busy}>{busy ? 'Deleting…' : 'Delete'}</button>
    </>}>
      <p style={{ marginTop: 0 }}>Remove the generated wiki for <strong>{owner}/{repo}</strong> from this computer?</p>
      <p className="muted" style={{ fontSize: 13 }}>For local folders, your original project files are never touched. For Git repositories, the local clone inside Safe4wiki’s data folder is removed too.</p>
      {error && <div className="notice err">{error}</div>}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

export function DialogHost() {
  const app = useApp();
  if (!app.dialog) return null;
  const { type, props } = app.dialog;
  const close = app.closeDialog;
  if (type === 'settings') return <SettingsDialog onClose={close} {...props} />;
  if (type === 'add') return <AddRepoDialog onClose={close} {...props} />;
  if (type === 'delete') return <DeleteDialog onClose={close} {...props} />;
  if (!props.wiki || !props.wiki.pages) {
    return <Dialog title="Not available" onClose={close}><p>Open a wiki first.</p></Dialog>;
  }
  if (type === 'pdf') return <PdfDialog onClose={close} {...props} />;
  if (type === 'html') return <HtmlDialog onClose={close} {...props} />;
  if (type === 'publish') return <PublishDialog onClose={close} {...props} />;
  if (type === 'edit') return <EditDialog onClose={close} {...props} />;
  return null;
}

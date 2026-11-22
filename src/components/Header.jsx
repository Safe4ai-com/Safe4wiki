import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../lib/context';
import { GearIcon, MoonIcon, PencilIcon, ShareIcon, SunIcon, DownloadIcon, GlobeIcon, LinkIcon, FileIcon, SparkleIcon, TrashIcon } from './Icons.jsx';

export function useOutside(ref, onOutside, active) {
  useEffect(() => {
    if (!active) return undefined;
    const handler = e => { if (ref.current && !ref.current.contains(e.target)) onOutside(); };
    const esc = e => { if (e.key === 'Escape') onOutside(); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', esc); };
  }, [ref, onOutside, active]);
}

function ShareMenu({ wiki, canDelete, onDeleted }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      app.showToast('Link copied');
    } catch {
      app.showToast('Copy the address from your browser to share this page.');
    }
    setOpen(false);
  };
  const pick = (type, extra = {}) => { setOpen(false); app.openDialog(type, { wiki, ...extra }); };
  const hasPages = Boolean(wiki && Array.isArray(wiki.pages) && wiki.pages.length > 0);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="btn share-btn" onClick={() => setOpen(o => !o)} aria-label="Share" aria-haspopup="menu" aria-expanded={open}>
        <ShareIcon />
        <span>Share</span>
      </button>
      {open && (
        <div className="menu" role="menu" style={{ right: 0, top: 40 }}>
          {hasPages && (
            <>
              <button type="button" role="menuitem" onClick={() => pick('pdf')}>
                <FileIcon /><span>Export to PDF<span className="hint">Every page, diagrams and sources, with a cover and contents</span></span>
              </button>
              <button type="button" role="menuitem" onClick={() => pick('html')}>
                <DownloadIcon /><span>Export to HTML<span className="hint">Single offline .html file (double-click to open) or hosting bundle</span></span>
              </button>
              <button type="button" role="menuitem" onClick={() => pick('publish')}>
                <GlobeIcon /><span>Publish to my subdomain<span className="hint">SSH/rsync, GitHub Pages, Cloudflare, Netlify or your own command</span></span>
              </button>
              <div className="menu-sep" />
            </>
          )}
          <button type="button" role="menuitem" onClick={copyLink}><LinkIcon /><span>Copy link</span></button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); app.openDialog('settings'); }}><GearIcon /><span>Model settings<span className="hint">Local model, OpenAI-compatible API or an agent CLI</span></span></button>
          {canDelete && wiki && (
            <>
              <div className="menu-sep" />
              <button type="button" role="menuitem" className="danger" onClick={() => pick('delete', { owner: wiki.owner, repo: wiki.repo, onDeleted })}>
                <TrashIcon size={16} /><span>Delete wiki<span className="hint">Remove this generated wiki from Safe4wiki</span></span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ProfileSpecs({ label, name, profile, onConfigure }) {
  if (!name || !profile) {
    return (
      <div className="model-pop-sec">
        <div className="model-pop-label">{label}</div>
        <div className="muted" style={{ fontSize: 12 }}>Not configured</div>
      </div>
    );
  }
  const rows = [
    ['Provider', profile.provider],
    profile.model ? ['Model', profile.model] : null,
    profile.command ? ['Command', [profile.command, ...(profile.args || [])].join(' ')] : null,
    profile.baseUrl ? ['Endpoint', profile.baseUrl] : null,
    profile.modelPath ? ['GGUF file', String(profile.modelPath).split('/').pop()] : null,
    profile.contextChars ? ['Code context / page', `${Number(profile.contextChars).toLocaleString()} chars (~${Math.max(1, Math.round(Number(profile.contextChars) / 4000))}k tok)`] : null,
    profile.contextSize ? ['Context window', `${profile.contextSize} tok`] : null,
    profile.maxTokens ? ['Max tokens', String(profile.maxTokens)] : null,
    profile.think !== undefined ? ['Thinking', String(profile.think)] : null,
    profile.temperature !== undefined ? ['Temperature', String(profile.temperature)] : null,
    profile.concurrency ? ['Parallel pages', String(profile.concurrency)] : null,
  ].filter(Boolean);
  return (
    <div className="model-pop-sec">
      <div className="model-pop-head">
        <span className="model-pop-label">{label}</span>
        <button type="button" className="inline-link" style={{ fontSize: 12 }} onClick={() => onConfigure(name)}>Edit</button>
      </div>
      <div className="model-pop-name">{name}</div>
      <dl className="model-kv">
        {rows.map(([k, v]) => (
          <div key={k} className="model-kv-row"><dt>{k}</dt><dd title={v}>{v}</dd></div>
        ))}
      </dl>
    </div>
  );
}

function ActiveModelMenu() {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useOutside(ref, () => setOpen(false), open);
  const settings = app.settings;
  if (!app.server || !settings) return null;
  const wikiName = settings.default || '';
  const wikiProfile = wikiName ? settings.models?.[wikiName] : null;
  const chatName = settings.chatModel || wikiName;
  const chatProfile = chatName ? settings.models?.[chatName] : null;
  const shortId = wikiProfile?.model || wikiProfile?.command || wikiName || 'No model';
  const pillText = wikiName && shortId !== wikiName ? `${wikiName} · ${shortId}` : shortId;
  const openInSettings = name => { setOpen(false); app.openDialog('settings', { initialModel: name }); };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        className="btn model-pill-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Inspect active models and parameters"
      >
        <span className="model-dot" aria-hidden="true" />
        <span className="model-pill-text">{pillText}</span>
      </button>
      {open && (
        <div className="menu model-pop" role="dialog" aria-label="Active models and parameters">
          <ProfileSpecs label="Wiki generation" name={wikiName} profile={wikiProfile} onConfigure={openInSettings} />
          <div className="menu-sep" />
          <ProfileSpecs label={settings.chatModel ? 'RAG Chat' : 'RAG Chat (same as wiki)'} name={chatName} profile={chatProfile} onConfigure={openInSettings} />
          <div className="menu-sep" />
          <div className="model-pop-sec">
            <div className="model-pop-head">
              <span className="model-pop-label">Embeddings</span>
              <button type="button" className="inline-link" style={{ fontSize: 12 }} onClick={() => { setOpen(false); app.openDialog('settings', { initialTab: 'chat' }); }}>Edit</button>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              {settings.embedding?.enabled ? `${settings.embedding.model || 'enabled'} @ ${settings.embedding.baseUrl || ''}` : 'Disabled (BM25 keyword search only)'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Header({ wiki, canEdit, canDelete, onDeleted }) {
  const app = useApp();
  const exported = !!app.exported;
  const repoLabel = wiki ? `${wiki.owner}/${wiki.repo}` : null;
  const openSettings = () => app.openDialog('settings');
  const openAdd = () => app.openDialog('add');
  const themeLabel = app.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  return (
    <>
      {!exported && (
        <button type="button" className="top-banner" onClick={openAdd} aria-label="Add repository and choose a model">
          <SparkleIcon size={12} /> <span>Index your code with Local AI</span>
        </button>
      )}
      <header className="header">
        <div className="header-left">
          <Link to={exported && wiki ? `/${wiki.owner}/${wiki.repo}` : '/'} className="logo">
            <img
              className="logo-img"
              src={app.theme === 'dark' ? '/brand/logo-monogram-white.svg' : '/brand/logo-monogram-gold.svg'}
              alt=""
              aria-hidden="true"
            />
            <span>Safe4wiki</span>
          </Link>
          {repoLabel && (
            <p className="header-repo"><Link to={`/${wiki.owner}/${wiki.repo}`} title={repoLabel}>{repoLabel}</Link></p>
          )}
        </div>
        <div className="header-right">
          {!exported && <ActiveModelMenu />}
          {!exported && (
            <button type="button" className="index-btn" onClick={openAdd} aria-label="Add a repository and choose a model" title="Add a repository and choose a model">
              <span className="index-lead">Index your code with</span>
              <span className="index-brand"><SparkleIcon size={16} /> AI</span>
            </button>
          )}
          {!exported && (
            <button type="button" className="btn settings-btn" onClick={openSettings} aria-label="Model settings" title="Models, API keys, Agent CLI and wiki defaults">
              <GearIcon />
              <span className="settings-label">Settings</span>
            </button>
          )}
          {wiki && !exported && (
            <button type="button" className="btn edit-wiki-btn" onClick={() => (canEdit ? app.openDialog('edit', { wiki }) : app.showToast('Generate this wiki on your computer first, then you can edit its pages with your model.'))} aria-disabled={!canEdit} aria-label="Edit wiki"
              title={canEdit ? 'Change a page with your model' : 'Generate this wiki locally to edit it'}>
              <PencilIcon />
              <span className="edit-label">Edit Wiki</span>
            </button>
          )}
          <ShareMenu wiki={wiki} canDelete={canDelete} onDeleted={onDeleted} />
          <button type="button" className="icon-btn" onClick={app.toggleTheme} aria-label={themeLabel} title={themeLabel}>
            {app.theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          </button>
        </div>
      </header>
    </>
  );
}

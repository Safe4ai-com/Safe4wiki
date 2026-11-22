import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import Header from '../components/Header.jsx';
import Markdown from '../components/Markdown.jsx';
import ChatBox from '../components/ChatBox.jsx';
import Conversation from '../components/Conversation.jsx';
import GenerationStatus from '../components/GenerationStatus.jsx';
import { ChevronRight, FileIcon, XIcon, RefreshIcon } from '../components/Icons.jsx';
import { useApp } from '../lib/context';
import { api, wikiApiPath } from '../lib/api.js';
import { findPage, formatDate, makeLinkResolver, orderPages } from '../lib/wiki.js';
import { findDemo } from '../data/demos/index.js';

/** Loads a wiki from the local server, the exported site data or the samples. */
export function useWiki(owner, repo) {
  const app = useApp();
  const [state, setState] = useState({ loading: true });
  const reload = useCallback(async () => {
    if (app.exported) {
      setState({ loading: false, wiki: window.__RW_DATA__ || null, origin: 'export' });
      return;
    }
    if (app.server === null) return;
    if (app.server) {
      try {
        const res = await api.get(wikiApiPath(owner, repo));
        if (res && res.wiki) { setState({ loading: false, wiki: res.wiki, status: res.status, job: res.job, origin: 'local' }); return; }
        if (res && res.status) { setState({ loading: false, wiki: null, status: res.status, job: res.job, origin: 'local' }); return; }
      } catch (err) {
        if (err.status !== 404) { setState({ loading: false, error: err.message }); return; }
      }
    }
    const demo = findDemo(owner, repo);
    setState({ loading: false, wiki: demo, origin: demo ? 'sample' : null });
  }, [app.exported, app.server, owner, repo]);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

function Sidebar({ ordered, current, base, wiki, onPick }) {
  const shortCommit = wiki.commit && String(wiki.commit).slice(0, wiki.sample ? 6 : 7);
  const indexedDate = formatDate(wiki.lastIndexed);
  return (
    <>
      <div className="last-indexed">
        Last indexed: {indexedDate ? <time dateTime={wiki.lastIndexed}>{indexedDate}</time> : '—'}
        {shortCommit ? <> (<a href={wiki.source?.type === 'github' ? `${wiki.source.url}/commit/${wiki.commit}` : undefined} target="_blank" rel="noopener noreferrer">{shortCommit}</a>)</> : null}
      </div>
      <ul className="nav-list">
        {ordered.map(p => (
          <li key={p.slug}>
            <Link
              to={`${base}/${p.slug}`}
              className={`nav-item${current && current.slug === p.slug ? ' active' : ''}`}
              aria-current={current?.slug === p.slug ? 'page' : undefined}
              style={{ marginLeft: p.depth * 12, width: `calc(100% - ${p.depth * 12}px)` }}
              onClick={onPick}
            >
              {p.title}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function Toc({ headings, activeId, repositoryReadme, onRefresh, refreshLabel, refreshHint }) {
  const [dismissed, setDismissed] = useState(false);
  const minDepth = Math.min(...headings.map(h => h.depth), 1);
  return (
    <aside className="toc" aria-label="On this page">
      {repositoryReadme && (
        <a className="repository-note" href={repositoryReadme} target="_blank" rel="noopener noreferrer">
          <FileIcon size={16} />
          <span>Read the project documentation on GitHub</span>
        </a>
      )}
      {!dismissed && onRefresh && (
        <div className="refresh-box" style={{ margin: '0 16px 16px' }}>
          <button type="button" className="dismiss" onClick={() => setDismissed(true)} aria-label="Dismiss"><XIcon size={14} /></button>
          <div className="title">Refresh this wiki</div>
          {refreshHint && <div className="sub">{refreshHint}</div>}
          <button type="button" className="refresh-btn" onClick={onRefresh}><RefreshIcon />{refreshLabel}</button>
        </div>
      )}
      <h3 className="toc-title">On this page</h3>
      <ul className="toc-list">
        {headings.map(h => (
          <li key={h.id}>
            <a href={`#${h.id}`} className={activeId === h.id ? 'active' : ''} style={{ paddingLeft: (h.depth - minDepth) * 12 }}>{h.text}</a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function useScrollSpy(headings) {
  const [active, setActive] = useState(headings[0]?.id || '');
  useEffect(() => {
    setActive(headings[0]?.id || '');
    if (!headings.length) return undefined;
    const onScroll = () => {
      let current = headings[0].id;
      for (const h of headings) {
        const el = document.getElementById(h.id);
        if (el && el.getBoundingClientRect().top < 140) current = h.id;
      }
      setActive(current);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, [headings]);
  return active;
}

function NotGenerated({ owner, repo }) {
  const app = useApp();
  return (
    <div className="gen-card">
      <h1>{owner}/{repo}</h1>
      <p className="muted" style={{ fontSize: 14.8 }}>There is no wiki for this repository on this computer yet.</p>
      {app.server ? (
        <>
          <p style={{ fontSize: 14.8 }}>Safe4wiki can clone it and write the wiki with your model. Public repositories need nothing else; private ones need an access token or an SSH key.</p>
          <button type="button" className="btn btn-blue" onClick={() => app.openDialog('add', { prefill: { kind: 'git', url: `https://github.com/${owner}/${repo}` } })}>Generate wiki</button>
        </>
      ) : (
        <div className="notice">To generate wikis, start the Safe4wiki app on your computer (it runs the local server and opens this page). These pages alone only show the samples.</div>
      )}
    </div>
  );
}

/** The conversation for one wiki, kept while the browser tab is open. */
function loadChat(key) {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
    if (saved && Array.isArray(saved.turns)) {
      return {
        open: !!saved.open,
        turns: saved.turns.map(t => (t.status === 'done' || t.status === 'error' ? t
          : { ...t, status: 'error', error: 'This answer was interrupted when the page was closed. Press “Ask again”.' })),
      };
    }
  } catch { /* ignore */ }
  return { open: false, turns: [] };
}

export default function WikiPage() {
  const { owner, repo, page: pageSlug } = useParams();
  const app = useApp();
  const navigate = useNavigate();
  const { loading, wiki, status, job, origin, error, reload } = useWiki(owner, repo);
  const [headings, setHeadings] = useState([]);
  const chatKey = `rw-chat:${owner}/${repo}`;
  const [chat, setChat] = useState(() => loadChat(chatKey));
  const [mode, setMode] = useState('fast');
  const [model, setModel] = useState('');
  const menuRef = useRef(null);

  const base = `/${owner}/${repo}`;
  const ordered = useMemo(() => (wiki ? orderPages(wiki.pages || []) : []), [wiki]);
  const current = useMemo(() => findPage(ordered, pageSlug), [ordered, pageSlug]);
  const resolveLink = useMemo(() => makeLinkResolver(ordered, current, base), [ordered, current, base]);
  const activeId = useScrollSpy(headings);

  useEffect(() => {
    if (wiki && current) document.title = `${current.title} | ${wiki.owner}/${wiki.repo} | Safe4wiki`;
    else document.title = `${owner}/${repo} | Safe4wiki`;
  }, [wiki, current, owner, repo]);

  useEffect(() => { window.scrollTo(0, 0); }, [pageSlug]);
  useEffect(() => { setChat(loadChat(chatKey)); }, [chatKey]);
  useEffect(() => {
    try { sessionStorage.setItem(chatKey, JSON.stringify(chat)); } catch { /* storage full or blocked */ }
  }, [chat, chatKey]);
  useEffect(() => {
    if (window.location.hash) {
      const el = document.getElementById(decodeURIComponent(window.location.hash.slice(1)));
      if (el) setTimeout(() => el.scrollIntoView(), 60);
    }
  }, [current, headings]);

  const canEdit = !!(app.server && origin === 'local' && wiki);
  const canDelete = !!(app.server && origin === 'local');

  const defaultModelName = app.settings?.default || '';
  const defaultModelId = defaultModelName ? (app.settings?.models?.[defaultModelName]?.model || app.settings?.models?.[defaultModelName]?.command || '') : '';
  const defaultModelLabel = defaultModelName
    ? (defaultModelId && defaultModelId !== defaultModelName ? `${defaultModelName} (${defaultModelId})` : defaultModelName)
    : '';

  const onRefresh = !app.exported
    ? () => (origin === 'local' && app.server
      ? api.post(`${wikiApiPath(owner, repo)}/refresh`, { model: defaultModelName || undefined }).then(reload).catch(e => app.showToast(e.message))
      : app.openDialog('add', { prefill: { kind: 'git', url: `https://github.com/${owner}/${repo}` } }))
    : null;

  const ask = (q, files = []) => {
    setChat(c => ({ open: true, turns: [...c.turns, { id: Date.now(), q, mode, model, files }] }));
  };
  const closeChat = useCallback(() => setChat(c => ({ ...c, open: false })), []);

  let main;
  if (loading) main = <div className="wiki-content muted" style={{ fontSize: 14 }}>Loading…</div>;
  else if (error) main = <div className="wiki-content"><div className="notice err">{error}</div></div>;
  else if (status === 'generating' || status === 'queued' || (status === 'failed' && !wiki)) {
    main = <GenerationStatus owner={owner} repo={repo} job={job} status={status} onDone={reload} onDeleted={() => navigate('/')} />;
  } else if (!wiki) main = <NotGenerated owner={owner} repo={repo} />;
  else if (current) {
    main = (
      <div className="wiki-content">
        {status === 'failed' && (
          <div className="notice warn partial-banner">
            <div>
              <strong>Showing {ordered.length} generated page{ordered.length === 1 ? '' : 's'} so far.</strong>{' '}
              {job?.error || 'The last run stopped before finishing all pages.'}
            </div>
            <div className="partial-actions">
              {onRefresh && (
                <button type="button" className="btn btn-blue" onClick={onRefresh}>Continue generating</button>
              )}
              {app.server && origin === 'local' && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => api.post(`${wikiApiPath(owner, repo)}/open-log`, {}).then(() => app.showToast('Opened log in Terminal')).catch(e => app.showToast(e.message))}
                >
                  Open log
                </button>
              )}
            </div>
          </div>
        )}
        <Markdown
          key={current.slug}
          markdown={current.markdown}
          source={wiki.source}
          resolveLink={resolveLink}
          onHeadings={setHeadings}
          onNavigate={href => navigate(href)}
        />
      </div>
    );
  }

  const showNav = wiki && ordered.length > 0;
  return (
    <div className={`frame page-wiki${chat.open ? ' assistant-open' : ''}`}>
      <Header wiki={wiki || { owner, repo }} canEdit={canEdit} canDelete={canDelete} onDeleted={() => navigate('/')} />
      {showNav && (
        <details className="mobile-menu" ref={menuRef}>
          <summary><ChevronRight />Menu</summary>
          <Sidebar ordered={ordered} current={current} base={base} wiki={wiki} onPick={() => menuRef.current?.removeAttribute('open')} />
        </details>
      )}
      <div className="wiki-body">
        {showNav && (
          <nav className="sidebar" aria-label="Wiki pages">
            <Sidebar ordered={ordered} current={current} base={base} wiki={wiki} />
            <div className="sidebar-brand">
              <a href="https://safe4ai.com" target="_blank" rel="noopener noreferrer" aria-label="Safe4ai">
                <img
                  className="brand-wordmark-sm"
                  src={app.theme === 'dark' ? '/brand/logo-horizontal-ondark.svg' : '/brand/logo-horizontal-onlight.svg'}
                  alt="Safe4ai"
                />
              </a>
            </div>
          </nav>
        )}
        <main className="wiki-main">{main}</main>
        {showNav && (
          <Toc
            headings={headings}
            activeId={activeId}
            repositoryReadme={wiki.repositoryReadme}
            onRefresh={onRefresh}
            refreshLabel={origin === 'local' ? 'Regenerate now' : 'Generate locally'}
            refreshHint={origin === 'local' ? `Updates changed pages${defaultModelLabel ? ` with ${defaultModelLabel}` : ''}` : ''}
          />
        )}
      </div>
      {wiki && !chat.open && (
        <ChatBox
          repoLabel={`${owner}/${repo}`}
          onAsk={ask}
          busy={false}
          mode={mode}
          setMode={setMode}
          model={model}
          setModel={setModel}
          turnCount={chat.turns.length}
          onOpenChat={() => setChat(c => ({ ...c, open: true }))}
        />
      )}
      {wiki && chat.open && (
        <Conversation
          wiki={wiki}
          origin={origin}
          turns={chat.turns}
          setTurns={turns => setChat(c => ({ ...c, turns: typeof turns === 'function' ? turns(c.turns) : turns }))}
          onClose={closeChat}
          resolveLink={resolveLink}
          onNavigate={href => navigate(href)}
          pages={ordered}
          base={base}
          onAsk={ask}
          mode={mode}
          setMode={setMode}
          model={model}
          setModel={setModel}
        />
      )}
    </div>
  );
}

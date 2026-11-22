import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Header from '../components/Header.jsx';
import { ArrowRight, PlusIcon, SearchIcon, StarIcon, TrashIcon } from '../components/Icons.jsx';
import { useApp } from '../lib/context';
import { api } from '../lib/api.js';
import { demoWikis } from '../data/demos/index.js';

function parseRepoInput(text) {
  const t = text.trim();
  if (!t) return null;
  const gh = t.match(/^(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org)\/([^/\s]+)\/([^/\s#?]+)/i);
  if (gh) return { kind: 'git', url: `https://${gh[1]}/${gh[2]}/${gh[3].replace(/\.git$/, '')}`, owner: gh[2], repo: gh[3].replace(/\.git$/, '') };
  if (/^(git@|ssh:\/\/|https?:\/\/).+/.test(t)) return { kind: 'git', url: t };
  if (/^(\/|~\/|[A-Za-z]:\\)/.test(t)) return { kind: 'local', path: t };
  return null;
}

function RepoCard({ owner, repo, description, stars, badge, onDelete }) {
  return (
    <article className="repo-card repo-card-item">
      <div className="repo-card-top">
        <div className="repo-card-name">
          <Link className="repo-card-link" to={`/${owner}/${repo}`}>
            <span className="repo-card-owner">{owner}</span><span className="repo-card-separator">/</span>
            <span className="repo-card-title">{repo}</span>
          </Link>
        </div>
        {onDelete && (
          <button
            type="button"
            className="repo-card-delete"
            aria-label={`Delete ${owner}/${repo}`}
            title={`Delete ${owner}/${repo}`}
            onClick={onDelete}
          >
            <TrashIcon size={15} />
          </button>
        )}
      </div>
      {description ? <p className="repo-card-desc">{description}</p> : null}
      <div className="repo-card-foot">
        <span className="repo-card-stars">
          {stars ? (<><StarIcon />{stars}</>) : badge ? <span className="repo-card-badge">{badge}</span> : null}
        </span>
        <span className="circle-arrow" aria-hidden="true"><ArrowRight /></span>
      </div>
    </article>
  );
}

export default function Home() {
  const app = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [mine, setMine] = useState([]);
  const [tab, setTab] = useState('mine');

  useEffect(() => { document.title = 'Safe4wiki | Local documentation you can talk to'; }, []);

  const loadMine = useCallback(() => {
    if (!app.server) return;
    api.get('/api/wikis').then(r => setMine(r.wikis || [])).catch(() => {});
  }, [app.server]);

  useEffect(() => {
    if (!app.server) return undefined;
    loadMine();
    const t = setInterval(loadMine, 8000);
    return () => clearInterval(t);
  }, [app.server, loadMine]);

  useEffect(() => {
    if (app.server === false) setTab('examples');
  }, [app.server]);

  const myCards = useMemo(() => mine.map(w => ({
    owner: w.owner,
    repo: w.repo,
    description: w.description,
    badge: w.status === 'generating' || w.status === 'queued'
      ? 'Generating…'
      : w.status === 'failed'
        ? 'Failed'
        : w.source?.type === 'local'
          ? 'Local'
          : 'Git',
    stars: '',
    isLocal: true,
  })), [mine]);

  const exampleCards = useMemo(() => demoWikis.map(d => ({
    owner: d.owner,
    repo: d.repo,
    description: d.description,
    stars: d.stars,
    isLocal: false,
  })), []);

  const activeCards = tab === 'examples' ? exampleCards : myCards;

  const parsed = parseRepoInput(query);
  const q = query.trim().toLowerCase();
  const isFiltering = Boolean(q && !parsed);
  const filtered = isFiltering
    ? [...myCards, ...exampleCards].filter(c => `${c.owner}/${c.repo} ${c.description || ''}`.toLowerCase().includes(q))
    : activeCards;

  const addRepo = () => {
    const prefill = parsed?.kind === 'git' ? { kind: 'git', url: parsed.url }
      : parsed?.kind === 'local' ? { kind: 'local', path: parsed.path } : {};
    app.openDialog('add', { prefill });
  };
  const onSubmit = e => {
    e.preventDefault();
    if (parsed) addRepo();
    else if (filtered.length === 1) navigate(`/${filtered[0].owner}/${filtered[0].repo}`);
  };
  const openDelete = card => () => app.openDialog('delete', { owner: card.owner, repo: card.repo, onDeleted: loadMine });

  return (
    <div className="frame page-home">
      <Header />
      <main className="home-main">
        <section className="home-intro" aria-labelledby="home-title">
          <h1 className="home-title" id="home-title">Which repo would you like to understand?</h1>
          <form className="search-wrap" onSubmit={onSubmit} role="search">
            <SearchIcon />
            <input
              className="search-input"
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search your wikis, or paste a Git URL / local folder path"
              aria-label="Search your wikis, or paste a Git link or a local folder path"
            />
          </form>
        </section>
        <section className="repo-library" aria-label={isFiltering ? 'Search results' : 'Repository library'}>
          {!isFiltering && (
            <div className="home-tabs">
              <div className="seg" role="tablist" aria-label="Wiki collections">
                <button type="button" role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>
                  My wikis{myCards.length > 0 ? ` (${myCards.length})` : ''}
                </button>
                <button type="button" role="tab" aria-selected={tab === 'examples'} className={tab === 'examples' ? 'on' : ''} onClick={() => setTab('examples')}>
                  Examples ({exampleCards.length})
                </button>
              </div>
            </div>
          )}
          {isFiltering && <h2 className="repo-library-heading">Search results</h2>}
          <div className="repo-grid">
            {!isFiltering && tab === 'mine' && (
              <button type="button" className="repo-card repo-card-add" onClick={addRepo}>
                <span className="repo-add-mark"><PlusIcon size={20} /></span>
                <span className="repo-add-row">
                  <span className="repo-add-title">Add repo</span>
                </span>
                <span className="repo-add-foot"><span className="circle-arrow"><ArrowRight /></span></span>
              </button>
            )}
            {filtered.map(c => (
              <RepoCard
                key={`${c.isLocal ? 'local' : 'demo'}:${c.owner}/${c.repo}`}
                {...c}
                onDelete={c.isLocal ? openDelete(c) : null}
              />
            ))}
          </div>
          {!isFiltering && tab === 'mine' && myCards.length === 0 && (
            <p className="empty-note">
              No local wikis yet. Click <strong>Add repo</strong> to index a local folder or Git repository, or open{' '}
              <button type="button" className="inline-link" onClick={() => app.openDialog('settings')}>Settings</button> to configure your model first.
            </p>
          )}
          {isFiltering && !filtered.length && (
            <p className="empty-note">No repository matches “{query}”. Paste a Git link or a folder path to add it.</p>
          )}
        </section>
        <section className="home-about" id="about-safe4wiki" tabIndex={-1}>
          <h2>What is Safe4wiki?</h2>
          <p>Safe4wiki indexes local folders and private or public Git repositories on your own computer. It works with a local model (Ollama, LM Studio, llama.cpp, or a .gguf file), an OpenAI-compatible or Anthropic API, or a coding agent CLI such as Claude Code, Codex, or Gemini.</p>
          <ul>
            <li>Export the whole wiki to a formatted PDF with every diagram, or to a static website you can publish on your own subdomain.</li>
            <li>Ask questions about the documentation and the code in the chat box; answers cite the exact files and lines.</li>
            <li>Switch to the <strong>Examples</strong> tab to inspect four sample wikis and see the output format.</li>
          </ul>
        </section>
        <footer className="brand-footer">
          <span>Open-source project by</span>
          <a href="https://safe4ai.com" target="_blank" rel="noopener noreferrer" aria-label="Safe4ai">
            <img
              className="brand-wordmark"
              src={app.theme === 'dark' ? '/brand/logo-horizontal-ondark.svg' : '/brand/logo-horizontal-onlight.svg'}
              alt="Safe4ai"
            />
          </a>
        </footer>
      </main>
    </div>
  );
}

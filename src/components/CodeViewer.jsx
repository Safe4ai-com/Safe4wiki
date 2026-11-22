import { useEffect, useMemo, useRef, useState } from 'react';
import { api, wikiApiPath } from '../lib/api.js';
import { sourceHref } from '../lib/wiki.js';
import { CheckIcon, CopyIcon } from './Icons.jsx';

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default',
  'delete', 'do', 'elif', 'else', 'enum', 'except', 'export', 'extends', 'false', 'finally',
  'fn', 'for', 'from', 'func', 'function', 'if', 'impl', 'import', 'in', 'interface', 'is',
  'lambda', 'let', 'match', 'new', 'nil', 'none', 'None', 'not', 'null', 'of', 'or', 'package',
  'pass', 'private', 'pub', 'public', 'raise', 'readonly', 'return', 'self', 'static', 'struct',
  'super', 'switch', 'this', 'throw', 'true', 'True', 'False', 'try', 'type', 'typeof',
  'undefined', 'use', 'var', 'void', 'while', 'with', 'yield',
]);

const EXT_BADGE = {
  js: 'JS', mjs: 'JS', cjs: 'JS', jsx: 'JSX', ts: 'TS', tsx: 'TSX',
  py: 'PY', json: 'JSON', yml: 'YAML', yaml: 'YAML', md: 'MD',
  sh: 'SH', bash: 'SH', zsh: 'SH', css: 'CSS', scss: 'CSS', html: 'HTML',
  sql: 'SQL', go: 'GO', rs: 'RS', java: 'JAVA', rb: 'RB', php: 'PHP',
};

const TOKEN_RE = /(\/\/.*$|#.*$|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

const CODE_LANG_EXTS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'pyi', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'bash', 'zsh', 'sql', 'json',
  'yml', 'yaml', 'toml', 'css', 'scss', 'html', 'xml', 'vue', 'svelte', 'graphql', 'proto',
]);

/** Lightweight per-line syntax highlighter (only for actual code/config files, not prose .md/.txt). */
function highlightLine(line, ext) {
  if (!line) return '\u00a0';
  if (!CODE_LANG_EXTS.has(ext)) {
    if ((ext === 'md' || ext === 'mdx') && /^\s*#{1,6}\s/.test(line)) {
      return <span className="tok-fn">{line}</span>;
    }
    return line;
  }
  const isHashCommentLang = ['py', 'pyi', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml', 'rb', 'conf'].includes(ext);
  const parts = [];
  let last = 0;
  let idx = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    const tok = m[0];
    let cls = '';
    if (tok.startsWith('//') || (tok.startsWith('#') && isHashCommentLang)) {
      cls = 'tok-com';
    } else if (tok.startsWith("'") || tok.startsWith('"') || tok.startsWith('`')) {
      cls = 'tok-str';
    } else if (/^\d/.test(tok)) {
      cls = 'tok-num';
    } else if (KEYWORDS.has(tok)) {
      cls = 'tok-kw';
    } else if (/^[A-Z][A-Za-z0-9_]*$/.test(tok)) {
      cls = 'tok-type';
    } else if (line[m.index + tok.length] === '(') {
      cls = 'tok-fn';
    }
    if (cls) parts.push(<span key={idx++} className={cls}>{tok}</span>);
    else parts.push(tok);
    last = m.index + tok.length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

const SKELETON_WIDTHS = [62, 64, 82, 54, 74, 42, 40, 44, 28, 16, 70, 58, 48, 66, 36];

export function CodeSkeleton() {
  return (
    <div className="cv-shell cv-skeleton" aria-hidden="true">
      <div className="cv-head">
        <div className="shimmer-bar" style={{ width: 180, height: 14 }} />
      </div>
      <div className="cv-skel-body">
        {SKELETON_WIDTHS.map((w, i) => (
          <div key={i} className="shimmer-bar" style={{ width: `${w}%`, animationDelay: `${i * 45}ms` }} />
        ))}
      </div>
    </div>
  );
}

export default function CodeViewer({ wiki, origin, activeRef, availableRefs = [], onSelectRef, onClose, loading }) {
  const [fileData, setFileData] = useState(null);
  const [fetchError, setFetchError] = useState('');
  const [fetching, setFetching] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef(null);
  const cacheRef = useRef(new Map());

  const filePath = activeRef?.file || '';
  const startLine = Number(activeRef?.start) || null;
  const endLine = Number(activeRef?.end) || startLine;

  useEffect(() => {
    setFetchError('');
    if (!filePath || origin !== 'local') {
      setFileData(null);
      return undefined;
    }
    const cacheKey = `${wiki.owner}/${wiki.repo}:${filePath}`;
    if (cacheRef.current.has(cacheKey)) {
      setFileData(cacheRef.current.get(cacheKey));
      return undefined;
    }
    let cancelled = false;
    setFetching(true);
    api.get(`${wikiApiPath(wiki.owner, wiki.repo)}/file?path=${encodeURIComponent(filePath)}`)
      .then(data => {
        if (cancelled) return;
        cacheRef.current.set(cacheKey, data);
        setFileData(data);
        setFetching(false);
      })
      .catch(err => {
        if (cancelled) return;
        setFetchError(err.message);
        setFileData(null);
        setFetching(false);
      });
    return () => { cancelled = true; };
  }, [filePath, origin, wiki.owner, wiki.repo]);

  const lines = useMemo(() => {
    if (fileData?.content !== undefined) {
      return { offset: 1, rows: fileData.content.split('\n') };
    }
    if (activeRef?.snippet) {
      return { offset: startLine || 1, rows: String(activeRef.snippet).split('\n') };
    }
    return null;
  }, [fileData, activeRef?.snippet, startLine]);

  // Smoothly scroll the cited line range into view
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !startLine || !lines) return;
    const targetLine = Math.max(lines.offset, startLine - 3);
    const row = el.querySelector(`[data-line="${targetLine}"]`) || el.querySelector(`[data-line="${startLine}"]`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [filePath, startLine, endLine, lines]);

  if (!filePath) {
    if (loading) return <CodeSkeleton />;
    return (
      <div className="cv-shell cv-empty">
        <div className="cv-empty-inner">
          <div className="cv-empty-title">Live code inspector</div>
          <p className="muted">Click any file citation in the answer (e.g. <code>file.js 10–24</code>) to inspect the exact lines of code here.</p>
        </div>
      </div>
    );
  }

  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const badge = EXT_BADGE[ext] || ext.toUpperCase().slice(0, 4) || 'TXT';
  const extHref = sourceHref(wiki.source, filePath, startLine, endLine);
  const fileName = filePath.split('/').pop();
  const dirPart = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';

  const copyCode = () => {
    const text = fileData?.content || activeRef?.snippet || '';
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  // Deduplicate available refs by file for clean switcher tabs
  const uniqueFiles = [];
  const seen = new Set();
  for (const r of availableRefs) {
    if (!r?.file || seen.has(r.file)) continue;
    seen.add(r.file);
    uniqueFiles.push(r);
  }

  return (
    <div className="cv-shell">
      <div className="cv-head">
        <span className="cv-badge">{badge}</span>
        <div className="cv-path" title={filePath}>
          <span className="cv-dir">{dirPart ? `${dirPart}/` : `${wiki.owner}/${wiki.repo}/`}</span>
          <span className="cv-file">{fileName}</span>
        </div>
        {startLine && (
          <span className="cv-range">
            L{startLine}{endLine && endLine !== startLine ? `–${endLine}` : ''}
          </span>
        )}
        <button type="button" className="cv-btn" onClick={copyCode} title="Copy code" aria-label="Copy code">
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
        {extHref && extHref !== '#' && (
          <a className="cv-btn" href={extHref} target="_blank" rel="noopener noreferrer" title="Open in editor / GitHub">↗</a>
        )}
        {onClose && (
          <button type="button" className="cv-btn" onClick={onClose} title="Hide code panel" aria-label="Hide code panel">✕</button>
        )}
      </div>

      {uniqueFiles.length > 1 && (
        <div className="cv-tabs" role="tablist" aria-label="Cited files">
          {uniqueFiles.slice(0, 8).map(r => (
            <button
              key={r.file}
              type="button"
              role="tab"
              aria-selected={r.file === filePath}
              className={`cv-tab${r.file === filePath ? ' on' : ''}`}
              title={r.file}
              onClick={() => onSelectRef(r)}
            >
              {r.file.split('/').pop()}
              {r.start ? <span className="cv-tab-ln">:{r.start}</span> : null}
            </button>
          ))}
        </div>
      )}

      <div className="cv-body" ref={bodyRef}>
        {fetching && !lines && (
          <div className="cv-skel-body">
            {SKELETON_WIDTHS.slice(0, 10).map((w, i) => (
              <div key={i} className="shimmer-bar" style={{ width: `${w}%`, animationDelay: `${i * 45}ms` }} />
            ))}
          </div>
        )}
        {fetchError && !lines && (
          <div className="cv-err">{fetchError}</div>
        )}
        {lines && (
          <table className="cv-table">
            <tbody>
              {lines.rows.map((text, idx) => {
                const ln = lines.offset + idx;
                const hi = startLine && ln >= startLine && ln <= (endLine || startLine);
                return (
                  <tr key={ln} data-line={ln} className={hi ? 'hi' : undefined}>
                    <td className="cv-ln">{ln}</td>
                    <td className="cv-code">{highlightLine(text, ext)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { useWiki } from './WikiPage.jsx';
import { renderDiagrams } from '../components/Markdown.jsx';
import { formatDate, makeLinkResolver, orderPages, renderPage, slugify } from '../lib/wiki.js';

const pageAnchor = page => `page-${slugify(page.slug)}`;
const headingPrefix = page => `p${page.num.replace(/\./g, '-')}-`;

/**
 * The whole wiki as one printable document: cover, numbered contents and every
 * page with its diagrams drawn. The local server prints this page to PDF with
 * a headless browser; without it, the browser's own print window is used.
 */
export default function PrintView() {
  const { owner, repo } = useParams();
  const [params] = useSearchParams();
  const { loading, wiki } = useWiki(owner, repo);
  const ref = useRef(null);
  const [ready, setReady] = useState(false);
  const onlySlug = params.get('page');
  const paper = params.get('paper') || 'A4';

  const ordered = useMemo(() => (wiki ? orderPages(wiki.pages || []) : []), [wiki]);
  const pages = useMemo(() => (onlySlug ? ordered.filter(page => page.slug === onlySlug) : ordered), [onlySlug, ordered]);
  const rendered = useMemo(() => pages.map(p => {
    const prefix = headingPrefix(p);
    const resolvePage = makeLinkResolver(ordered, p, '');
    const resolveLink = href => {
      if (href?.startsWith('#')) return href;
      const resolved = resolvePage(href);
      if (!resolved) return null;
      const [slug, fragment] = resolved.slice(1).split('#');
      const target = pages.find(page => page.slug === slug);
      if (!target) return `/${wiki.owner}/${wiki.repo}${resolved}`;
      return fragment ? `#${headingPrefix(target)}${fragment}` : `#${pageAnchor(target)}`;
    };
    const r = renderPage(p.markdown, { source: wiki.source, resolveLink });
    // keep heading ids unique across the document
    const html = r.html.replace(/\sid="([^"]+)"/g, ` id="${prefix}$1"`).replace(/href="#(?!(?:page-|p\d+(?:-\d+)*-))([^"]+)"/g, `href="#${prefix}$1"`);
    return { page: p, html, diagrams: r.diagrams };
  }), [pages, ordered, wiki]);

  useEffect(() => {
    const hadDark = document.documentElement.classList.contains('dark');
    document.documentElement.classList.remove('dark');
    return () => { if (hadDark) document.documentElement.classList.add('dark'); };
  }, []);

  useEffect(() => {
    if (wiki) document.title = `${wiki.owner}/${wiki.repo} — documentation`;
  }, [wiki]);

  useEffect(() => {
    if (!loading && (!wiki || !rendered.length)) {
      window.__PRINT_READY = true;
      return undefined;
    }
    if (!ref.current || !rendered.length) return undefined;
    let cancelled = false;
    (async () => {
      const sections = Array.from(ref.current.querySelectorAll('[data-print-page]'));
      for (let i = 0; i < sections.length; i++) {
        // eslint-disable-next-line no-await-in-loop
        await renderDiagrams(sections[i], rendered[i].diagrams, { tools: false });
      }
      if (document.fonts?.ready) await document.fonts.ready;
      if (cancelled) return;
      setReady(true);
      window.__PRINT_READY = true;
      if (params.get('auto')) setTimeout(() => window.print(), 300);
    })();
    return () => { cancelled = true; };
  }, [loading, wiki, rendered, params]);

  if (loading) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!wiki) return <p style={{ padding: 24 }}>No wiki found for {owner}/{repo}. <Link to="/">Back</Link></p>;

  const today = new Date().toISOString();
  return (
    <div className="print-root">
      <style>{`@media print { @page { size: ${paper === 'Letter' ? 'letter' : 'A4'}; } }`}</style>
      <div className="print-toolbar">
        <Link to={`/${owner}/${repo}`}>← Back to the wiki</Link>
        <span className="muted">{ready ? 'Ready to print' : 'Drawing diagrams…'}</span>
        <button type="button" className="btn btn-blue" disabled={!ready} onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
      <div className="print-doc" ref={ref}>
        {!onlySlug && (
          <>
            <section className="print-cover">
              <div className="kicker">Technical documentation</div>
              <h1>{wiki.owner}/{wiki.repo}</h1>
              {wiki.description && <p className="desc">{wiki.description}</p>}
              <div className="facts">
                <div>{ordered.length} {ordered.length === 1 ? 'page' : 'pages'}</div>
                {(wiki.generatedBy || wiki.model) && <div>Model: {wiki.generatedBy || wiki.model}</div>}
                {wiki.commit && <div>Source revision {String(wiki.commit).slice(0, 7)}</div>}
                <div>Indexed {formatDate(wiki.lastIndexed) || '—'} · exported {formatDate(today)}</div>
                <div>Generated with Safe4wiki · safe4ai.com</div>
              </div>
              <img className="print-brand" src="/brand/logo-horizontal-onlight.svg" alt="Safe4ai" />
            </section>
            <section className="print-toc">
              <h2>Contents</h2>
              <ol>
                {ordered.map(p => (
                  <li key={p.slug} style={{ paddingLeft: p.depth * 18 }}>
                    <span className="num">{p.num}</span>
                    <a href={`#${pageAnchor(p)}`}>{p.title}</a>
                  </li>
                ))}
              </ol>
            </section>
          </>
        )}
        {rendered.map(({ page, html }) => (
          <section
            key={page.slug}
            className="print-page"
            id={pageAnchor(page)}
            data-print-page
            data-slug={page.slug}
            data-num={page.num}
            data-depth={page.depth}
            data-title={page.title}
          >
            <div className="crumb">{page.num} · {wiki.owner}/{wiki.repo}</div>
            {/* html is sanitized by renderPage (DOMPurify) */}
            <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
          </section>
        ))}
      </div>
    </div>
  );
}

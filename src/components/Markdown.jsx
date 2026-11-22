import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderPage } from '../lib/wiki.js';

let mermaidPromise = null;
let diagramCounter = 0;
const activeRenders = new WeakMap();
const diagramSvgCache = new Map();

function cacheKey(code) {
  const dark = document.documentElement.classList.contains('dark') ? 'd' : 'l';
  return `${dark}:${code}`;
}

function rememberSvg(code, svg) {
  const key = cacheKey(code);
  diagramSvgCache.set(key, svg);
  if (diagramSvgCache.size > 120) {
    const first = diagramSvgCache.keys().next().value;
    diagramSvgCache.delete(first);
  }
}

function attachDiagramTools(box, code, rendered, onExpand) {
  const bar = document.createElement('div');
  bar.className = 'diagram-tools';
  bar.innerHTML = '<button type="button" data-act="copy" aria-label="Copy diagram source" title="Copy diagram source"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>'
    + (rendered ? '<button type="button" data-act="expand" aria-label="Enlarge diagram" title="Enlarge diagram"><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg></button>' : '');
  bar.addEventListener('click', e => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'copy') navigator.clipboard?.writeText(code);
    if (act === 'expand' && onExpand) onExpand(box.querySelector(':scope > svg')?.outerHTML || '');
  });
  box.appendChild(bar);
}

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(mod => {
      const mermaid = mod.default;
      const dark = document.documentElement.classList.contains('dark');
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: "'Geist Variable', Geist, ui-sans-serif, system-ui, sans-serif",
        flowchart: { htmlLabels: true, curve: 'basis', padding: 8, nodeSpacing: 30, rankSpacing: 36 },
        themeVariables: dark ? {
          background: '#202020', primaryColor: '#262626', primaryBorderColor: '#4a4a4a', primaryTextColor: '#d4d4d4',
          lineColor: '#7a7a7a', secondaryColor: '#2a2a2a', tertiaryColor: '#242424', clusterBkg: '#1c1c1c', clusterBorder: '#3a3a3a',
          noteBkgColor: '#2a2a2a', noteTextColor: '#d4d4d4', fontSize: '16px',
        } : {
          background: '#f2f1f0', primaryColor: '#ffffff', primaryBorderColor: '#cfcfcf', primaryTextColor: '#333333',
          lineColor: '#9a9a9a', secondaryColor: '#fafafa', tertiaryColor: '#ffffff', clusterBkg: '#ebeae9', clusterBorder: '#dcdcdc',
          noteBkgColor: '#fffbe6', noteTextColor: '#333333', fontSize: '16px', edgeLabelBackground: '#f2f1f0',
        },
      });
      return mermaid;
    }).catch(err => {
      mermaidPromise = null;
      throw err;
    });
  }
  return mermaidPromise;
}

/** Auto-quotes unquoted flowchart node labels like `G[png: pdf().toBlob]` that break Mermaid's parser. */
function sanitizeMermaid(code) {
  const trimmed = String(code || '').trim();
  if (!/^(?:flowchart|graph)\b/i.test(trimmed)) return trimmed;
  return trimmed.replace(/(\b[A-Za-z0-9_]+)\[([^\]"\n]+)\]/g, (full, id, label) => {
    // Keep Mermaid special shapes like [(db)], [[sub]], [/io/], [\io\] intact
    if (/^[(\[/\\]/.test(label) && /[)\]\/\\]$/.test(label)) return full;
    if (!/[():,+;&<>]/.test(label)) return full;
    return `${id}["${label.replace(/"/g, '&quot;')}"]`;
  });
}

function renderDiagram(box, code, tools, onExpand) {
  if (activeRenders.has(box)) return activeRenders.get(box);
  const cached = diagramSvgCache.get(cacheKey(code));
  if (cached) {
    box.innerHTML = cached;
    if (tools) attachDiagramTools(box, code, true, onExpand);
    const done = Promise.resolve();
    activeRenders.set(box, done);
    return done;
  }
  const work = (async () => {
    const id = `rw-diagram-${++diagramCounter}`;
    let rendered = false;
    let chunkErr = false;
    try {
      const mermaid = await loadMermaid();
      try {
        const { svg } = await mermaid.render(id, code);
        box.innerHTML = svg;
        rememberSvg(code, svg);
        rendered = true;
      } catch {
        document.getElementById(`d${id}`)?.remove();
        const fixed = sanitizeMermaid(code);
        if (fixed !== code) {
          const retryId = `rw-diagram-${++diagramCounter}`;
          try {
            const { svg } = await mermaid.render(retryId, fixed);
            box.innerHTML = svg;
            rememberSvg(code, svg);
            rendered = true;
          } catch {
            document.getElementById(`d${retryId}`)?.remove();
          }
        }
      }
    } catch (err) {
      if (/dynamically imported module|module script|loading chunk/i.test(String(err?.message || err))) {
        chunkErr = true;
      }
    }
    if (!rendered) {
      box.innerHTML = '';
      if (chunkErr) {
        const note = document.createElement('div');
        note.className = 'muted';
        note.style.cssText = 'font-size:13px;margin-bottom:8px;display:flex;align-items:center;justify-content:center;gap:8px;';
        note.innerHTML = '<span>App was updated — refresh to render diagrams.</span>';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.style.height = '26px';
        btn.textContent = 'Refresh';
        btn.addEventListener('click', () => window.location.reload());
        note.appendChild(btn);
        box.appendChild(note);
      }
      const pre = document.createElement('pre');
      pre.className = 'mermaid-src';
      pre.textContent = code;
      box.appendChild(pre);
    }
    if (tools) attachDiagramTools(box, code, rendered, onExpand);
  })();
  activeRenders.set(box, work);
  return work;
}

/** Resolves after every diagram in this article has finished drawing. */
export async function renderDiagrams(root, diagrams, { tools = true, onExpand } = {}) {
  for (const box of root.querySelectorAll('.diagram[data-diagram]')) {
    await renderDiagram(box, diagrams[Number(box.dataset.diagram)] || '', tools, onExpand);
  }
}

export default function Markdown({ markdown, source, resolveLink, onHeadings, onNavigate, onInspectFile, streaming = false, className = 'prose' }) {
  const ref = useRef(null);
  const [zoom, setZoom] = useState(null);
  const rendered = useMemo(() => renderPage(markdown, { source, resolveLink }), [markdown, source, resolveLink]);

  useEffect(() => { onHeadings && onHeadings(rendered.headings); }, [rendered, onHeadings]);

  // Synchronously restore cached SVGs (zero flicker) or calm placeholder while streaming
  useLayoutEffect(() => {
    if (!ref.current) return;
    for (const box of ref.current.querySelectorAll('.diagram[data-diagram]')) {
      const code = rendered.diagrams[Number(box.dataset.diagram)] || '';
      const cached = diagramSvgCache.get(cacheKey(code));
      if (cached) {
        box.innerHTML = cached;
        attachDiagramTools(box, code, true, setZoom);
        activeRenders.set(box, Promise.resolve());
      } else if (streaming) {
        box.innerHTML = '<div class="diagram-pending"><span class="as-spinner" aria-hidden="true"></span><span>Diagram will render once streaming finishes…</span></div>';
      }
    }
  }, [rendered, streaming]);

  // Only invoke async Mermaid rendering once streaming settles so layout never shakes
  useEffect(() => {
    if (!ref.current || streaming) return;
    renderDiagrams(ref.current, rendered.diagrams, { onExpand: setZoom });
  }, [rendered, streaming]);

  const onClick = e => {
    const chip = e.target.closest('.src-chip[data-file]');
    if (chip && onInspectFile && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      onInspectFile({
        file: chip.dataset.file,
        start: Number(chip.dataset.start) || null,
        end: Number(chip.dataset.end) || null,
      });
      return;
    }
    const a = e.target.closest('a');
    if (!a || !onNavigate) return;
    const href = a.getAttribute('href') || '';
    if (a.target === '_blank' || /^[a-z]+:/i.test(href) || href.startsWith('#')) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onNavigate(href);
  };

  return (
    <>
      <div ref={ref} className={className} onClick={onClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />
      {zoom && createPortal(
        <div className="overlay" onClick={() => setZoom(null)} role="dialog" aria-label="Diagram">
          <div className="dialog wide" style={{ maxWidth: '92vw' }} onClick={e => e.stopPropagation()}>
            <div className="dialog-head"><h2>Diagram</h2><button className="icon-btn" onClick={() => setZoom(null)} aria-label="Close">✕</button></div>
            <div className="dialog-body diagram" style={{ margin: 0, borderRadius: 0 }} dangerouslySetInnerHTML={{ __html: zoom.replace(/max-width:[^;"]*;?/g, '') }} />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

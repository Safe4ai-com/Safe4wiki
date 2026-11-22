// Talks to the local RepoWiki server (server/index.cjs). When the pages are
// opened as plain static files (or as a published HTML export) there is no
// server: the app then shows the bundled sample wikis / exported wiki only.

let healthPromise = null;

export function exportedWiki() {
  return typeof window !== 'undefined' ? window.__RW_EXPORT__ || null : null;
}

export function serverAvailable() {
  if (exportedWiki()) return Promise.resolve(false);
  if (!healthPromise) {
    healthPromise = fetch('/api/health', { headers: { accept: 'application/json' } })
      .then(r => (r.ok ? r.json() : null))
      .then(j => !!(j && (j.app === 'safe4wiki' || j.app === 'repowiki')))
      .catch(() => false);
  }
  return healthPromise;
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: url => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  put: (url, body = {}) => request('PUT', url, body),
  del: url => request('DELETE', url),
};

/** Reads a server-sent-events stream from a POST/GET request. */
export async function stream(url, body, onEvent, signal) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json', accept: 'text/event-stream' } : { accept: 'text/event-stream' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `Request failed (${res.status})`;
    try { const j = await res.json(); if (j.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let type = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;
      try { onEvent(type, JSON.parse(data)); } catch { onEvent(type, data); }
    }
  }
}

export function wikiApiPath(owner, repo) {
  return `/api/wikis/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

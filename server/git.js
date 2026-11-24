'use strict';
/**
 * Cloning and updating repositories. Tokens for private HTTPS repos are only
 * put into the URL of the single git command that needs them; the clone's
 * saved remote never contains them.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NO_LFS = [
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
  '-c', 'core.symlinks=false',
];

function run(cmd, args, { cwd, env, onLine, secret, secrets } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_LFS_SKIP_SMUDGE: '1', ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const secretList = [...(Array.isArray(secrets) ? secrets : []), ...(secret ? [secret] : [])].filter(Boolean);
    const scrub = s => secretList.reduce((acc, sec) => acc.split(sec).join('***'), s);
    const feed = (chunk, isErr) => {
      const text = scrub(chunk.toString());
      if (isErr) err += text; else out += text;
      if (onLine) text.split(/\r?\n|\r/).filter(Boolean).forEach(l => onLine(l));
    };
    child.stdout.on('data', d => feed(d, false));
    child.stderr.on('data', d => feed(d, true));
    child.on('error', e => reject(new Error(`${cmd}: ${scrub(e.message)}`)));
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(scrub(err.trim() || out.trim() || `${cmd} exited with ${code}`).slice(-800)))));
  });
}

function hostOf(url) {
  const s = String(url || '').trim();
  if (/^(https?|ssh):\/\//i.test(s)) {
    try {
      const u = new URL(s);
      return (u.hostname || '').toLowerCase();
    } catch { return ''; }
  }
  const scp = s.match(/^[^@\s/:]+@([^:\s/]+):/);
  if (scp) return scp[1].toLowerCase();
  const m = s.match(/^(?:[^@/\s]+@)?([^/:\s]+)/);
  return m ? m[1].toLowerCase() : '';
}

/** https://host/owner/repo + token -> URL with credentials for one command. */
function authUrl(url, token) {
  if (!token || !/^https:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    const host = (u.hostname || '').toLowerCase();
    u.username = /bitbucket/.test(host) ? 'x-token-auth' : /gitlab/.test(host) ? 'oauth2' : 'x-access-token';
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
}

function cleanUrl(url) {
  const s = String(url || '');
  const schemeMatch = s.match(/^(https?:)\/\//i);
  if (schemeMatch) {
    try {
      const u = new URL(s);
      u.username = '';
      u.password = '';
      return schemeMatch[1] + u.toString().slice(schemeMatch[1].length);
    } catch { /* fall through */ }
  }
  return s.replace(/^(https?:\/\/)[^/]+@/i, '$1');
}

async function headCommit(dir) {
  try {
    const full = await run('git', ['rev-parse', 'HEAD'], { cwd: dir });
    return { full, short: full.slice(0, 7) };
  } catch { return { full: '', short: '' }; }
}

async function cloneOrUpdate({ url, branch, token, dir, onLine }) {
  if (branch && !/^(?!-)[A-Za-z0-9._/-]+$/.test(branch)) throw new Error('Invalid branch name');
  const remote = authUrl(url, token);
  const secrets = token ? [token, encodeURIComponent(token)] : [];
  const scrubLine = line => (onLine ? onLine(secrets.reduce((s, sec) => (sec ? s.split(sec).join('***') : s), line)) : undefined);
  const opts = { onLine: onLine ? scrubLine : undefined, secrets };
  if (fs.existsSync(path.join(dir, '.git'))) {
    const ref = branch || 'HEAD';
    await run('git', ['-c', 'credential.helper=', ...NO_LFS, 'fetch', '--depth', '1', '--', remote, ref], { ...opts, cwd: dir });
    await run('git', [...NO_LFS, 'reset', '--hard', 'FETCH_HEAD'], { cwd: dir });
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    const args = ['-c', 'credential.helper=', ...NO_LFS, 'clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push('--', remote, dir);
    try {
      await run('git', args, opts);
    } finally {
      if (fs.existsSync(path.join(dir, '.git'))) {
        try { await run('git', ['remote', 'set-url', 'origin', cleanUrl(url)], { cwd: dir }); } catch { /* ignore */ }
      }
    }
  }
  return headCommit(dir);
}

module.exports = { run, cloneOrUpdate, headCommit, hostOf, authUrl, cleanUrl };

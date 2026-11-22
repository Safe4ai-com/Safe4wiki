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
];

function run(cmd, args, { cwd, env, onLine, secret } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', GIT_LFS_SKIP_SMUDGE: '1', ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const scrub = s => (secret ? s.split(secret).join('***') : s);
    const feed = (chunk, isErr) => {
      const text = scrub(chunk.toString());
      if (isErr) err += text; else out += text;
      if (onLine) text.split(/\r?\n|\r/).filter(Boolean).forEach(l => onLine(l));
    };
    child.stdout.on('data', d => feed(d, false));
    child.stderr.on('data', d => feed(d, true));
    child.on('error', e => reject(new Error(`${cmd}: ${e.message}`)));
    child.on('close', code => (code === 0 ? resolve(out.trim()) : reject(new Error(scrub(err.trim() || out.trim() || `${cmd} exited with ${code}`).slice(-800)))));
  });
}

function hostOf(url) {
  const m = String(url).match(/^(?:https?:\/\/)?(?:[^@/]+@)?([^/:]+)/);
  return m ? m[1].toLowerCase() : '';
}

/** https://host/owner/repo + token -> URL with credentials for one command. */
function authUrl(url, token) {
  if (!token || !/^https:\/\//i.test(url)) return url;
  const host = hostOf(url);
  const user = /bitbucket/.test(host) ? 'x-token-auth' : /gitlab/.test(host) ? 'oauth2' : 'x-access-token';
  return url.replace(/^https:\/\/(?:[^@/]+@)?/i, `https://${user}:${encodeURIComponent(token)}@`);
}

function cleanUrl(url) {
  return String(url).replace(/^https:\/\/[^@/]+@/i, 'https://');
}

async function headCommit(dir) {
  try {
    const full = await run('git', ['rev-parse', 'HEAD'], { cwd: dir });
    return { full, short: full.slice(0, 7) };
  } catch { return { full: '', short: '' }; }
}

async function cloneOrUpdate({ url, branch, token, dir, onLine }) {
  const remote = authUrl(url, token);
  const opts = { onLine, secret: token ? encodeURIComponent(token) : null };
  if (fs.existsSync(path.join(dir, '.git'))) {
    const ref = branch || 'HEAD';
    await run('git', ['-c', 'credential.helper=', ...NO_LFS, 'fetch', '--depth', '1', remote, ref], { ...opts, cwd: dir });
    await run('git', [...NO_LFS, 'reset', '--hard', 'FETCH_HEAD'], { cwd: dir });
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const args = ['-c', 'credential.helper=', ...NO_LFS, 'clone', '--depth', '1'];
    if (branch) args.push('--branch', branch);
    args.push(remote, dir);
    await run('git', args, opts);
    await run('git', ['remote', 'set-url', 'origin', cleanUrl(url)], { cwd: dir });
  }
  return headCommit(dir);
}

module.exports = { run, cloneOrUpdate, headCommit, hostOf, authUrl, cleanUrl };

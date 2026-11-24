'use strict';
/**
 * Publishing the HTML export to the person's own (sub)domain:
 *   ssh        rsync (or scp) over SSH into a folder their web server serves
 *   github     force-push the site to a branch (GitHub Pages) with a CNAME file
 *   cloudflare `wrangler pages deploy` (Cloudflare Pages)
 *   netlify    `netlify deploy --prod`
 *   command    any command, with {dir} replaced by the site folder
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { exportSite } = require('./export');
const { authUrl } = require('./git');

function run(cmd, args, { cwd, env, log, shell, secrets = [] }) {
  return new Promise((resolve, reject) => {
    const scrub = s => secrets.filter(Boolean).reduce((acc, sec) => acc.split(sec).join('***'), s);
    log(`$ ${scrub([cmd, ...args].join(' '))}`);
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, shell: !!shell, stdio: ['ignore', 'pipe', 'pipe'] });
    const feed = d => scrub(d.toString()).split(/\r?\n/).filter(Boolean).forEach(l => log(l));
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', err => reject(new Error(`${cmd}: ${err.message}`)));
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

function which(cmd) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  return dirs.some(d => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });
}

const need = (t, ...keys) => {
  for (const k of keys) if (!String(t[k] || '').trim()) throw new Error(`Fill in “${k}” first.`);
};

async function publish(wiki, target, log) {
  const t = { ...target };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repowiki-publish-'));
  const dir = path.join(tmp, 'site');
  try {
    log('Building the website…');
    const { pages } = exportSite(wiki, dir, { domain: t.domain });
    log(`Website ready: ${pages} pages.`);
    const url = t.domain ? `https://${t.domain}/` : null;

    if (t.method === 'ssh') {
      need(t, 'host', 'remotePath');
      const port = String(t.port || '22').trim();
      const host = String(t.host || '').trim();
      const user = String(t.user || '').trim();
      const remotePath = String(t.remotePath || '').trim();
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Port must be a number between 1 and 65535');
      if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/.test(host)) throw new Error('Invalid server host');
      if (user && !/^[A-Za-z0-9._-]+$/.test(user)) throw new Error('Invalid SSH user');
      if (!/^\/[A-Za-z0-9._/-]+$/.test(remotePath) || remotePath.split('/').includes('..')) {
        throw new Error('Remote folder path must be an absolute path without spaces, "..", or shell metacharacters');
      }
      const dest = `${user ? `${user}@` : ''}${host}:${remotePath.replace(/\/?$/, '/')}`;
      if (which('rsync')) {
        await run('rsync', ['-az', '--delete', '-e', `ssh -p ${port} -o BatchMode=yes -o StrictHostKeyChecking=accept-new`, '--', `${dir}/`, dest], { log });
      } else {
        await run('scp', ['-r', '-P', port, '-o', 'BatchMode=yes', '--', `${dir}/.`, dest], { log });
      }
    } else if (t.method === 'github') {
      need(t, 'repoUrl');
      const repoUrl = String(t.repoUrl || '').trim();
      if (!/^(https:\/\/|http:\/\/|git@|ssh:\/\/)[^\s]+$/i.test(repoUrl)) throw new Error('Invalid Git repository URL');
      const rawBranch = String(t.branch || 'gh-pages').trim() || 'gh-pages';
      if (!/^(?!-)[A-Za-z0-9._/-]+$/.test(rawBranch)) throw new Error('Invalid Git branch name');
      const branch = rawBranch;
      const remote = authUrl(repoUrl, t.token);
      const git = (...args) => run('git', ['-c', 'user.name=Safe4wiki', '-c', 'user.email=safe4wiki@localhost', '-c', 'credential.helper=', ...args], {
        cwd: dir, log, env: { GIT_TERMINAL_PROMPT: '0' }, secrets: [t.token, t.token && encodeURIComponent(t.token)],
      });
      await git('init', '-q');
      await git('checkout', '-q', '-b', branch);
      await git('add', '-A');
      await git('commit', '-q', '-m', `Publish ${wiki.owner}/${wiki.repo} documentation`);
      await git('push', '--force', '--', remote, `${branch}:${branch}`);
    } else if (t.method === 'cloudflare') {
      need(t, 'project');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(t.project)) throw new Error('Project name: lowercase letters, digits and dashes');
      if (t.accountId && !/^[a-f0-9]{32}$/i.test(String(t.accountId).trim())) throw new Error('Invalid Cloudflare account ID');
      if (!which('wrangler')) throw new Error('Wrangler CLI not found on PATH. Install it first (e.g. npm install -g wrangler) so Safe4wiki does not download unpinned packages automatically.');
      await run('wrangler', ['pages', 'deploy', dir, '--project-name', t.project, '--branch', 'main', '--commit-dirty=true'], {
        log, env: { ...(t.token ? { CLOUDFLARE_API_TOKEN: t.token } : {}), ...(t.accountId ? { CLOUDFLARE_ACCOUNT_ID: String(t.accountId).trim() } : {}) }, secrets: [t.token],
      });
    } else if (t.method === 'netlify') {
      need(t, 'siteId');
      const siteId = String(t.siteId || '').trim();
      if (!/^[A-Za-z0-9._-]+$/.test(siteId) || siteId.startsWith('-')) throw new Error('Invalid Netlify site ID');
      if (!which('netlify')) throw new Error('Netlify CLI not found on PATH. Install it first (e.g. npm install -g netlify-cli) so Safe4wiki does not download unpinned packages automatically.');
      await run('netlify', ['deploy', '--dir', dir, '--prod', '--site', siteId], {
        log, env: t.token ? { NETLIFY_AUTH_TOKEN: t.token } : {}, secrets: [t.token],
      });
    } else if (t.method === 'command') {
      need(t, 'command');
      const cmd = t.command.split('{dir}').join(JSON.stringify(dir));
      await run(cmd, [], { log, shell: true });
    } else {
      throw new Error('Choose how to publish.');
    }
    return { url };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { publish };

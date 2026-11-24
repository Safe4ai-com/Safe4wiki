'use strict';
/**
 * Repository scanner: collects the file list (honoring .gitignore basics and a
 * built-in ignore list), builds a compact directory tree, extracts key project
 * files and language statistics for the planning prompt.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  '.nuxt', '.output', 'target', 'vendor', 'coverage', '__pycache__', '.venv',
  'venv', '.idea', '.vscode', '.qoder', '.local-wiki', 'wiki-pdf', '.cache',
  '.turbo', '.pytest_cache', '.mypy_cache',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wasm', '.exe', '.dll',
  '.so', '.dylib', '.bin', '.dat', '.sqlite', '.db', '.class', '.jar', '.pyc',
  '.min.js', '.min.css', '.map', '.lock',
]);

const KEY_FILES = [
  'README.md', 'readme.md', 'README.rst', 'package.json', 'pyproject.toml',
  'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'composer.json', 'Gemfile', 'Makefile', 'Dockerfile',
  'docker-compose.yml', 'docker-compose.yaml', 'tsconfig.json',
];

const MAX_FILE_SIZE = 200 * 1024; // skip files bigger than this
const KEY_FILE_TRUNC = 4000;      // chars of each key file shown to the planner
const MAX_CONFINE_READ = 256 * 1024;

/** Shared sensitive-file filter used by scanner, RAG indexer, and file preview. */
function isSensitiveName(name) {
  const base = path.basename(String(name || '')).toLowerCase();
  if (!base) return false;
  if (base === '.env' || base === '.envrc') return true;
  if (base.startsWith('.env.') && !/^\.env\.(example|sample|template)$/.test(base)) return true;
  if (/\.(pem|key|p12|pfx|p8|jks|ppk)$/.test(base)) return true;
  if (/^id_(rsa|ed25519|ecdsa|dsa)(\.|$)/.test(base)) return true;
  if (base === '.npmrc' || base === '.netrc' || base === '.pypirc') return true;
  if (base === 'credentials.json' || base === 'secrets.json' || base === 'secrets.yaml' || base === 'secrets.yml') return true;
  if (/^service[-_]?account.*\.json$/.test(base)) return true;
  return false;
}

/**
 * Safely read a regular file strictly confined inside repoDir, rejecting
 * symlinks, non-regular files, path escapes, and files over maxBytes.
 */
function readConfinedFile(repoDir, relOrName, maxBytes = MAX_CONFINE_READ) {
  let realRoot;
  try { realRoot = fs.realpathSync(repoDir); } catch { return null; }
  const full = path.resolve(realRoot, relOrName);
  if (!full.startsWith(realRoot + path.sep)) return null;
  let lst;
  try { lst = fs.lstatSync(full); } catch { return null; }
  if (lst.isSymbolicLink() || !lst.isFile() || lst.size > maxBytes) return null;
  let realFile;
  try { realFile = fs.realpathSync(full); } catch { return null; }
  if (!realFile.startsWith(realRoot + path.sep)) return null;
  try {
    return { text: fs.readFileSync(realFile, 'utf8'), stat: lst, realFile };
  } catch { return null; }
}

/** Linear-time wildcard segment matcher ('*' matches zero or more non-slash chars). */
function matchWildcardSegment(pat, str) {
  let pi = 0, si = 0, star = -1, match = 0;
  while (si < str.length) {
    if (pi < pat.length && pat[pi] === str[si]) { pi++; si++; }
    else if (pi < pat.length && pat[pi] === '*') { star = pi++; match = si; }
    else if (star !== -1) { pi = star + 1; si = ++match; }
    else return false;
  }
  while (pi < pat.length && pat[pi] === '*') pi++;
  return pi === pat.length;
}

/** Linear-time multi-segment glob matcher supporting '*' and '**'. */
function matchGlobSegments(patSegs, pathSegs) {
  const n = patSegs.length, m = pathSegs.length;
  let dp = new Uint8Array(m + 1);
  dp[0] = 1;
  for (let i = 0; i < n; i++) {
    const next = new Uint8Array(m + 1);
    const seg = patSegs[i];
    if (seg === '**') {
      let seen = 0;
      for (let j = 0; j <= m; j++) {
        if (dp[j]) seen = 1;
        next[j] = seen;
      }
    } else {
      for (let j = 0; j < m; j++) {
        if (dp[j] && matchWildcardSegment(seg, pathSegs[j])) next[j + 1] = 1;
      }
    }
    dp = next;
  }
  return dp[m] === 1;
}

function parseGitignoreFile(repoDir, relGitignore, prefixDir) {
  const res = readConfinedFile(repoDir, relGitignore, MAX_CONFINE_READ);
  if (!res) return [];
  const matchers = [];
  for (let line of res.text.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const anchored = line.startsWith('/');
    const pat = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!pat) continue;
    const patSegs = pat.split('/').filter(Boolean);
    const hasSlash = patSegs.length > 1;
    const normPrefix = prefixDir ? prefixDir + '/' : '';
    matchers.push((rel) => {
      if (normPrefix) {
        if (!rel.startsWith(normPrefix)) return false;
        rel = rel.slice(normPrefix.length);
      }
      const parts = rel.split('/');
      if (hasSlash || anchored) {
        if (matchGlobSegments(patSegs, parts)) return true;
        // Directory prefix match (e.g. a/b matches a/b/c)
        for (let len = 1; len < parts.length; len++) {
          if (matchGlobSegments(patSegs, parts.slice(0, len))) return true;
        }
        return false;
      }
      // Bare single-segment pattern matches any segment name
      for (let i = 0; i < parts.length; i++) {
        if (matchWildcardSegment(patSegs[0], parts[i])) return true;
      }
      return false;
    });
  }
  return matchers;
}

// Minimal .gitignore support: plain names, globs, '**', and nested .gitignore files.
function gitignoreMatchers(repoDir) {
  return parseGitignoreFile(repoDir, '.gitignore', '');
}

function isBinaryName(name) {
  const lower = name.toLowerCase();
  for (const ext of BINARY_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function buildTreeLines(files) {
  const treeLines = [];
  const seen = new Set();
  for (const f of files) {
    const parts = f.rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('/');
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      treeLines.push('  '.repeat(i) + parts[i] + (i < parts.length - 1 ? '/' : ''));
    }
  }
  const TREE_CAP = 400;
  return treeLines.length > TREE_CAP
    ? treeLines.slice(0, TREE_CAP).join('\n') + `\n... (${treeLines.length - TREE_CAP} more entries)`
    : treeLines.join('\n');
}

function buildLangStats(files) {
  const byExt = {};
  for (const f of files) {
    const ext = path.extname(f.rel) || '(none)';
    byExt[ext] = byExt[ext] || { count: 0, bytes: 0 };
    byExt[ext].count++;
    byExt[ext].bytes += f.size;
  }
  return Object.entries(byExt)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 10)
    .map(([ext, s]) => `${ext}: ${s.count} files, ${(s.bytes / 1024).toFixed(0)} KB`)
    .join('; ');
}

function scanRepo(repoDir) {
  const rootIgnored = gitignoreMatchers(repoDir);
  const files = [];

  const walk = (dir, inheritedIgnored) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const relDir = path.relative(repoDir, dir).split(path.sep).join('/');
    let localIgnored = inheritedIgnored;
    if (relDir && entries.some(e => e.isFile() && e.name === '.gitignore')) {
      const nested = parseGitignoreFile(repoDir, `${relDir}/.gitignore`, relDir);
      if (nested.length) localIgnored = [...inheritedIgnored, ...nested];
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') {
        if (entry.isDirectory()) continue;           // skip all dot-directories
        if (entry.name !== '.gitignore') continue;   // and most dotfiles
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoDir, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name)) continue;
        if (localIgnored.some(m => m(rel))) continue;
        walk(full, localIgnored);
      } else if (entry.isFile()) {
        if (isBinaryName(entry.name) || isSensitiveName(entry.name)) continue;
        if (localIgnored.some(m => m(rel))) continue;
        let size = 0;
        try { size = fs.lstatSync(full).size; } catch { continue; }
        if (size > MAX_FILE_SIZE) continue;
        files.push({ rel, size });
      }
    }
  };
  walk(repoDir, rootIgnored);
  files.sort((a, b) => a.rel.localeCompare(b.rel));

  // Compact indented tree, capped so huge repos don't blow up the prompt
  const tree = buildTreeLines(files);

  // Key project files (truncated) for planning context.
  // Confined strictly inside repoDir (never follows symlinks).
  const keyFiles = {};
  const seenKeyInodes = new Set();
  for (const name of KEY_FILES) {
    const read = readConfinedFile(repoDir, name, MAX_CONFINE_READ);
    if (!read) continue;
    const keyId = read.stat.ino ? `${read.stat.dev}:${read.stat.ino}` : read.realFile.toLowerCase();
    if (seenKeyInodes.has(keyId)) continue;
    seenKeyInodes.add(keyId);
    let content = read.text;
    if (content.length > KEY_FILE_TRUNC) content = content.slice(0, KEY_FILE_TRUNC) + '\n... (truncated)';
    keyFiles[name] = content;
  }

  // Language stats by extension
  const langStats = buildLangStats(files);

  return {
    files,
    fileSet: new Set(files.map(f => f.rel)),
    tree,
    keyFiles,
    langStats,
    name: path.basename(path.resolve(repoDir)),
  };
}

module.exports = {
  scanRepo,
  buildTreeLines,
  buildLangStats,
  isSensitiveName,
  readConfinedFile,
  gitignoreMatchers,
  parseGitignoreFile,
  matchWildcardSegment,
  matchGlobSegments,
};

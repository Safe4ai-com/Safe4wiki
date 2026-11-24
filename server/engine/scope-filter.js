'use strict';
/**
 * wiki_plan scope.include/exclude — gitignore-flavored globs applied to a
 * finished scan. Supported: '*' within a segment, '**' across segments,
 * trailing '/' (directory prefix), leading '/' (anchor at repo root).
 * include (when non-empty) is an allowlist; exclude always removes.
 */
const { buildTreeLines, buildLangStats, matchGlobSegments } = require('./scan');

// Linear-time glob matcher (no backtracking RegExp).
// Chosen semantics (gitignore wins where gitignore and shell globs differ):
// - '**' matches any number of full path segments (zero or more).
// - '*' matches any run of characters within a single segment.
// - A leading '/' anchors the first segment to the repo root.
// - A trailing '/' matches the directory itself AND everything under it.
// - A pattern whose body contains no '/' (e.g. 'src/' or '*.md') is unanchored
//   and may match at any directory depth.
function compilePattern(pattern) {
  const anchored = pattern.startsWith('/');
  const directory = pattern.endsWith('/');
  const body = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
  const segments = body ? body.split('/') : [];

  if (directory) {
    const dirMatch = (parts) => {
      if (matchGlobSegments(segments, parts)) return true;
      for (let len = 1; len < parts.length; len++) {
        if (matchGlobSegments(segments, parts.slice(0, len))) return true;
      }
      return false;
    };
    return (rel) => {
      const parts = rel.split('/');
      if (dirMatch(parts)) return true;
      if (!anchored && !body.includes('/')) {
        for (let i = 1; i < parts.length; i++) {
          if (dirMatch(parts.slice(i))) return true;
        }
      }
      return false;
    };
  }

  return (rel) => {
    const parts = rel.split('/');
    if (matchGlobSegments(segments, parts)) return true;
    if (!anchored) {
      for (let i = 1; i < parts.length; i++) {
        if (matchGlobSegments(segments, parts.slice(i))) return true;
      }
    }
    return false;
  };
}

function applyScope(scan, scope) {
  const include = (scope && scope.include) || [];
  const exclude = (scope && scope.exclude) || [];
  if (!include.length && !exclude.length) return scan;
  const includeMatchers = include.map(compilePattern);
  const excludeMatchers = exclude.map(compilePattern);
  const files = scan.files.filter(f => {
    if (excludeMatchers.some(m => m(f.rel))) return false;
    if (include.length && !includeMatchers.some(m => m(f.rel))) return false;
    return true;
  });
  if (files.length === 0) {
    const err = new Error('wiki_plan scope leaves no scannable files (include matched nothing or exclude removed everything) — refusing to plan an empty wiki');
    err.code = 'empty_scope';
    throw err;
  }
  const fileSet = new Set(files.map(f => f.rel));
  return {
    ...scan,
    files,
    fileSet,
    keyFiles: Object.fromEntries(
      Object.entries(scan.keyFiles || {}).filter(([key]) => fileSet.has(key))
    ),
    tree: buildTreeLines(files),
    langStats: buildLangStats(files),
  };
}

module.exports = { applyScope, compilePattern };

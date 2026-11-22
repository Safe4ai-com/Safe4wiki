'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

process.env.REPOWIKI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'repowiki-test-'));
const http = require('http');
const store = require('../store');
const rag = require('../rag');
const { chatDetailed, ollamaContextSize, applyAgentCliModel, applyAgentCliEffort, cleanOpencodeOutput, normalizeZcodeReasoningLevel, buildDshModelPatch, insertDshPatchArg } = require('../engine/providers');
const { exportSite, exportSingleHtml, zipDir, orderPages } = require('../export');
const { autoMaxPages, resolveMaxPages } = require('../engine/api');
const { normalizePlan } = require('../engine/plan');
const { cloneOrUpdate, run: gitRun } = require('../git');
const { jobSlotKey, canStartJob } = require('../jobs');

test('settings: keys are hidden from the browser and kept when it saves', () => {
  // Arrange
  const current = { ...store.loadSettings(), models: { cloud: { provider: 'openai', baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-secret' } }, default: 'cloud' };
  // Act
  const shown = store.publicSettings(current);
  const merged = store.mergeSettings(current, shown);
  // Assert
  assert.strictEqual(shown.models.cloud.apiKey, '');
  assert.strictEqual(shown.models.cloud.hasKey, true);
  assert.strictEqual(merged.models.cloud.apiKey, 'sk-secret');
});

test('settings: unknown providers are refused', () => {
  assert.throws(() => store.mergeSettings(store.loadSettings(), { models: { bad: { provider: 'nope' } } }));
});

test('search: finds the section that talks about the question', () => {
  // Arrange
  const chunks = rag.wikiChunks([
    { path: 'a', title: 'Extension host', markdown: '# Extension host\n\nExtensions run in a separate process.' },
    { path: 'b', title: 'Editor', markdown: '# Editor\n\nThe Monaco editor renders text.' },
  ]);
  // Act
  const hits = rag.buildBm25(chunks)('where do extensions run');
  // Assert
  assert.ok(hits.length > 0);
  assert.strictEqual(chunks[hits[0].i].page, 'a');
});

test('thinking text from local models is hidden from answers', () => {
  let out = '';
  const feed = rag.thinkFilter(t => { out += t; });
  feed('<think>hidden'); feed(' still</think>Visible');
  assert.ok(!out.includes('hidden'));
  assert.ok(out.includes('Visible'));
});

test('zip: the archive holds every file, readable again', () => {
  // Arrange
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repowiki-zip-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>hello</h1>'.repeat(50));
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'x');
  // Act
  const zip = zipDir(dir);
  // Assert: end record says 2 entries; first entry inflates back to the file
  const end = zip.length - 22;
  assert.strictEqual(zip.readUInt32LE(end), 0x06054b50);
  assert.strictEqual(zip.readUInt16LE(end + 10), 2);
  const nameLen = zip.readUInt16LE(26);
  const size = zip.readUInt32LE(18);
  const body = zip.subarray(30 + nameLen, 30 + nameLen + size);
  const data = zip.readUInt16LE(8) === 8 ? zlib.inflateRawSync(body) : body;
  assert.strictEqual(data.toString(), fs.readFileSync(path.join(dir, 'index.html'), 'utf8'));
});

test('pages are numbered like the sidebar', () => {
  const pages = orderPages([
    { path: 'overview', title: 'Overview' },
    { path: 'arch', title: 'Architecture' },
    { path: 'arch/ipc', title: 'IPC layer', parent: 'arch' },
  ]);
  assert.deepStrictEqual(pages.map(p => p.slug), ['1-overview', '2-architecture', '2.1-ipc-layer']);
});

test('re-exporting a wiki preserves files outside the generated site', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repowiki-reexport-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wiki = { owner: 'example', repo: 'fixture', pages: [{ path: 'intro.md', title: 'Intro', markdown: '# Intro' }] };
  exportSite(wiki, dir);
  fs.writeFileSync(path.join(dir, 'hosting-config.txt'), 'keep this');
  exportSite(wiki, dir);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'hosting-config.txt'), 'utf8'), 'keep this');
});

test('ollama streaming falls back when the server rejects think:false', async t => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      seen.push(body);
      if ('think' in body) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('invalid parameter: think is not supported by this model');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { content: 'Hello ' } })}\n`);
      res.write(`${JSON.stringify({ message: { content: 'world' }, done: true })}\n`);
      res.end();
    });
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => srv.close(resolve)));

  const { port } = srv.address();
  const chunks = [];
  const full = await rag.streamOllama(
    { provider: 'ollama', baseUrl: `http://127.0.0.1:${port}`, model: 'llama3' },
    [{ role: 'user', content: 'hi' }],
    text => chunks.push(text)
  );
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].think, false);
  assert.strictEqual('think' in seen[1], false);
  assert.strictEqual(full, 'Hello world');
  assert.strictEqual(chunks.join(''), 'Hello world');
});

test('agent-cli respects AbortSignal and kills the subprocess promptly', async () => {
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 120);
  await assert.rejects(
    chatDetailed(
      { provider: 'agent-cli', command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], timeoutMs: 30000 },
      [{ role: 'user', content: 'ping' }],
      { retries: 2, signal: controller.signal }
    ),
    /aborted/i
  );
  assert.ok(Date.now() - started < 3000, 'should abort promptly without retrying or waiting for timeout');
});

test('ollamaContextSize derives a safe num_ctx when contextSize is omitted', () => {
  assert.strictEqual(ollamaContextSize({ contextChars: 48000, maxTokens: 8192 }), 28672);
  assert.strictEqual(ollamaContextSize({ contextSize: 12288, contextChars: 48000 }), 12288);
  assert.ok(ollamaContextSize({ contextChars: 12000, maxTokens: 2048 }) >= 16384);
});

test('promotePartialStage recovers completed pages from an interrupted run', () => {
  const record = { owner: 'local', repo: 'partial-demo', source: { type: 'local', path: '/tmp' }, language: 'en', model: 'ollama' };
  store.saveWikiRecord(record);
  const stageDir = path.join(store.wikiDir('local', 'partial-demo'), 'en', '.content.stage-20261121T100000Z-1-abcd');
  fs.mkdirSync(path.join(stageDir, 'modules'), { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'overview.md'), '# Overview\n\nIntro text.\n');
  fs.writeFileSync(path.join(stageDir, 'modules', 'auth.md'), '# Auth\n\nAuth details.\n');
  store.writeJson(path.join(stageDir, '.state.json'), {
    model: 'ollama',
    pages: { 'overview.md': 'hash1' },
    pageMetadata: {
      'overview.md': { path: 'overview.md', title: 'Overview', description: 'Intro', dependent_files: ['a.js'], isLanding: false, quality: 'ok' },
      'modules/auth.md': { path: 'modules/auth.md', title: 'Auth', description: 'Auth', dependent_files: ['b.js'], isLanding: false, quality: 'degraded' },
    },
  });

  const res = store.promotePartialStage(record);
  assert.strictEqual(res.promoted, 2);
  assert.strictEqual(res.total, 2);
  assert.strictEqual(fs.existsSync(stageDir), false);

  const loaded = store.loadWikiContent(record);
  assert.ok(loaded);
  assert.strictEqual(loaded.pages.length, 2);
  assert.ok(loaded.pages.some(p => p.path === 'overview.md'));
  assert.ok(loaded.pages.some(p => p.path === 'modules/auth.md'));
});

test('chatDetailed ollama streams NDJSON and emits live token progress', async t => {
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.strictEqual(body.stream, true);
      assert.ok(body.options.num_ctx >= 16384);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ message: { content: 'Hello ' }, done: false })}\n`);
      res.write(`${JSON.stringify({ message: { content: 'world' }, done: false })}\n`);
      res.write(`${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 2 })}\n`);
      res.end();
    });
  });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => srv.close(resolve)));

  const progress = [];
  const r = await chatDetailed(
    { provider: 'ollama', baseUrl: `http://127.0.0.1:${srv.address().port}`, model: 'qwen3.5:9b' },
    [{ role: 'user', content: 'hi' }],
    { retries: 0, onProgress: p => progress.push(p) }
  );
  assert.strictEqual(r.content, 'Hello world');
  assert.strictEqual(r.finishReason, 'stop');
  assert.deepStrictEqual(r.usage, { prompt_tokens: 10, completion_tokens: 2 });
  assert.ok(progress.some(p => p.phase === 'reading_prompt'));
  assert.ok(progress.some(p => p.phase === 'generating' && p.tokens >= 1));
});

test('search: matches inflected/multilingual terms like "Sta su transformersi?"', () => {
  const chunks = rag.wikiChunks([
    { path: 'overview.md', title: 'Transformers Overview', markdown: '# Transformers Overview\n\nHugging Face Transformers provides state-of-the-art pretrained models.' },
    { path: 'other.md', title: 'Tokenizers', markdown: '# Tokenizers\n\nFast BPE tokenization utilities.' },
  ]);
  const hits = rag.buildBm25(chunks)('Sta su transformersi?');
  assert.ok(hits.length > 0);
  assert.strictEqual(chunks[hits[0].i].page, 'overview.md');
});

test('applyAgentCliModel injects the right model flag without duplicating', () => {
  assert.deepStrictEqual(applyAgentCliModel('claude', ['-p'], 'claude-sonnet-4-5'), ['--model', 'claude-sonnet-4-5', '-p']);
  assert.deepStrictEqual(applyAgentCliModel('codex', ['exec', '-'], 'gpt-5.3-codex'), ['exec', '--model', 'gpt-5.3-codex', '-']);
  assert.deepStrictEqual(applyAgentCliModel('gemini', ['-p', '{prompt}'], 'gemini-2.5-pro'), ['-m', 'gemini-2.5-pro', '-p', '{prompt}']);
  assert.deepStrictEqual(applyAgentCliModel('codex', ['exec', '--model', 'a', '-'], 'b'), ['exec', '--model', 'a', '-']);
});

test('buildDshModelPatch & insertDshPatchArg build valid dsh override', () => {
  const y1 = buildDshModelPatch('deepseek-v4-pro');
  assert.ok(y1.includes('provider: "deepseek-official"'));
  assert.ok(y1.includes('model: "deepseek-v4-pro"'));
  const y2 = buildDshModelPatch('custom-prov/my-model');
  assert.ok(y2.includes('provider: "custom-prov"'));
  assert.ok(y2.includes('model: "my-model"'));
  assert.deepStrictEqual(
    insertDshPatchArg(['--profile', 'headless', '{prompt}'], '/tmp/p.yml'),
    ['--profile', 'headless', '--patch', '/tmp/p.yml', '{prompt}']
  );
});

test('search: Serbian architecture query matches English wiki architecture/overview and keeps wiki slots', async () => {
  const wChunks = rag.wikiChunks([
    { path: 'overview.md', title: 'Project Overview', markdown: '# Project Overview\n\nOverview of the full application stack: React frontend, FastAPI backend, MySQL.' },
    { path: 'architecture/architecture.md', title: 'Architecture', markdown: '# Architecture\n\nHigh-level system architecture connecting Vite SPA, FastAPI backend, and agent service.' },
    { path: 'modules/auth.md', title: 'Authentication', markdown: '# Authentication\n\nJWT login and RBAC.' },
  ]);
  const cChunks = Array.from({ length: 20 }, (_, i) => ({
    kind: 'code',
    file: `src/file${i}.py`,
    start: 1,
    end: 30,
    text: `def helper_${i}():\n    return "app architecture helper ${i}"`,
  }));
  const chunks = [...wChunks, ...cChunks];
  const index = { chunks, bm25: rag.buildBm25(chunks) };
  const picked = await rag.retrieve(index, { embedding: { enabled: false } }, 'daj mi arhitekturu aplikacije', 10);
  const wikiPicked = picked.filter(c => c.kind === 'wiki');
  assert.ok(wikiPicked.length >= 2, `expected >=2 wiki chunks, got ${wikiPicked.length}`);
  assert.ok(wikiPicked.some(c => c.page === 'architecture/architecture.md'));
});

test('exportSingleHtml produces one self-contained offline HTML file with sidebar and search', async () => {
  const html = await exportSingleHtml({
    wiki: {
      owner: 'acme',
      repo: 'demo',
      description: 'Demo repository',
      pages: [
        { path: 'overview.md', title: 'Overview', parent: null, markdown: '# Overview\n\nWelcome to Demo.' },
        { path: 'arch.md', title: 'Architecture', parent: 'overview.md', markdown: '# Architecture\n\nTwo services.' },
      ],
    },
  });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('acme/demo'));
  assert.ok(html.includes('id="searchInput"'));
  assert.ok(html.includes('Welcome to Demo.'));
  assert.ok(html.includes('Two services.'));
  assert.ok(!html.includes('src="/assets/'));
});

test('autoMaxPages scales with repo size and store preserves maxPages="auto"', () => {
  assert.strictEqual(autoMaxPages(10), 14);
  assert.strictEqual(autoMaxPages(50), 24);
  assert.strictEqual(autoMaxPages(101), 36);
  assert.strictEqual(autoMaxPages(250), 48);
  assert.strictEqual(autoMaxPages(403), 60);
  assert.strictEqual(resolveMaxPages('auto', 101), 36);
  assert.strictEqual(resolveMaxPages(25, 101), 25);
  const current = { ...store.loadSettings(), models: { m: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'q' } }, default: 'm' };
  const merged = store.mergeSettings(current, { ...store.publicSettings(current), maxPages: 'auto' });
  assert.strictEqual(merged.maxPages, 'auto');
});

test('normalizePlan connects 3-level nested directory landings under parent landing', () => {
  const files = ['README.md', 'lib/api.js', 'lib/plan.js', 'lib/plan-quality.js', 'lib/scan.js'];
  const scan = { files, fileSet: new Set(files) };
  const norm = normalizePlan([
    { path: 'overview.md', title: 'Overview', files: ['README.md'] },
    { path: 'architecture/architecture.md', title: 'Architecture', files: ['lib/api.js'] },
    { path: 'architecture/scanning.md', title: 'Scanning', files: ['lib/scan.js'] },
    { path: 'architecture/api.md', title: 'API', files: ['lib/api.js'] },
    { path: 'architecture/planning/planning.md', title: 'Wiki Planning', files: ['lib/plan.js'] },
    { path: 'architecture/planning/normalization.md', title: 'Normalization', files: ['lib/plan.js'] },
    { path: 'architecture/planning/validation.md', title: 'Validation', files: ['lib/plan-quality.js'] },
  ], scan, { maxPages: 20 });
  assert.strictEqual(norm.parentByPath.get('architecture/planning/normalization.md'), 'architecture/planning/planning.md');
  assert.strictEqual(norm.parentByPath.get('architecture/planning/planning.md'), 'architecture/architecture.md');
});

test('agent-cli streams stdout chunks via onChunk during chatDetailed', async () => {
  const chunks = [];
  const r = await chatDetailed(
    { provider: 'agent-cli', command: process.execPath, args: ['-e', 'process.stdout.write("part1 "); setTimeout(() => process.stdout.write("part2"), 30);'] },
    [{ role: 'user', content: 'hi' }],
    { retries: 0, onChunk: c => chunks.push(c) }
  );
  assert.strictEqual(r.content, 'part1 part2');
  assert.ok(chunks.join('').includes('part1'));
  assert.ok(chunks.join('').includes('part2'));
});

test('wiki preprocess: inline backtick fence text does not swallow following mermaid diagram', async () => {
  const { preprocess } = await import('../../src/lib/wiki.js');
  const md = [
    '# Page',
    '',
    'It unwraps a ```` ```json ```` fence if one matches.',
    '',
    '```mermaid',
    'flowchart TD',
    '  A --> B',
    '```',
  ].join('\n');
  const out = preprocess(md, null);
  assert.strictEqual(out.diagrams.length, 1);
  assert.ok(out.diagrams[0].includes('A --> B'));
  assert.ok(out.md.includes('data-diagram="0"'));
});

test('git cloneOrUpdate succeeds on LFS-attributed repos even without git-lfs installed', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-lfs-test-'));
  const origin = path.join(tmp, 'origin');
  const dest = path.join(tmp, 'dest');
  fs.mkdirSync(origin, { recursive: true });
  await gitRun('git', ['init', '-b', 'main'], { cwd: origin });
  await gitRun('git', ['config', 'user.email', 'test@example.com'], { cwd: origin });
  await gitRun('git', ['config', 'user.name', 'Test'], { cwd: origin });
  fs.writeFileSync(path.join(origin, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  fs.writeFileSync(path.join(origin, 'asset.bin'), 'version https://git-lfs.github.com/spec/v1\n');
  fs.writeFileSync(path.join(origin, 'index.js'), 'console.log("ok");\n');
  await gitRun('git', ['-c', 'filter.lfs.clean=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'add', '-A'], { cwd: origin });
  await gitRun('git', ['-c', 'filter.lfs.clean=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', 'commit', '-m', 'init'], { cwd: origin });

  const c1 = await cloneOrUpdate({ url: `file://${origin}`, dir: dest });
  assert.ok(c1.short.length >= 7);
  assert.ok(fs.existsSync(path.join(dest, 'index.js')));

  // Second call exercises the fetch + reset --hard path as well
  const c2 = await cloneOrUpdate({ url: `file://${origin}`, dir: dest });
  assert.strictEqual(c2.full, c1.full);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('agent-cli reasoning effort maps cleanly across claude, codex, opencode, dsh, and zcode', () => {
  assert.deepStrictEqual(applyAgentCliEffort('claude', ['-p'], 'max'), ['--effort', 'max', '-p']);
  assert.deepStrictEqual(applyAgentCliEffort('codex', ['exec', '-'], 'high'), ['exec', '-c', 'model_reasoning_effort="high"', '-']);
  assert.deepStrictEqual(applyAgentCliEffort('opencode', ['run', '-m', 'openai/gpt-5'], 'high'), ['run', '-m', 'openai/gpt-5#high']);

  const dshPatch = buildDshModelPatch('deepseek-v4-pro', 'high');
  assert.ok(dshPatch.includes('model: "deepseek-v4-pro"'));
  assert.ok(dshPatch.includes('reasoningEffort: "high"'));
  const dshEffortOnly = buildDshModelPatch('', 'low');
  assert.ok(dshEffortOnly.includes('reasoningEffort: "low"'));

  assert.strictEqual(normalizeZcodeReasoningLevel('GLM-5.3', 'max'), 'max');
  assert.strictEqual(normalizeZcodeReasoningLevel('GLM-5.2', 'disabled'), 'disabled');
  assert.strictEqual(normalizeZcodeReasoningLevel('GLM-5-Turbo', 'high'), 'enabled');
  assert.strictEqual(normalizeZcodeReasoningLevel('GLM-5-Turbo', 'disabled'), 'disabled');
  assert.strictEqual(cleanOpencodeOutput('\x1b[32m> build · deepseek-v4.1-flash-free\x1b[0m\n\nready\n'), 'ready');
});

test('job scheduler runs cloud/CLI models in parallel with 1 local GPU slot and blocks same-repo duplicates', () => {
  const settings = {
    default: 'opencode',
    models: {
      opencode: { provider: 'agent-cli', command: 'opencode' },
      dsh: { provider: 'agent-cli', command: 'dsh' },
      inkling: { provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'inkling-2-mini' },
      lmstudio: { provider: 'openai', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local' },
      cloud: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
    },
  };
  const jVs = { owner: 'microsoft', repo: 'vscode', model: 'opencode' };
  const jPw = { owner: 'microsoft', repo: 'playwright', model: 'inkling' };
  const jTf = { owner: 'huggingface', repo: 'transformers', model: 'dsh' };
  const jMu = { owner: 'opendatalab', repo: 'MinerU', model: 'lmstudio' };
  const jVsDup = { owner: 'microsoft', repo: 'vscode', model: 'cloud' };

  assert.strictEqual(jobSlotKey(jVs, settings), null);
  assert.strictEqual(jobSlotKey(jPw, settings), 'local-gpu');
  assert.strictEqual(jobSlotKey(jMu, settings), 'local-gpu');

  // Local Ollama job can start alongside cloud/CLI opencode job
  assert.strictEqual(canStartJob(jPw, [jVs], settings), true);
  // Second cloud/CLI job can also run in parallel with opencode + ollama
  assert.strictEqual(canStartJob(jTf, [jVs, jPw], settings), true);
  // Second local GPU job waits while inkling holds local-gpu
  assert.strictEqual(canStartJob(jMu, [jVs, jPw], settings), false);
  // Same repo cannot run twice in parallel
  assert.strictEqual(canStartJob(jVsDup, [jVs], settings), false);
});

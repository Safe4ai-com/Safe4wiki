'use strict';
/**
 * AI backend providers with a single unified entry point: chat(profile, messages, opts).
 *  - openai    : any OpenAI-compatible /chat/completions endpoint
 *                (Ollama :11434/v1, LM Studio :1234/v1, llama.cpp server :8080/v1,
 *                 vLLM, or online: Zhipu GLM, Moonshot Kimi, ...)
 *  - anthropic : Anthropic-compatible /v1/messages endpoint (Zhipu GLM Coding
 *                Plan quota lives here: open.bigmodel.cn/api/anthropic)
 *  - ollama    : native Ollama /api/chat endpoint
 *  - llamacpp  : GGUF model loaded in-process via node-llama-cpp (no server at all)
 */

function resolveApiKey(raw) {
  if (!raw) return '';
  if (raw.startsWith('env:')) return process.env[raw.slice(4)] || '';
  return raw;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Stalled upstream connections would otherwise hang a run forever: bound every
// HTTP request with an abort timer (configurable per profile via timeoutMs)
// and also respect any caller-supplied AbortSignal.
function requestTimeout(profile, opts) {
  const defaultMs = (profile.provider === 'ollama' || profile.provider === 'llamacpp') ? 900000 : 300000;
  const ms = Number(opts.timeoutMs ?? profile.timeoutMs ?? defaultMs);
  const signals = [];
  if (Number.isFinite(ms) && ms > 0) signals.push(AbortSignal.timeout(ms));
  if (opts && opts.signal) signals.push(opts.signal);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals);
  const controller = new AbortController();
  const forward = s => { if (!controller.signal.aborted) controller.abort(s.reason); };
  for (const s of signals) {
    if (s.aborted) { forward(s); break; }
    s.addEventListener('abort', () => forward(s), { once: true });
  }
  return controller.signal;
}

// Reasoning models can leak their chain-of-thought into the answer as
// <think>...</think> blocks (qwen3/glm/deepseek-r1 over various servers).
function stripThink(text) {
  let out = String(text);
  const leading = /^\s*<think>[\s\S]*?<\/think>\s*/;
  while (leading.test(out)) out = out.replace(leading, '');
  return out.trim();
}

async function chatOpenAI(profile, messages, opts) {
  const url = String(profile.baseUrl).replace(/\/+$/, '') + '/chat/completions';
  const apiKey = resolveApiKey(profile.apiKey);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: profile.model,
      messages,
      temperature: opts.temperature ?? profile.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? profile.maxTokens ?? 4096,
      stream: false,
    }),
    signal: requestTimeout(profile, opts),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`HTTP ${res.status} from ${url}: ${body}`);
  }
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  let content = msg && msg.content ? stripThink(msg.content) : '';
  // Some OpenAI-compatible servers (LM Studio/vLLM with reasoning models) put
  // the whole output into reasoning_content and leave content empty.
  if (!content && msg && msg.reasoning_content) content = stripThink(msg.reasoning_content);
  if (!content) throw new Error(`empty completion from ${url}`);
  const choice = data.choices && data.choices[0];
  return {
    content,
    finishReason: choice && choice.finish_reason ? choice.finish_reason : null,
    usage: data.usage && typeof data.usage === 'object' ? data.usage : null,
  };
}

let progressHook = null;
function setProgressHook(fn) {
  progressHook = typeof fn === 'function' ? fn : null;
}
function notifyProgress(opts, info) {
  const fn = (opts && opts.onProgress) || progressHook;
  if (fn) { try { fn(info); } catch { /* ignore */ } }
}

// Ollama defaults to a tiny 4096-token context window when num_ctx is omitted,
// which silently truncates prompts and system rules. Derive a safe num_ctx from
// contextChars + maxTokens unless the user explicitly configured contextSize.
function ollamaContextSize(profile, opts = {}) {
  const explicit = Number(profile.contextSize);
  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);
  const maxOut = Number(opts.maxTokens ?? profile.maxTokens ?? 4096);
  const inputEst = Math.ceil(Number(profile.contextChars || 48000) / 3) + 2048;
  const rounded = Math.ceil((inputEst + maxOut) / 4096) * 4096;
  return Math.max(16384, Math.min(32768, rounded));
}

async function chatOllama(profile, messages, opts) {
  const url = String(profile.baseUrl || 'http://localhost:11434').replace(/\/+$/, '') + '/api/chat';
  const startedAt = Date.now();
  const body = {
    model: profile.model,
    messages,
    stream: true,
    options: {
      temperature: opts.temperature ?? profile.temperature ?? 0.3,
      num_predict: opts.maxTokens ?? profile.maxTokens ?? 4096,
      num_ctx: ollamaContextSize(profile, opts),
    },
  };
  const post = (payload) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: requestTimeout(profile, opts),
  });
  notifyProgress(opts, { phase: 'reading_prompt', tokens: 0, elapsedMs: 0 });
  // Thinking models (qwen3, glm, deepseek-r1, ...) burn the token budget on
  // reasoning and return an empty content field — disable thinking by default;
  // fall back to a plain request for models that reject the parameter.
  let res = await post({ ...body, think: profile.think ?? false });
  if (!res.ok) {
    const errText = (await res.text().catch(() => '')).slice(0, 300);
    if (/think/i.test(errText)) {
      res = await post(body);
      if (!res.ok) {
        const body2 = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`HTTP ${res.status} from ${url}: ${body2}`);
      }
    } else {
      throw new Error(`HTTP ${res.status} from ${url}: ${errText}`);
    }
  }
  if (!res.body) throw new Error(`empty stream from ${url}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let rawText = '';
  let thinkingText = '';
  let tokenChunks = 0;
  let thinkingChunks = 0;
  let firstTokenAt = 0;
  let firstThinkAt = 0;
  let lastEmitAt = 0;
  let finalMeta = null;

  const consumeLine = line => {
    if (!line) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    const thinkDelta = obj.message && obj.message.thinking;
    if (thinkDelta) {
      thinkingText += thinkDelta;
      thinkingChunks++;
      const now = Date.now();
      if (!firstThinkAt) firstThinkAt = now;
      if (now - lastEmitAt >= 1500 || thinkingChunks === 1) {
        lastEmitAt = now;
        const sec = Math.max(0.1, (now - firstThinkAt) / 1000);
        notifyProgress(opts, {
          phase: 'thinking',
          tokens: thinkingChunks,
          chars: thinkingText.length,
          tokPerSec: thinkingChunks > 3 ? Number((thinkingChunks / sec).toFixed(1)) : null,
          elapsedMs: now - startedAt,
        });
      }
    }
    const delta = obj.message && obj.message.content;
    if (delta) {
      rawText += delta;
      tokenChunks++;
      const now = Date.now();
      if (!firstTokenAt) firstTokenAt = now;
      if (now - lastEmitAt >= 1500 || tokenChunks === 1) {
        lastEmitAt = now;
        const genSec = Math.max(0.1, (now - firstTokenAt) / 1000);
        notifyProgress(opts, {
          phase: 'generating',
          tokens: tokenChunks,
          chars: rawText.length,
          tokPerSec: tokenChunks > 3 ? Number((tokenChunks / genSec).toFixed(1)) : null,
          elapsedMs: now - startedAt,
        });
      }
    }
    if (obj.done || obj.done_reason || Number.isFinite(obj.eval_count)) {
      finalMeta = obj;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      consumeLine(line);
    }
  }
  consumeLine(buf.trim());

  const content = stripThink(rawText);
  if (!content) {
    if (thinkingChunks > 0) {
      throw new Error(`thinking consumed the maxTokens budget (${thinkingChunks} thinking tokens, 0 output tokens) — raise Max answer tokens (e.g. 16384)`);
    }
    throw new Error(`empty completion from ${url}`);
  }
  const data = finalMeta || {};
  const hasPromptTokens = Number.isFinite(data.prompt_eval_count);
  const hasCompletionTokens = Number.isFinite(data.eval_count);
  return {
    content,
    finishReason: data.done_reason || null,
    usage: hasPromptTokens || hasCompletionTokens
      ? {
          ...(hasPromptTokens ? { prompt_tokens: data.prompt_eval_count } : {}),
          ...(hasCompletionTokens ? { completion_tokens: data.eval_count } : {}),
        }
      : null,
  };
}

// Direct in-process GGUF inference. node-llama-cpp is ESM-only, loaded lazily so
// the rest of the app has zero dependencies when this provider is unused.
const llamaCache = new Map();
async function chatLlamaCpp(profile, messages, opts) {
  if (!profile.modelPath) throw new Error("provider 'llamacpp' requires a modelPath (path to a .gguf file)");
  let entry = llamaCache.get(profile.modelPath);
  if (!entry) {
    let nlc;
    try {
      nlc = await import('node-llama-cpp');
    } catch {
      throw new Error("node-llama-cpp is not installed. Run: npm install node-llama-cpp");
    }
    const llama = await nlc.getLlama();
    console.error(`  loading GGUF model: ${profile.modelPath}`);
    const model = await llama.loadModel({
      modelPath: profile.modelPath,
      ...(profile.gpuLayers !== undefined ? { gpuLayers: profile.gpuLayers } : {}),
    });
    entry = { nlc, model };
    llamaCache.set(profile.modelPath, entry);
  }
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const user = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');
  const context = await entry.model.createContext(
    profile.contextSize ? { contextSize: profile.contextSize } : {}
  );
  try {
    const session = new entry.nlc.LlamaChatSession({
      contextSequence: context.getSequence(),
      ...(system ? { systemPrompt: system } : {}),
    });
    const response = await session.prompt(user, {
      maxTokens: opts.maxTokens ?? profile.maxTokens ?? 4096,
      temperature: opts.temperature ?? profile.temperature ?? 0.3,
    });
    const content = stripThink(response);
    if (!content) throw new Error('empty completion from in-process llama.cpp');
    return {
      content,
      finishReason: 'stop',
      usage: null,
    };
  } finally {
    await context.dispose();
  }
}

// Anthropic Messages API (also spoken by Zhipu's GLM Coding Plan endpoint).
// STREAMING-FIRST: big non-streaming requests stall on some gateways under
// load (observed on Zhipu: 5k-token plan prompts hang until aborted). With
// stream:true data flows incrementally, so the timeout below acts as an IDLE
// detector (no chunk for idleTimeoutMs) instead of a total-time cap — slow
// but alive responses succeed, dead connections abort fast.
// Thinking models return thinking/text blocks; only text deltas are kept.
async function chatAnthropic(profile, messages, opts) {
  const url = String(profile.baseUrl).replace(/\/+$/, '') + '/v1/messages';
  const apiKey = resolveApiKey(profile.apiKey);
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const convo = messages.filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
  const requestBody = {
    model: profile.model,
    ...(system ? { system } : {}),
    messages: convo,
    max_tokens: opts.maxTokens ?? profile.maxTokens ?? 4096,
    ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
    // Thinking models burn minutes on reasoning blocks; wiki generation is
    // structured work that does not need it — opt out per profile (think: false).
    ...(profile.think === false ? { thinking: { type: 'disabled' } } : {}),
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  const idleMs = Number(profile.idleTimeoutMs ?? 120000);
  let idleTimer = null;
  const idleAbort = new AbortController();
  const totalSignal = requestTimeout(profile, opts);
  if (totalSignal) totalSignal.addEventListener('abort', () => idleAbort.abort(totalSignal.reason), { once: true });
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleAbort.abort(new Error(`stream idle for ${idleMs}ms — connection stalled`));
    }, idleMs);
  };

  try {
    armIdle();
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...requestBody, stream: true }),
      signal: idleAbort.signal,
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`HTTP ${res.status} from ${url}: ${body}`);
    }
    if (!res.body) throw new Error(`empty stream from ${url}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let sawThinking = false;
    let stopReason = null;
    let usage = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let event;
        try { event = JSON.parse(payload); } catch { continue; }
        if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
            text += event.delta.text;
          } else if (event.delta.type === 'thinking_delta') {
            sawThinking = true;
          }
        } else if (event.type === 'message_start' && event.message && event.message.usage) {
          usage = { ...event.message.usage };
        } else if (event.type === 'message_delta') {
          if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
          if (event.usage) usage = { ...(usage || {}), ...event.usage };
        }
      }
    }
    const content = stripThink(text.trim());
    if (!content) {
      throw new Error(sawThinking
        ? `empty completion from ${url} (thinking consumed the max_tokens budget — raise it or set think:false)`
        : `empty completion from ${url} (no text deltas received)`);
    }
    const finish = stopReason === 'max_tokens' ? 'length'
      : stopReason === 'end_turn' ? 'stop'
        : (stopReason || null);
    return {
      content,
      finishReason: finish,
      usage: usage && typeof usage === 'object' ? {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
      } : null,
    };
  } finally {
    clearTimeout(idleTimer);
  }
}

// Agent CLI provider (added for Open DeepWiki): hands the conversation to a
// coding-agent command line (Claude Code, Codex, Gemini CLI, OpenCode or any
// custom command) running inside the repository, so the agent can read files
// itself. The prompt goes to stdin, or into an argument that contains {prompt}.
function messagesToPrompt(messages) {
  return messages.map(m => {
    const role = m.role === 'system' ? 'INSTRUCTIONS' : m.role === 'assistant' ? 'PREVIOUS ANSWER' : 'TASK';
    return `### ${role}\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`;
  }).join('\n\n') + '\n\nReply with the requested output only (no preamble, do not edit any files).';
}

function resolveAgentNode(env) {
  const { existsSync, readdirSync } = require('fs');
  const { homedir } = require('os');
  const { join } = require('path');
  const supportsSqlite = version => {
    const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
    return major > 22 || (major === 22 && minor >= 13);
  };
  if (supportsSqlite(process.version)) return process.execPath;

  const versions = join(env.NVM_DIR || join(homedir(), '.nvm'), 'versions', 'node');
  if (!existsSync(versions)) return null;
  return readdirSync(versions)
    .filter(supportsSqlite)
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map(version => join(versions, version, 'bin', 'node'))
    .find(existsSync) || null;
}

const CLI_MODEL_FLAG = { claude: '--model', codex: '--model', gemini: '-m', opencode: '-m' };

function applyAgentCliModel(command, args, model) {
  const m = String(model || '').trim();
  const flag = CLI_MODEL_FLAG[command];
  if (!m || !flag) return args;
  if (args.includes('--model') || args.includes('-m')) return args;
  const out = [...args];
  if ((command === 'codex' && out[0] === 'exec') || (command === 'opencode' && out[0] === 'run')) {
    out.splice(1, 0, flag, m);
  } else {
    out.unshift(flag, m);
  }
  return out;
}

function applyAgentCliEffort(command, args, effort) {
  const e = String(effort || '').trim().toLowerCase();
  if (!e) return args;
  const out = [...args];
  if (command === 'claude') {
    if (out.includes('--effort')) return out;
    const val = e === 'disabled' ? 'low' : e === 'enabled' ? 'high' : e;
    out.unshift('--effort', val);
    return out;
  }
  if (command === 'codex') {
    if (out.some(a => a.includes('model_reasoning_effort'))) return out;
    const val = e === 'disabled' ? 'low' : e === 'enabled' ? 'high' : e;
    const entry = `model_reasoning_effort=${JSON.stringify(val)}`;
    if (out[0] === 'exec') out.splice(1, 0, '-c', entry);
    else out.unshift('-c', entry);
    return out;
  }
  if (command === 'opencode') {
    const idx = out.findIndex(a => a === '-m' || a === '--model');
    if (idx !== -1 && idx + 1 < out.length && !out[idx + 1].includes('#')) {
      const val = e === 'disabled' ? 'low' : e === 'enabled' ? 'high' : e;
      out[idx + 1] = `${out[idx + 1]}#${val}`;
    }
    return out;
  }
  return out;
}

function normalizeZcodeReasoningLevel(modelId, effort) {
  const e = String(effort || '').trim().toLowerCase();
  if (!e) return null;
  const m = String(modelId || '').toLowerCase();
  if (/glm-5\.3/.test(m)) {
    if (['low', 'high', 'max'].includes(e)) return e;
    if (e === 'disabled') return 'low';
    if (e === 'xhigh') return 'max';
    return 'high';
  }
  if (/glm-5\.2/.test(m)) {
    if (['disabled', 'high', 'max'].includes(e)) return e;
    if (e === 'xhigh') return 'max';
    return 'high';
  }
  // GLM-5-Turbo, GLM-5.1, GLM-4.x use disabled / enabled
  return e === 'disabled' ? 'disabled' : 'enabled';
}

function buildDshModelPatch(model, reasoningEffort) {
  const m = String(model || '').trim();
  const effort = String(reasoningEffort || '').trim().toLowerCase();
  if (!m && !effort) return null;
  const slash = m.indexOf('/');
  const provider = slash > 0 ? m.slice(0, slash).trim() : 'deepseek-official';
  const modelId = m ? (slash > 0 ? m.slice(slash + 1).trim() : m) : 'deepseek-flash';
  if (!modelId) return null;
  let yaml = `- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(provider)}\n    model: ${JSON.stringify(modelId)}\n`;
  if (effort) {
    const val = effort === 'disabled' ? 'none' : effort === 'enabled' ? 'high' : effort;
    yaml += `    reasoningEffort: ${JSON.stringify(val)}\n`;
  }
  return yaml;
}

function insertDshPatchArg(args, patchPath) {
  const out = [...args];
  const profIdx = out.indexOf('--profile');
  if (profIdx !== -1 && profIdx + 1 < out.length) {
    out.splice(profIdx + 2, 0, '--patch', patchPath);
  } else {
    out.unshift('--patch', patchPath);
  }
  return out;
}

function cleanOpencodeOutput(text) {
  return String(text || '')
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/^\s*>\s+[^\n]*·[^\n]*\n+/, '')
    .trim();
}

function chatAgentCli(profile, messages, opts) {
  const { spawn } = require('child_process');
  const { constants, existsSync, accessSync, readFileSync, writeFileSync, unlinkSync } = require('fs');
  const { homedir, tmpdir } = require('os');
  const { delimiter, dirname, join } = require('path');
  const { randomBytes } = require('crypto');
  const prompt = messagesToPrompt(messages);
  const command = String(profile.command || '').trim();
  if (!command) throw new Error("provider 'agent-cli' requires a command (e.g. claude, codex, gemini)");
  const tempFiles = [];
  const cleanupTemp = () => {
    while (tempFiles.length) {
      const f = tempFiles.pop();
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  };
  let rawArgs = applyAgentCliModel(command, Array.isArray(profile.args) ? profile.args.map(String) : [], profile.model);
  rawArgs = applyAgentCliEffort(command, rawArgs, profile.reasoningEffort);
  if (command === 'dsh' && (profile.model || profile.reasoningEffort) && !rawArgs.includes('--patch')) {
    const patchYaml = buildDshModelPatch(profile.model, profile.reasoningEffort);
    if (patchYaml) {
      const patchPath = join(tmpdir(), `safe4wiki-dsh-${randomBytes(6).toString('hex')}.yml`);
      writeFileSync(patchPath, patchYaml, { mode: 0o600 });
      tempFiles.push(patchPath);
      rawArgs = insertDshPatchArg(rawArgs, patchPath);
    }
  }
  const usesArg = rawArgs.some(a => a.includes('{prompt}'));
  const args = rawArgs.map(a => a.split('{prompt}').join(prompt));
  const env = { ...process.env, ...(profile.env || {}) };
  let executable = command;
  if ((command === 'dsh' || command === 'opencode') && process.platform !== 'win32') {
    const node = resolveAgentNode(env);
    if (node) env.PATH = [dirname(node), env.PATH].filter(Boolean).join(delimiter);
  }
  if (command === 'opencode') env.NO_COLOR ||= '1';
  let usedZcodeBundle = false;
  let zcodeDataDir = env.ZCODE_DATA_BASE_DIR || '';
  if (command === 'zcode' && process.platform === 'darwin') {
    const resources = '/Applications/ZCode.app/Contents/Resources';
    const bundle = join(resources, 'glm', 'zcode.cjs');
    const config = join(resources, 'config', 'provider', 'zcode-builtin.json');
    const installedCli = (env.PATH || '').split(delimiter).some(dir => {
      if (!dir) return false;
      try { accessSync(join(dir, 'zcode'), constants.X_OK); return true; } catch { return false; }
    });
    if (!installedCli && existsSync(bundle) && existsSync(config)) {
      executable = resolveAgentNode(env);
      if (!executable) { cleanupTemp(); throw new Error('The ZCode desktop CLI needs Node.js 22.13 or newer.'); }
      args.unshift(bundle);
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ||= config;
      // Isolate CLI credentials from ZCode Desktop so Desktop never wipes CLI OAuth tokens.
      const isolated = join(env.REPOWIKI_HOME || join(homedir(), '.repowiki'), 'zcode-cli');
      if (!env.ZCODE_DATA_BASE_DIR && existsSync(join(isolated, '.zcode', 'v2', 'credentials.json'))) {
        env.ZCODE_DATA_BASE_DIR = isolated;
      }
      zcodeDataDir = env.ZCODE_DATA_BASE_DIR || '';
      usedZcodeBundle = true;
    }
  }
  if (command === 'zcode' && (profile.model || profile.reasoningEffort) && !env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) {
    const m = String(profile.model || '').trim();
    const baseDir = zcodeDataDir || homedir();
    const personalPath = join(baseDir, '.zcode', 'v2', 'provider_config.json');
    if (existsSync(personalPath) && env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE) {
      try {
        const parsed = JSON.parse(readFileSync(personalPath, 'utf8'));
        const existingSel = parsed?.config?.defaultModelSelection || {};
        const slash = m.indexOf('/');
        const providerId = m && slash > 0 ? m.slice(0, slash).trim() : (existingSel.providerId || 'account:zai-individual-coding-plan');
        const modelId = m ? (slash > 0 ? m.slice(slash + 1).trim() : m) : existingSel.modelId;
        if (parsed && typeof parsed.config === 'object' && modelId) {
          const nextSel = { providerId, modelId };
          const rl = normalizeZcodeReasoningLevel(modelId, profile.reasoningEffort);
          if (rl) nextSel.options = { ...(existingSel.options || {}), reasoningLevel: rl };
          else if (existingSel.options) nextSel.options = existingSel.options;
          parsed.config.defaultModelSelection = nextSel;
          const overlayPath = join(tmpdir(), `safe4wiki-zcode-${randomBytes(6).toString('hex')}.json`);
          writeFileSync(overlayPath, JSON.stringify(parsed), { mode: 0o600 });
          tempFiles.push(overlayPath);
          env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = overlayPath;
        }
      } catch { /* ignore invalid personal config */ }
    }
  }
  const timeoutMs = Number(opts.timeoutMs ?? profile.timeoutMs ?? 900000);
  return new Promise((resolve, reject) => {
    if (opts.signal && opts.signal.aborted) {
      cleanupTemp();
      reject(new Error(`agent CLI '${command}' aborted`));
      return;
    }
    let child;
    try {
      child = spawn(executable, args, {
        cwd: opts.cwd || profile.cwd || process.cwd(),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) { cleanupTemp(); reject(err); return; }
    let out = '';
    let errText = '';
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      cleanupTemp();
      if (err) reject(err);
      else resolve(val);
    };
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish(new Error(`agent CLI '${command}' aborted`));
    };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      finish(new Error(`agent CLI '${command}' timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', d => {
      const s = String(d);
      out += s;
      if (typeof opts.onChunk === 'function') {
        try { opts.onChunk(s); } catch { /* ignore */ }
      }
    });
    child.stderr.on('data', d => { errText += d; if (errText.length > 20000) errText = errText.slice(-20000); });
    child.on('error', err => { finish(new Error(`could not start '${command}': ${err.message}`)); });
    child.on('close', code => {
      const cleaned = command === 'opencode' ? cleanOpencodeOutput(out) : out.trim();
      const content = stripThink(cleaned);
      const looksLikeCliError = !content || content.length < 600
        || /\b(error|unauthorized|forbidden|quota|rate[ _-]?limit|usage limit|5-hour limit|session limit|hit your [^\n]*limit|login|expired|denied)\b/i.test(content);
      if (code !== 0 && looksLikeCliError) {
        const tail = (content || errText.trim()).slice(-400);
        const loginCmd = usedZcodeBundle
          ? 'ZCODE_DATA_BASE_DIR=~/.repowiki/zcode-cli ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs login zai'
          : 'zcode login zai';
        let hint = '';
        if (command === 'zcode') {
          if (/project_token_login_failed/i.test(tail)) {
            hint = ` (ZCode Z.AI login endpoint rejected or rate-limited the OAuth exchange — click Auth in Settings if expired, or for large multi-page wikis use Z.AI as an Online API profile with an API key so it never hits Z.AI's login rate limit)`;
          } else if (/Model creation failed/i.test(tail)) {
            hint = ` (ZCode CLI needs its own isolated sign-in so ZCode Desktop does not clear it. Run once in Terminal: ${loginCmd})`;
          }
        }
        finish(new Error(`'${command}' exited with ${code}: ${tail}${hint}`));
        return;
      }
      if (!content) { finish(new Error(`'${command}' printed nothing`)); return; }
      finish(null, { content, finishReason: 'stop', usage: null });
    });
    child.stdin.on('error', () => {});
    if (!usesArg) child.stdin.write(prompt);
    child.stdin.end();
  });
}

const PROVIDERS = { openai: chatOpenAI, anthropic: chatAnthropic, ollama: chatOllama, llamacpp: chatLlamaCpp, 'agent-cli': chatAgentCli };

async function chatDetailed(profile, messages, opts = {}) {
  const fn = PROVIDERS[profile.provider];
  if (!fn) {
    throw new Error(`unknown provider '${profile.provider}' (expected: ${Object.keys(PROVIDERS).join(', ')})`);
  }
  const retries = opts.retries ?? 2;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(profile, messages, opts);
    } catch (err) {
      lastErr = err;
      if (opts.signal && opts.signal.aborted) break;
      if (attempt < retries) {
        const delayMs = /project_token_login_failed/i.test(err.message) ? 5000 * (attempt + 1) : 1500 * (attempt + 1);
        console.warn(`  retry ${attempt + 1}/${retries}: ${err.message.split('\n')[0]}`);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

async function chat(profile, messages, opts = {}) {
  return (await chatDetailed(profile, messages, opts)).content;
}

module.exports = {
  chat,
  chatDetailed,
  resolveApiKey,
  resolveAgentNode,
  ollamaContextSize,
  setProgressHook,
  applyAgentCliModel,
  applyAgentCliEffort,
  cleanOpencodeOutput,
  normalizeZcodeReasoningLevel,
  buildDshModelPatch,
  insertDshPatchArg,
  PROVIDERS,
  stripThink,
};

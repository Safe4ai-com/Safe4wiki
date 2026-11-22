# Safe4wiki

[![CI](https://github.com/Safe4ai-com/Safe4wiki/actions/workflows/ci.yml/badge.svg)](https://github.com/Safe4ai-com/Safe4wiki/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Part of SafeSuite](https://img.shields.io/badge/SafeSuite-by%20Safe4AI-0f172a.svg)](https://safe4ai.com)

**Local-first, privacy-first AI documentation wiki for any codebase.**  
Part of **[SafeSuite](https://github.com/Safe4ai-com)** — open-source AI engineering tools by **[Safe4AI](https://safe4ai.com)**.

Generate deep, citation-grounded repository wikis with Mermaid architecture diagrams, explore your codebase through a hybrid RAG assistant with a live split-view code inspector, export offline single-file HTML or print-quality PDFs, and publish directly to your own subdomain — using **local LLMs**, **cloud APIs**, or **agent CLIs**.

---

## Key Features

- **100% Local & Private by Default** — Runs on `localhost:4317`. Works with local folders or private Git repositories (tokens stored locally with `chmod 600` and never exposed to the browser).
- **Interchangeable AI Backends**
  - **Local models:** Ollama, LM Studio, llama.cpp server, vLLM, or direct `.gguf` inference (`node-llama-cpp`)
  - **Cloud APIs:** Any OpenAI-compatible endpoint (OpenAI, OpenRouter, Groq, DeepSeek, GLM, self-hosted) and Anthropic-compatible endpoints
  - **Agent CLIs:** DeepSeek Harness (`dsh`), ZCode, Claude Code, Codex, Gemini CLI, OpenCode, or any custom CLI command
- **Deep, Grounded Wiki Generation**
  - Auto-scaling page budget (`Auto` adapts from small repos up to 60+ pages with up to 3-level hierarchy)
  - Automatic project **Glossary** and structured landing pages
  - Verified source-file citations deduplicated cleanly into each page's **Relevant source files** drawer
  - Auto-healed **Mermaid** diagrams with pan/zoom lightbox and instant cache
  - Transactional staged builds + incremental regeneration (skips unchanged pages and preserves manual edits)
- **Hybrid RAG Code Assistant**
  - Combines wiki sections and source-code chunks (BM25 + optional background semantic embeddings with zero startup wait)
  - Streamed answers with clickable file & line-range chips
  - On-demand **Split-View Live Code Inspector** and file attachments
- **Export & 1-Click Subdomain Publishing**
  - **Single-file offline HTML (`*-docs.html`)** — self-contained with pre-rendered SVG diagrams, sidebar, search, and dark/light theme (works directly via `file://` with zero external requests)
  - **Print-quality PDF** — cover page, table of contents, and rendered diagrams via Chromium/Playwright
  - **Static Website Export (ZIP or folder)** — with fast client-side search across all pages
  - **Publish to your subdomain** with built-in step-by-step setup guides: **SSH / rsync**, **GitHub Pages** (auto `CNAME` + `.nojekyll`), **Cloudflare Pages**, **Netlify**, or **custom command**

---

## Quick Start

**Requirements:** Node.js `>= 18`

```bash
git clone https://github.com/Safe4ai-com/Safe4wiki.git
cd Safe4wiki
npm install
npm run build
npm start
```

Safe4wiki opens automatically at **`http://localhost:4317`**.

> **macOS shortcut:** Double-click `Open Safe4wiki.command` in the repository folder to start the server and open your browser automatically.

---

## First-Time Workflow

1. **Configure a model** — Click **Settings** in the top bar and pick a preset (Ollama, LM Studio, OpenAI/Anthropic API, or an installed Agent CLI such as `dsh`, `claude`, `codex`, `gemini`, `zcode`, or `opencode`), then click **Test**.
2. **Add a repository** — Click **Add repository** on the home screen and point it to a local folder or a Git URL (SSH or HTTPS + token).
3. **Explore & ask** — Browse generated chapters and diagrams, or use the **Ask about …** bar at the bottom to run hybrid RAG queries with clickable source citations and live code inspection.
4. **Export or publish** — Click **Share** to export a single-file offline HTML handbook, print-ready PDF, static hosting bundle, or publish directly to your subdomain (click **`ⓘ Setup guide`** inside the Publish dialog for step-by-step instructions per host).

---

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `4317` | Local HTTP port (`127.0.0.1` only) |
| `REPOWIKI_HOME` | `~/.repowiki` | Directory where settings, generated wikis, embeddings cache, and cloned repos are stored |

For PDF export, Safe4wiki automatically uses an installed Chrome/Chromium browser or Playwright Chromium (`npx playwright install chromium`). If neither is available, it falls back cleanly to browser print view.

---

## Development & Testing

```bash
npm run build   # Type-check (tsc --noEmit), bundle frontend (Vite), and generate static routes
npm test        # Run server & preprocessing test suite (node --test)
npm start       # Start the local Safe4wiki server
```

---

## SafeSuite Ecosystem

Safe4wiki is the first open-source product in **[SafeSuite](https://github.com/Safe4ai-com)** — a growing collection of local-first, privacy-respecting AI developer tools created by **[Safe4AI](https://safe4ai.com)**.

Follow the **[Safe4ai-com organization](https://github.com/Safe4ai-com)** for upcoming SafeSuite releases.

---

## License & Attribution

Licensed under the **[Apache License, Version 2.0](LICENSE)** (`Copyright 2026 Safe4AI`).  
See [`NOTICE`](NOTICE) for attribution details. The wiki generation engine in `server/engine/` incorporates code from `open-repo-wiki` (MIT License — see [`server/engine/LICENSE-open-repo-wiki`](server/engine/LICENSE-open-repo-wiki)).

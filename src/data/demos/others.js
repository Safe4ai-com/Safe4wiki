import { buildDemo } from './build.js';
import { transformersTree, playwrightTree, mineruTree } from './trees.js';

/* Sample wikis shown without a local server. All text is original, written
   for this app; the section outline follows the usual overview structure. */

const transformersOverview = `# Overview

<cite>
**Referenced Files in This Document**
- [README.md](README.md)
- [src/transformers/__init__.py](src/transformers/__init__.py)
- [src/transformers/models/__init__.py](src/transformers/models/__init__.py)
- [src/transformers/models/auto/modeling_auto.py](src/transformers/models/auto/modeling_auto.py)
- [src/transformers/models/auto/configuration_auto.py](src/transformers/models/auto/configuration_auto.py)
- [src/transformers/models/auto/tokenization_auto.py](src/transformers/models/auto/tokenization_auto.py)
- [docs/source/en/_toctree.yml](docs/source/en/_toctree.yml)
</cite>

## Purpose and scope

Transformers supplies machine learning model definitions across text, computer vision, audio, video and multimodal tasks. An agreed definition can be reused for both training and inference, giving adjacent libraries and inference engines shared implementations from fine-tuning through deployment. [README.md:L70-L80] This overview maps the major parts of the codebase and points to guides for installation, model-family layout and documentation conventions.

**Section sources**
- [README.md:L70-L80](README.md#L70-L80)

## Design Philosophy

Every model lives in its own folder with a configuration class, a modeling file and, when needed, tokenizers and processors. The modular generator expands shared code into model files that readers can follow from top to bottom. [README.md:L73-L88] The package root builds a lazy import table for generation, pipelines, preprocessing and training. Python loads the related module when its public name is first accessed. [src/transformers/__init__.py:L15-L19] [src/transformers/__init__.py:L61-L99] [src/transformers/__init__.py:L117-L179]

APIs for input processing, model types, generation and training are among the package root exports. Model names appear in mappings to the modules that supply them. The [Design Philosophy & V5 Migration Guide](design-philosophy-v5-migration-guide.md) describes the single-file approach and how composition helps limit abstraction in generated models. [src/transformers/__init__.py:L89-L98] [src/transformers/__init__.py:L117-L149] [src/transformers/models/__init__.py:L20-L43]

**Section sources**
- [README.md:L73-L88](README.md#L73-L88)
- [src/transformers/__init__.py:L15-L19](src/transformers/__init__.py#L15-L19)
- [src/transformers/__init__.py:L61-L99](src/transformers/__init__.py#L61-L99)
- [src/transformers/__init__.py:L117-L179](src/transformers/__init__.py#L117-L179)
- [src/transformers/models/__init__.py:L1-L5](src/transformers/models/__init__.py#L1-L5)
- [src/transformers/models/__init__.py:L20-L43](src/transformers/models/__init__.py#L20-L43)

## Key Subsystems Overview

The library combines model definitions with automatic class resolution, input processing, text generation, task pipelines and a training loop. The package root lists these public names, while the generated auto mappings connect each model type to its concrete configuration, model and tokenizer classes. [src/transformers/__init__.py:L61-L69] [src/transformers/models/auto/modeling_auto.py:L41-L58] [src/transformers/models/auto/tokenization_auto.py:L63-L78]

| Subsystem | Role at a glance |
|-----------|------------------|
| Model architectures | One folder per family under \`src/transformers/models/\`, each with config and modeling code [src/transformers/models/__init__.py:L1-L5] [src/transformers/models/__init__.py:L20-L41] |
| Auto factories | The model-type mapping connects names such as \`albert\` to classes such as \`AlbertModel\`. Configurations and tokenizers have related mappings. [src/transformers/models/auto/modeling_auto.py:L41-L50] [src/transformers/models/auto/configuration_auto.py:L34-L48] [src/transformers/models/auto/tokenization_auto.py:L63-L78] |
| Input processing | Tokenizers inherit their common text APIs from \`PreTrainedTokenizerBase\`. \`ProcessorMixin\` ties tokenizers and other processors together. [src/transformers/__init__.py:L86-L88] [src/transformers/__init__.py:L150-L170] |
| Generation and pipelines | \`generate()\` with streaming plus task-level helpers [src/transformers/__init__.py:L99-L111] |
| Training | \`Trainer\` runs the training loop. \`TrainingArguments\` configures it, and \`TrainerCallback\` provides hooks for events during training. [src/transformers/__init__.py:L171-L185] |

**Section sources**
- [src/transformers/__init__.py:L61-L69](src/transformers/__init__.py#L61-L69)
- [src/transformers/models/auto/modeling_auto.py:L41-L58](src/transformers/models/auto/modeling_auto.py#L41-L58)
- [src/transformers/models/auto/configuration_auto.py:L34-L48](src/transformers/models/auto/configuration_auto.py#L34-L48)
- [src/transformers/models/auto/tokenization_auto.py:L63-L78](src/transformers/models/auto/tokenization_auto.py#L63-L78)
- [src/transformers/__init__.py:L171-L185](src/transformers/__init__.py#L171-L185)

## System Architecture: Bridging Concepts with Code Entities

### Model selection and input-processing map

The auto classes use a checkpoint configuration to resolve a concrete model class and import it on demand. The tokenizer or processor prepares the inputs that class expects. The pipeline API combines those components for common tasks. [src/transformers/models/auto/configuration_auto.py:L34-L48] [src/transformers/models/auto/modeling_auto.py:L41-L58] [src/transformers/models/auto/tokenization_auto.py:L63-L78]

**Diagram: From model type to public APIs**

\`\`\`mermaid
flowchart TD
  A["Select model and prepare inputs"] --> CONFIG["CONFIG_MAPPING_NAMES"]
  A --> TOKEN["TOKENIZER_MAPPING_NAMES"]
  A --> MODEL["MODEL_MAPPING_NAMES"]
  CONFIG --> MODEL
  TOKEN --> TOKBASE["PreTrainedTokenizerBase and BatchEncoding"]
  MODEL --> MODELS["src/transformers/models/"]
  TOKBASE --> PROCESSOR["ProcessorMixin"]
  MODELS --> PIPE["pipeline and Pipeline"]
  PROCESSOR --> PIPE
  PIPE --> GEN["GenerationConfig and streamers"]
\`\`\`

**Section sources**
- [src/transformers/models/auto/modeling_auto.py:L41-L58](src/transformers/models/auto/modeling_auto.py#L41-L58)
- [src/transformers/models/auto/tokenization_auto.py:L63-L78](src/transformers/models/auto/tokenization_auto.py#L63-L78)
- [src/transformers/models/auto/configuration_auto.py:L34-L48](src/transformers/models/auto/configuration_auto.py#L34-L48)
- [src/transformers/__init__.py:L99-L111](src/transformers/__init__.py#L99-L111)

### Natural language concepts and repository entities

This map ties everyday words to the names you can search for in the code. The package root exposes \`GenerationConfig\` for decoding settings, along with streamers and training utilities. Use the auto mappings when you want to look up a particular model type. [src/transformers/__init__.py:L117-L157] [src/transformers/__init__.py:L160-L168] [src/transformers/__init__.py:L171-L185]

**Diagram: Concepts mapped to code names**

\`\`\`mermaid
flowchart LR
  A["Model architectures"] --> A1["MODEL_MAPPING_NAMES"] --> A2["albert to AlbertModel"] --> A3["src/transformers/models/"]
  B["Text input"] --> B1["TOKENIZER_MAPPING_NAMES"] --> B2["PreTrainedTokenizerBase"]
  C["Multimodal input"] --> C1["ProcessorMixin"]
  D["Task inference"] --> D1["pipeline and Pipeline"]
  E["Text generation"] --> E1["GenerationConfig"]
  F["Training utilities"] --> F1["TrainerCallback"]
\`\`\`

**Section sources**
- [src/transformers/models/auto/modeling_auto.py:L41-L58](src/transformers/models/auto/modeling_auto.py#L41-L58)
- [src/transformers/models/auto/tokenization_auto.py:L63-L78](src/transformers/models/auto/tokenization_auto.py#L63-L78)
- [src/transformers/__init__.py:L139-L170](src/transformers/__init__.py#L139-L170)
- [src/transformers/__init__.py:L171-L185](src/transformers/__init__.py#L171-L185)

## Exploration Guide to Child Pages

Use these pages for hands-on entry points and background:

- [Getting Started & Installation](getting-started-installation.md): choosing dependency extras and running a first pipeline. Packaging starts in \`setup.py\` and \`pyproject.toml\`.
- [Design Philosophy & V5 Migration Guide](design-philosophy-v5-migration-guide.md): how the modular generator keeps a single modeling file per model, and what v5 changes about weight loading and framework support.
- [Documentation Structure & Translations](documentation-structure-translations.md): how each language's \`_toctree.yml\` organizes guides and model documentation for the build.

The English documentation tree groups pages into getting started, base classes, inference and training sections. The README also links to translations. [docs/source/en/_toctree.yml:L1-L8] [docs/source/en/_toctree.yml:L76-L102] [docs/source/en/_toctree.yml:L179-L202] [README.md:L37-L59]

**Section sources**
- [docs/source/en/_toctree.yml:L1-L6](docs/source/en/_toctree.yml#L1-L6)
- [docs/source/en/_toctree.yml:L76-L102](docs/source/en/_toctree.yml#L76-L102)
- [docs/source/en/_toctree.yml:L179-L202](docs/source/en/_toctree.yml#L179-L202)
- [README.md:L37-L59](README.md#L37-L59)
`;

const playwrightOverview = `# Playwright Overview

<cite>
**Referenced Files in This Document**
- [README.md](README.md)
- [docs/src/intro-js.md](docs/src/intro-js.md)
- [docs/src/intro-python.md](docs/src/intro-python.md)
- [docs/src/intro-java.md](docs/src/intro-java.md)
- [docs/src/intro-csharp.md](docs/src/intro-csharp.md)
- [package.json](package.json)
- [packages/playwright-core/package.json](packages/playwright-core/package.json)
- [packages/playwright/package.json](packages/playwright/package.json)
- [packages/playwright-core/browsers.json](packages/playwright-core/browsers.json)
- [packages/playwright-core/src/protocol/protocol.yml](packages/playwright-core/src/protocol/protocol.yml)
- [packages/playwright-core/src/server/browserType.ts](packages/playwright-core/src/server/browserType.ts)
- [packages/playwright-core/src/client/page.ts](packages/playwright-core/src/client/page.ts)
- [utils/build/build.js](utils/build/build.js)
</cite>

## What Is Playwright

Playwright is Microsoft’s framework for cross-browser testing and web automation. A shared API controls Chromium, Firefox and WebKit, enabling scripted interactions, end-to-end tests, component tests and network interception across engines. [docs/src/intro-js.md:L8]

The repository is an npm workspace containing the test runner and browser automation packages. This snapshot uses development version \`1.64.0-next\`. [package.json:L4]

Main properties of the framework:

- **Cross-browser**: one API for Chromium, including Chrome and Edge, as well as Firefox and WebKit. [docs/src/intro-js.md:L8]
- **Cross-language**: JavaScript and TypeScript use the same browser automation API as the Python, Java and .NET bindings. [docs/src/intro-python.md:L1-L10] [docs/src/intro-java.md:L1-L10] [docs/src/intro-csharp.md:L8-L10]
- **Cross-platform**: runs on Windows, Linux and macOS, locally or in CI, headless or with a window. The getting-started guide covers running in containers. [docs/src/intro-js.md:L306-L308]
- **Built for tests**: \`@playwright/test\` supplies a full test runner with fixtures, parallel workers, retries and reporting. [README.md:L23-L25]
- **Tooling** — The Inspector lets you step through browser actions. Codegen records them as a script, and Trace Viewer helps inspect failures after a run. [README.md:L40-L52] [README.md:L88-L90]
- **Agent integration** — The project provides a CLI and an MCP server that a coding agent can use to drive a browser. [README.md:L7]

For a deeper look at how the layers talk to each other, see the [Core Architecture](core-architecture.md) page. For the workspace layout, see [Package Structure](package-structure.md).

**Section sources**
- [docs/src/intro-js.md:L8](docs/src/intro-js.md#L8)
- [package.json:L4](package.json#L4)
- [docs/src/intro-python.md:L1-L10](docs/src/intro-python.md#L1-L10)
- [docs/src/intro-java.md:L1-L10](docs/src/intro-java.md#L1-L10)
- [docs/src/intro-csharp.md:L8-L10](docs/src/intro-csharp.md#L8-L10)
- [docs/src/intro-js.md:L306-L308](docs/src/intro-js.md#L306-L308)
- [README.md:L23-L25](README.md#L23-L25)
- [README.md:L88-L90](README.md#L88-L90)
- [README.md:L7](README.md#L7)

---

## Key Capabilities

| Capability | What it gives you | Main API or package |
|------------|-------------------|---------------------|
| Browser automation | Launch browsers, open pages and interact with elements | \`playwright\`, \`playwright-core\` |
| End-to-end testing | Test runner with fixtures, parallel workers and sharding | \`@playwright/test\` |
| Network control | Intercept requests on one page or across a browser context | \`Page.route()\` and \`BrowserContext.route()\` |
| API testing | Send HTTP requests that share cookies with the browser | \`APIRequestContext\` |
| Component testing | Mount React and Vue components in isolation with real browsers | experimental component packages |
| Code generation | Record user actions and turn them into a script | \`playwright codegen\` |
| Tracing | Capture DOM snapshots, network and console for every step | \`context.tracing\` |
| UI mode | Watch, step through and re-run tests interactively | \`playwright test --ui\` |
| MCP server | Let a coding assistant drive a browser | \`@playwright/mcp\` |

**Section sources**
- [README.md:L11-L19](README.md#L11-L19)
- [README.md:L40-L52](README.md#L40-L52)
- [packages/playwright/package.json:L1-L40](packages/playwright/package.json#L1-L40)
- [packages/playwright-core/package.json:L1-L30](packages/playwright-core/package.json#L1-L30)

---

## Supported Languages

The JavaScript/TypeScript implementation lives in this repository. The other bindings live in their own repositories, speak the same protocol to the same server, and are released in step with it. [packages/playwright-core/src/protocol/protocol.yml:L1-L40]

| Language | Package | Notes |
|----------|---------|-------|
| JavaScript / TypeScript | \`playwright\`, \`@playwright/test\` | Reference implementation, in this repository [package.json:L1-L8] |
| Python | \`playwright\` on PyPI | Sync and async APIs |
| Java | \`com.microsoft.playwright\` | Maven artifacts |
| .NET | \`Microsoft.Playwright\` | Works with MSTest, NUnit and xUnit |

**Section sources**
- [packages/playwright-core/src/protocol/protocol.yml:L1-L40](packages/playwright-core/src/protocol/protocol.yml#L1-L40)
- [package.json:L1-L8](package.json#L1-L8)

---

## Repository Organization

The root manifest declares the npm workspace. Its \`packages/\` directory contains the test runner, the public API and the engine-specific browser packages. [package.json:L55-L57]

### Monorepo Package Dependency Graph

\`\`\`mermaid
flowchart TD
  T["@playwright/test (test runner entry)"] --> P["playwright (runner, reporters, fixtures)"]
  CT["experimental component testing"] --> P
  P --> C["playwright-core (client, server, protocol)"]
  BC["playwright-chromium"] --> C
  BF["playwright-firefox"] --> C
  BW["playwright-webkit"] --> C
  C --> B["browsers.json (pinned revisions)"]
\`\`\`

### Package Summary

| Package | Purpose |
|---------|---------|
| \`playwright-core\` | Browser launchers, the protocol, and shared client and server automation primitives [packages/playwright-core/package.json:L4-L32] |
| \`playwright\` | Test runner, reporters and fixtures, built on the core [packages/playwright/package.json:L1-L40] |
| \`@playwright/test\` | Public test runner entry point. It depends on \`playwright\` for browser control. [packages/playwright-test/package.json:L32-L34] |
| \`playwright-chromium\` | Installs only the Chromium build |
| \`playwright-firefox\` | Installs only the Firefox build |
| \`playwright-webkit\` | Installs only the WebKit build |

**Section sources**
- [packages/playwright-core/package.json:L1-L30](packages/playwright-core/package.json#L1-L30)
- [packages/playwright/package.json:L1-L40](packages/playwright/package.json#L1-L40)
- [package.json:L9-L14](package.json#L9-L14)

---

## Browser Support

Each release pins browser-specific revisions. The installer reads the browser manifest to select the right binaries, so a release uses consistent browser versions in development and CI. [packages/playwright-core/browsers.json:L1-L40]

Maintainers update those revisions with the \`roll\` script in the root manifest. For details on where Playwright installs the binaries and how it resolves an executable, see [Browser Installation and Registry](browser-installation-and-registry.md). [package.json:L46]

| Browser | Engine | Notes |
|---------|--------|-------|
| Chromium | Blink | A browser channel selects an installed Chrome or Edge build |
| Firefox | Gecko | A patched build that exposes the automation protocol |
| WebKit | WebKit | Same engine as Safari, on every desktop platform |
| Headless shell | Blink | Smaller build used for headless runs |

The \`examples/\` folder contains runnable projects demonstrating common setups. On Linux, \`install-deps\` installs system packages the browsers require. [README.md:L11-L19] [README.md:L60-L70]

**Section sources**
- [packages/playwright-core/browsers.json:L1-L40](packages/playwright-core/browsers.json#L1-L40)
- [README.md:L60-L70](README.md#L60-L70)

---

## High-Level Architecture

The code is split into layers so that several languages, remote browsers and different engines can share the same core.

### System Layers and Code Locations

\`\`\`mermaid
---
config:
  flowchart:
    rankSpacing: 30
    padding: 10
---
flowchart TD
  U["Your test or script"] --> CL["Client API: Browser, Page, Locator"]
  CL --> PR["Protocol messages (shared by all languages)"]
  PR --> SV["Server: dispatchers and browser types"]
  SV --> EN["Per-engine adapters: Chromium, Firefox, WebKit"]
\`\`\`

Client objects such as the \`Page\` class send messages through channels defined by Playwright’s protocol. A server dispatcher routes each call to the implementation for the selected browser engine. [packages/playwright-core/src/client/page.ts:L80-L140] [packages/playwright-core/src/server/browserType.ts:L60-L120]

The detailed documentation for each layer starts here.

- [Core Architecture](core-architecture.md): client API, protocol, server dispatchers and browser adapters.
- [Package Structure](package-structure.md): the workspace layout and how packages depend on each other.

**Section sources**
- [packages/playwright-core/src/client/page.ts:L80-L140](packages/playwright-core/src/client/page.ts#L80-L140)
- [packages/playwright-core/src/server/browserType.ts:L60-L120](packages/playwright-core/src/server/browserType.ts#L60-L120)
- [packages/playwright-core/src/protocol/protocol.yml:L1-L40](packages/playwright-core/src/protocol/protocol.yml#L1-L40)

---

## Major Subsystems Overview

This map shows the main areas of the repository and where to read about them.

\`\`\`mermaid
flowchart TD
  A["Integrations<br/>Component testing, MCP, Electron"] --> B["Developer tools<br/>Inspector, trace viewer, UI mode"]
  B --> C["Test framework<br/>Runner, fixtures, reporting"]
  C --> D["Core API<br/>Pages, locators, network routing"]
  D --> E["Browser management<br/>Launch, install, browser channels"]
\`\`\`

Continue with [Developer Tools](developer-tools.md) and [Test Framework](test-framework.md) for writing tests, or [Core API](core-api.md) and [Browser Management](browser-management.md) for browser control.

**Section sources**
- [package.json:L18-L51](package.json#L18-L51)
- [README.md:L11-L19](README.md#L11-L19)

---

## Build and Development Scripts

The root manifest defines the scripts for building workspace packages, checking the code, running library tests and updating browser binaries. [package.json:L18-L51]

### Key npm Scripts

| Script | Purpose | Where it is defined |
|--------|---------|---------------------|
| \`build\` | Compile and bundle the packages through \`utils/build/build.js\` | [package.json:L43] |
| \`lint\` | Check types, docs and dependencies | [package.json:L37-L38] |
| \`test\` | Run the library suite with its Playwright config | [package.json:L31] |
| \`roll\` | Update browser engine revisions | [package.json:L46] |
| \`playwright-cli\` | Start the automation CLI | [package.json:L51] |

**Section sources**
- [utils/build/build.js:L1-L50](utils/build/build.js#L1-L50)
- [package.json:L15-L40](package.json#L15-L40)

---

## Version Management

All packages share one version number from the root manifest. The snapshot also declares versions of TypeScript, Vite and the Model Context Protocol SDK for building packages, generating the protocol and running developer tools. [package.json:L1-L8] [package.json:L115-L117]

- The root manifest holds the current version. [package.json:L3-L4]
- The lock file keeps dependencies consistent across machines. [package-lock.json:L3]
- The manifest requires Node.js 20 or later. [package.json:L12]

**Section sources**
- [package.json:L1-L14](package.json#L1-L14)
- [package.json:L41-L44](package.json#L41-L44)

---

Use this overview for orientation when choosing a browser engine, a language binding or the test runner. For details on the internal protocol and where each client talks to the browser server, start with [Core Architecture](core-architecture.md). For workspace packages and their dependencies, see [Package Structure](package-structure.md).

The examples provide a starting point for testing common scenarios. The README covers browser setup and links to the guides for interactive test development and trace review. [README.md:L11-L19] [README.md:L88-L90]
`;

const mineruOverview = `# MinerU Overview

<cite>
**Referenced Files in This Document**
- [README.md](README.md)
- [README_zh-CN.md](README_zh-CN.md)
- [docs/next/architecture.md](docs/next/architecture.md)
- [docs/en/quick_start/index.md](docs/en/quick_start/index.md)
- [docs/en/reference/changelog.md](docs/en/reference/changelog.md)
- [docs/en/usage/index.md](docs/en/usage/index.md)
- [mineru/utils/config_reader.py](mineru/utils/config_reader.py)
</cite>

MinerU 4.x combines a parsing toolkit with a searchable library. It converts documents such as PDFs, scans and Office files (\`.doc\`, \`.docx\`, \`.ppt\`, \`.pptx\`, \`.xls\`, \`.xlsx\`), EPUB, HTML, OFD and CSV into Markdown or structured JSON. [README.md:L3] [README_zh-CN.md:L3] The outputs are designed for building retrieval-augmented generation pipelines, training language models and agent-assisted document reading. They retain structure by preserving multi-column reading order, LaTeX formulas and nested tables. [README.md:L3] [README_zh-CN.md:L3]

**Section sources**
- [README.md:L3](README.md#L3)
- [README_zh-CN.md:L3](README_zh-CN.md#L3)

---

## Core Architecture & Subsystem Split

MinerU’s package split is one-off conversion vs. persistent document storage. The toolkit and the library use the same base parser and output formats. [docs/next/architecture.md:L6-L25]

1. **Parsing toolkit (stateless)** — The \`mineru-kit\` package provides \`mineru-kit parse\` for local conversion and \`mineru-kit api-server\` for accepting jobs from an application. Its web interface, multi-worker router and model-serving endpoint can run standalone. [docs/en/quick_start/index.md:L39-L43] [docs/zh/quick_start/index.md:L40-L44]
2. **Document library (stateful)** — The \`mineru\` package runs Doclib, a local FastAPI service with SQLite and FTS5 search. It tracks background jobs and uses SHA-256 file hashes to detect duplicates. The service calls \`MinerUParser\` and indexes the result, so readers can search the text or jump to a location after conversion. [docs/next/architecture.md:L18-L43] [docs/en/quick_start/index.md:L62-L64] [docs/zh/quick_start/index.md:L63-L65]

### Subsystem and Code Entity Mapping

This diagram maps natural language tasks to the code paths for conversion, storage and search.

\`\`\`mermaid
---
title: Doclib and CLI architecture
---
flowchart TD
  CLI["Standalone CLI"] --> COMMAND["mineru-kit parse"]
  API["HTTP conversion"] --> ROUTER["mineru-kit router"]
  LIB["Document library"] --> QUEUE["Doclib parse job"]
  COMMAND --> BACKEND["Parse backend"]
  ROUTER --> BACKEND
  QUEUE --> BACKEND
  BACKEND --> FILE["Markdown or JSON"]
  QUEUE --> INDEX["Doclib search index"]
\`\`\`

**Section sources**
- [docs/next/architecture.md:L6-L25](docs/next/architecture.md#L6-L25)
- [docs/en/quick_start/index.md:L39-L44](docs/en/quick_start/index.md#L39-L44)
- [docs/en/quick_start/index.md:L62-L64](docs/en/quick_start/index.md#L62-L64)
- [docs/zh/quick_start/index.md:L63-L65](docs/zh/quick_start/index.md#L63-L65)

---

## The DocVortex Boundary & Parsing Pipeline

The backend uses DocVortex to analyze raw document bytes, classify the layout and identify the page structure. MinerU handles backend selection, model execution and output formatting. [docs/next/architecture.md:L6-L15] [docs/en/reference/changelog.md:L5-L9]

A model-backed run can recognize tables and mathematical formulas and reconstruct reading order. MinerU can also apply language-model refinement after structure extraction. The backend sends a structured result to the toolkit or to Doclib for indexing. [docs/next/architecture.md:L6-L10] [docs/zh/reference/changelog.md:L9]

### Parsing Pipeline Code Entity Mapping

**Diagram: Parsing stages and code entry points**

\`\`\`mermaid
flowchart LR
  IN["Input file"] --> LD["Load and rasterise"]
  LD --> LA["Layout detection"]
  LA --> OCR["Text recognition"]
  LA --> TB["Tables"]
  LA --> FM["Formulas"]
  OCR --> RO["Reading order"]
  TB --> RO
  FM --> RO
  RO --> OUT["Markdown / JSON"]
\`\`\`

**Section sources**
- [docs/next/architecture.md:L5-L11](docs/next/architecture.md#L5-L11)
- [docs/en/reference/changelog.md:L5-L9](docs/en/reference/changelog.md#L5-L9)

---

## Quality Tiers & Engine Selection

The four quality tiers balance speed and resource use against extraction accuracy, from a fast preview to a vision-language analysis of document layout. [docs/en/reference/changelog.md:L38] [docs/zh/reference/changelog.md:L38]

- **Flash** — Use the native text layer or rule-based extraction to preview a file quickly without loading a model. [docs/en/reference/changelog.md:L45] [docs/zh/reference/changelog.md:L45]
- **Basic** — Use OCR and a model to detect text blocks and recognize their contents. [docs/en/reference/changelog.md:L38] [docs/zh/reference/changelog.md:L38]
- **Standard / Advanced** — Use vision-language model integration for document layout, mathematical formula recognition and complex table extraction. [docs/en/reference/changelog.md:L38] [docs/zh/reference/changelog.md:L38]

See [Quality Tiers & Engine Selection](quality-tiers-engine-selection.md) for available engines. Smaller OCR models can use ONNX or Torch, while vision-language models can run through llama.cpp, vLLM or LMDeploy. [docs/en/reference/changelog.md:L41] [docs/zh/reference/changelog.md:L41]

The tier governs how much analysis a job performs. The engine governs where and how the model runs. Set the two together when balancing processing time, device memory and output quality. The configuration reader loads the user's defaults. [docs/en/reference/changelog.md:L45] [mineru/utils/config_reader.py:L10-L60]

**Section sources**
- [docs/en/reference/changelog.md:L35-L43](docs/en/reference/changelog.md#L35-L43)
- [mineru/utils/config_reader.py:L10-L60](mineru/utils/config_reader.py#L10-L60)

---

## Child Pages

For a closer look at each part of the project, continue with these pages:

- [Getting Started & Installation](getting-started-installation.md) — Install with \`uv\` or \`pip\`, run \`mineru-kit models download\` to get the model weights, then try a first parse. [docs/en/quick_start/index.md:L5-L94] [docs/zh/quick_start/index.md:L5-L94]
- [Configuration Reference](configuration-reference.md) — Find the default settings in \`mineru.template.json\`, choose which model source to use, and configure the environment with \`MINERU_HOME\` or \`mineru config set\`. [docs/next/architecture.md:L43-L48]
- [Quality Tiers & Engine Selection](quality-tiers-engine-selection.md) — Choose a tier and a runtime for the small OCR model or vision-language model. [docs/en/usage/index.md:L7] [docs/zh/usage/index.md:L7]

**Section sources**
- [docs/en/quick_start/index.md:L5-L94](docs/en/quick_start/index.md#L5-L94)
- [docs/next/architecture.md:L43-L48](docs/next/architecture.md#L43-L48)
- [docs/en/usage/index.md:L1-L7](docs/en/usage/index.md#L1-L7)
`;

export const transformers = buildDemo({
  owner: 'huggingface', repo: 'transformers', stars: '166.2k', commit: '03238b25', lastIndexed: '2026-11-04T09:00:00Z',
  description: 'The model-definition framework for state-of-the-art machine learning models in text, vision, audio, and multimodal models.',
  pages: { Overview: transformersOverview }, tree: transformersTree,
});

export const playwright = buildDemo({
  owner: 'microsoft', repo: 'playwright', stars: '96.2k', commit: '343d8e7d', lastIndexed: '2026-10-15T09:00:00Z',
  description: 'A framework for Web Testing and Automation across Chromium, Firefox and WebKit with a single API.',
  pages: { 'Playwright Overview': playwrightOverview }, tree: playwrightTree,
});

export const mineru = buildDemo({
  owner: 'opendatalab', repo: 'MinerU', stars: '80.0k', commit: '06c3481e', lastIndexed: '2026-11-11T09:00:00Z',
  description: 'Transforms complex documents like PDFs and Office docs into LLM-ready markdown/JSON.',
  repositoryReadme: 'https://github.com/opendatalab/MinerU/blob/master/README.md',
  pages: { 'MinerU Overview': mineruOverview }, tree: mineruTree,
});

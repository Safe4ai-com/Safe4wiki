import { buildDemo } from './build.js';

const overview = `# VS Code Architecture Overview

<cite>
**Referenced Files in This Document**
- [package.json](package.json)
- [src/vs/workbench/workbench.desktop.main.ts](src/vs/workbench/workbench.desktop.main.ts)
- [src/vs/workbench/workbench.common.main.ts](src/vs/workbench/workbench.common.main.ts)
- [src/vs/workbench/browser/web.main.ts](src/vs/workbench/browser/web.main.ts)
- [remote/package.json](remote/package.json)
- [src/vs/editor/editor.all.ts](src/vs/editor/editor.all.ts)
- [src/vs/platform/configuration/common/configurationService.ts](src/vs/platform/configuration/common/configurationService.ts)
- [build/gulpfile.js](build/gulpfile.js)
</cite>

## Purpose and Scope

This overview maps the VS Code codebase for exploration, including the desktop, browser and remote server. The linked pages provide details about the source tree, architectural layers, development and contributions. Start with the root manifest for the names of the compilation and type-checking scripts. [package.json:L26-L31]

**Section sources**
- [package.json:L26-L31](package.json#L26-L31)

## Multi-Process Model

The desktop entry point loads the shared workbench before adding Electron services for native menus and dialogs. The browser entry point sets up the browser workbench with web-compatible services. The repository also has a \`remote/\` package that builds \`vscode-reh\`, which runs extensions and terminals on another machine. Follow these entry points to see where service registration begins for each runtime. [src/vs/workbench/workbench.desktop.main.ts:L13-L24] [src/vs/workbench/browser/web.main.ts:L12-L24] [remote/package.json:L1-L5]

### Multi-Process and Runtime Targets

**Diagram: Runtime entry-point landmarks**

\`\`\`mermaid
flowchart TD
  A["Electron desktop"] --> B["workbench.desktop.main.ts"]
  C["Browser workbench"] --> D["web.main.ts"]
  F["Remote server package"] --> G["remote/package.json"]
  B --> E["workbench.common.main.ts"]
  D --> E
\`\`\`

Follow the shared workbench entry point to see what the desktop and browser builds have in common. [src/vs/workbench/workbench.common.main.ts:L6-L16] For process lifecycles and IPC behavior, see [Application Lifecycle and Window Management](application-lifecycle-and-window-management.md).

**Section sources**
- [src/vs/workbench/workbench.desktop.main.ts:L13-L24](src/vs/workbench/workbench.desktop.main.ts#L13-L24)
- [src/vs/workbench/workbench.common.main.ts:L6-L16](src/vs/workbench/workbench.common.main.ts#L6-L16)
- [src/vs/workbench/browser/web.main.ts:L12-L24](src/vs/workbench/browser/web.main.ts#L12-L24)
- [remote/package.json:L1-L5](remote/package.json#L1-L5)

## Repository Structure and Build System

The root \`package.json\` lists compilation, watch and test scripts for the client, web workbench and CLI. Manifests in \`remote/\` and \`remote/web/\` describe dependencies for the server and web packages. The [Repository Structure and Build System](repository-structure-and-build-system.md) page covers the folder layout, CI pipeline and release tooling. [package.json:L12-L37] [remote/web/package.json:L1-L5]

Begin at the root scripts when tracing a build. The separate manifests mark the package boundaries for the remote server and the browser target. [package.json:L69-L81] [remote/package.json:L1-L5]

**Section sources**
- [package.json:L12-L37](package.json#L12-L37)
- [package.json:L69-L81](package.json#L69-L81)
- [remote/package.json:L1-L5](remote/package.json#L1-L5)
- [remote/web/package.json:L1-L5](remote/web/package.json#L1-L5)

## Core Architectural Layers

Code is split into layers that may only depend downwards: \`base\` holds general utilities, \`platform\` defines services and dependency injection, \`editor\` contains the text editor, and \`workbench\` assembles the full application. The shared composition file imports the editor and workbench contributions first, then the platform and workbench services they rely on. Imports show where things are wired together; the layering rules themselves are enforced by lint checks. [src/vs/workbench/workbench.common.main.ts:L6-L16] [src/vs/workbench/workbench.common.main.ts:L59-L76] [src/vs/workbench/workbench.desktop.main.ts:L13-L24]

Each runtime registers its own collection of implementations for shared service interfaces. The [Core Architectural Layers](core-architectural-layers.md) page explains dependency direction and how the layers are enforced.

**Section sources**
- [src/vs/workbench/workbench.common.main.ts:L6-L16](src/vs/workbench/workbench.common.main.ts#L6-L16)
- [src/vs/workbench/workbench.common.main.ts:L59-L76](src/vs/workbench/workbench.common.main.ts#L59-L76)
- [src/vs/workbench/workbench.desktop.main.ts:L13-L24](src/vs/workbench/workbench.desktop.main.ts#L13-L24)

## Major Subsystems

Start in the shared composition file to trace a subsystem, including extensions, search, notebooks and terminals. The desktop entry adds native services for tunnels and the agent host. An import shows where a feature is wired in. [src/vs/workbench/workbench.common.main.ts:L59-L115] [src/vs/workbench/workbench.desktop.main.ts:L35-L103]

| Area | Code landmarks | Where to explore |
|------|----------------|------------------|
| Editor and workbench | \`editor.all.js\`, \`editorService.js\` [src/vs/workbench/workbench.common.main.ts:L10-L11] [src/vs/workbench/workbench.common.main.ts:L59-L64] | [Monaco Editor Core](monaco-editor-core.md), [Workbench UI Framework](workbench-ui-framework.md) |
| Extensions | \`extensionHost.contribution.js\` [src/vs/workbench/workbench.common.main.ts:L92-L98] [src/vs/workbench/workbench.desktop.main.ts:L44-L48] | [Extension System](extension-system.md) |
| Terminal and notebooks | \`terminal.contribution.js\`, \`notebook.contribution.js\` [src/vs/workbench/workbench.common.main.ts:L104-L107] [src/vs/workbench/workbench.desktop.main.ts:L80-L84] | [Terminal](terminal.md), [Notebooks](notebooks.md) |
| Remote and agent host | \`remoteExplorerService.js\`, \`agentHostService.js\` [src/vs/workbench/workbench.common.main.ts:L103-L105] [src/vs/workbench/workbench.desktop.main.ts:L98-L101] | [Remote Development, Tunnels, and CLI Binaries](remote-development-tunnels-and-cli-binaries.md) |
| Search and source control | \`search.contribution.js\`, \`scm.contribution.js\` [src/vs/workbench/workbench.common.main.ts:L86-L91] [src/vs/workbench/workbench.common.main.ts:L99-L103] | [Search](search.md), [Source Control and Git](source-control-and-git.md) |

**Section sources**
- [src/vs/workbench/workbench.common.main.ts:L6-L16](src/vs/workbench/workbench.common.main.ts#L6-L16)
- [src/vs/workbench/workbench.common.main.ts:L59-L115](src/vs/workbench/workbench.common.main.ts#L59-L115)
- [src/vs/workbench/workbench.desktop.main.ts:L35-L103](src/vs/workbench/workbench.desktop.main.ts#L35-L103)

## Code Navigation and Services

A good way in is to pick an entry file and follow its imports. \`workbench.common.main.ts\` brings in the shared modules, while \`web.main.ts\` sets up the browser environment and then creates the \`Workbench\`. Services are requested through constructor injection, so searching for a service interface name usually leads straight to its implementation. [src/vs/workbench/workbench.common.main.ts:L6-L16] [src/vs/workbench/browser/web.main.ts:L12-L24]

### Natural Language to Core Workbench Code

**Diagram: User-facing concerns and code landmarks**

\`\`\`mermaid
flowchart LR
  subgraph NL["Natural language"]
    A["Edit text"]
    B["Configure the workbench"]
    C["Connect to remote resources"]
  end
  subgraph CE["Code entities"]
    D["editor.all.js"]
    E["configurationService.js"]
    F["RemoteAgentService"]
    G["workbench.common.main.ts"]
    H["web.main.ts"]
  end
  A --> D
  B --> E
  C --> F
  D --> G
  F --> H
\`\`\`

Editing features come in through the editor bundle, settings through the configuration service, and remote connections through the remote agent service. The shared entry point is a useful map of the workbench services. Look in the browser entry point for the services specific to that runtime. [src/vs/workbench/workbench.common.main.ts:L8-L12] [src/vs/workbench/workbench.common.main.ts:L71-L75] [src/vs/workbench/browser/web.main.ts:L12-L21]

**Section sources**
- [src/vs/workbench/workbench.common.main.ts:L8-L12](src/vs/workbench/workbench.common.main.ts#L8-L12)
- [src/vs/workbench/workbench.common.main.ts:L71-L75](src/vs/workbench/workbench.common.main.ts#L71-L75)
- [src/vs/workbench/browser/web.main.ts:L12-L21](src/vs/workbench/browser/web.main.ts#L12-L21)

### Natural Language to Build and Test Scripts

**Diagram: Common development tasks and package scripts**

\`\`\`mermaid
---
config:
  flowchart:
    rankSpacing: 60
    nodeSpacing: 73
---
flowchart LR
  subgraph NL["Natural language"]
    A["Build the client"]
    B["Build for web"]
    C["Run Node unit tests"]
    D["Run browser unit tests"]
  end
  subgraph PS["package.json scripts"]
    E["compile-client"]
    F["compile-web"]
    G["test-node"]
    H["test-browser"]
  end
  A --> E
  B --> F
  C --> G
  D --> H
\`\`\`

All of these commands live in the root manifest. Setup and launch instructions are in [Getting Started: Development Environment](getting-started-development-environment.md). [package.json:L12-L18] [package.json:L26-L31] [package.json:L76-L81]

**Section sources**
- [package.json:L12-L18](package.json#L12-L18)
- [package.json:L26-L31](package.json#L26-L31)
- [package.json:L76-L81](package.json#L76-L81)

## Getting Started

The root package has scripts for compiling, watching for changes and running the \`test-node\` and \`test-browser\` suites. [package.json:L12-L18] [package.json:L26-L37]

Environment setup and launch configurations are covered in [Getting Started: Development Environment](getting-started-development-environment.md).

**Section sources**
- [package.json:L12-L18](package.json#L12-L18)
- [package.json:L26-L37](package.json#L26-L37)

## Contribution Workflow and Repo Automation

Maintenance scripts such as \`precommit\`, \`eslint\` and \`hygiene\` keep the code base consistent, and Gulp tasks drive the larger build steps. [package.json:L58-L59] [package.json:L82-L89]

Review rules, workflows and automation are described in [Contribution Workflow and Repo Automation](contribution-workflow-and-repo-automation.md).

**Section sources**
- [package.json:L58-L59](package.json#L58-L59)
- [package.json:L82-L89](package.json#L82-L89)

## Child Pages

- [Repository Structure and Build System](repository-structure-and-build-system.md)
- [Core Architectural Layers](core-architectural-layers.md)
- [Getting Started: Development Environment](getting-started-development-environment.md)
- [Contribution Workflow and Repo Automation](contribution-workflow-and-repo-automation.md)

**Section sources**
- [package.json:L12-L37](package.json#L12-L37)
- [src/vs/workbench/workbench.common.main.ts:L6-L16](src/vs/workbench/workbench.common.main.ts#L6-L16)
- [src/vs/workbench/workbench.desktop.main.ts:L13-L24](src/vs/workbench/workbench.desktop.main.ts#L13-L24)
`;

export default buildDemo({
  owner: 'microsoft',
  repo: 'vscode',
  description: 'Visual Studio Code',
  stars: '192.6k',
  commit: '819bb821',
  lastIndexed: '2026-11-10T09:00:00Z',
  pages: { 'VS Code Architecture Overview': overview },
  tree: [
    ['VS Code Architecture Overview', ['Repository Structure and Build System', 'Core Architectural Layers', 'Getting Started: Development Environment', 'Contribution Workflow and Repo Automation']],
    ['Electron Main Process', ['Application Lifecycle and Window Management', 'CLI and Environment Services']],
    ['Workbench UI Framework', ['Layout and Parts System', 'Editor Groups and Editor Service', 'Views, Panels, and Activity Bar', 'Theming, Icons, and Styling', 'Settings, Keybindings, and Configuration', 'Common UI Widgets and Dialogs']],
    ['Monaco Editor Core', ['Text Model and View Model', 'Editor Rendering and Input Handling', 'Language Features and Editor Contributions', 'Inline Completions and Ghost Text']],
    ['Extension System', ['Extension Host Architecture', 'VS Code Extension API', 'Extension Marketplace and Management', 'Webview and Custom Editors']],
    ['Terminal', ['Terminal Architecture and Process Management', 'Shell Integration and Terminal Contributions', 'Terminal Chat Agent Tools']],
    ['AI and Copilot Features', ['Chat Service and Widget', 'Chat Editing and Agent Sessions', 'Inline Chat', 'Copilot Extension: Agent Orchestration', 'Copilot CLI and Cloud Sessions', 'Prompt Syntax and Custom Instructions', 'MCP (Model Context Protocol) Integration', ['Agent Host Platform', ['Agent Host Protocol, State, and Session Lifecycle', 'Agent Providers: Copilot, Claude, and Codex', 'Agent Host Git, Changesets, and Pull Request Operations', 'Remote Agent Hosts and Transports']]]],
    ['Notebooks', ['Notebook Editor Architecture', 'Notebook Kernels and Extension API', 'Notebook Diff Editor and Interactive Window']],
    ['Source Control and Git', ['SCM Framework', 'Git Extension']],
    ['Debugging', ['Debug Service and Session Lifecycle', 'Debug Configuration and Adapters']],
    ['Search', ['Search Service and Engines', 'Search UI and Quick Access']],
    ['Tasks and Testing', ['Task System', 'Test Explorer']],
    ['Remote Development, Tunnels, and CLI Binaries', ['Remote Extension Host Server', 'CLI Tunnel Client (Rust)', 'Copilot CLI Shim (Rust)']],
    ['Platform Services', ['File System Service', 'Authentication and User Accounts', 'User Data Sync and Profiles', 'Workspace Trust and Comments', 'Welcome, Getting Started, and Release Notes']],
    ['Agents Window (Sessions Layer)', ['Sessions Architecture and Provider Model', 'Agents Window UI and Layout', 'Agents Window Contributions (Changes, GitHub, Feedback)', 'Session Automations']],
    ['Accessibility', ['Accessible View and Signals', 'Accessibility Integrations Across Workbench Features']],
    ['Testing Infrastructure', ['Unit and Integration Tests', 'Smoke Tests and Automation']],
    ['Built-in Language Extensions', ['TypeScript Language Features Extension', 'Markdown, HTML, CSS, and JSON Language Extensions']],
    'Glossary',
  ],
});

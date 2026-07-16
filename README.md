# `devlensio` — The DevLens Analysis Engine

[![npm: devlensio](https://img.shields.io/badge/npm-devlensio-cb3837?logo=npm)](https://www.npmjs.com/package/devlensio)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

The core engine behind [DevLens](https://github.com/devlensio/devlensOSS) — the codebase visualizer. It turns a TypeScript / JavaScript / React / Next.js / Node.js repository into a **typed code graph** with functional summaries, technical summaries, and security analysis on every node.

The user-facing tools — CLI, MCP server, Agent Skill, and Web UI — all live in [DevLens OSS](https://github.com/devlensio/devlensOSS) and consume this package.

---

## What it does

```
Repo path
   │
[1] Fingerprint     → detect language, framework, router, state manager, data layer
[2] Route detection → extract routes (Next.js, React Router, Express, Fastify, Koa)
[3] AST parsing      → walk every .ts/.tsx/.js/.jsx → extract nodes with types
[4] Edge detection   → map CALLS, IMPORTS, PROP_PASS, WRITES_TO, and 12 more edge types
[5] Scoring          → multi-pass importance scoring (no AI, deterministic)
[6] Clustering       → assign cohesive clusters
[7] Summarize (opt)  → topological LLM summaries — functional + technical + security
   │
   ▼
Graph saved to ~/.devlens  →  queried via the traversal API / CLI / MCP / UI
```

Structural analysis is fast and deterministic. Summarization is the only step that calls an LLM — and unchanged nodes are reused across commits (90%+ free on re-runs).

---

## Install

```bash
npm install devlensio
# or
bun add devlensio
```

Requires Node 18+ (or Bun). An LLM provider key is only needed for AI summarization — structural analysis works offline.

---

## Public API

```typescript
import {
  analyzePipeline,        // Build a graph from a repo
  runSummarization,       // Generate AI summaries (functional, technical, security)
  buildGraphIndex,        // Index nodes + edges for traversal
  getBlastRadius,         // Upstream dependents — "what breaks if I change this?"
  getKHop,                // Downstream dependencies — "what does this depend on?"
  getSubgraph,            // Cohesive cluster around a seed node
  findCycles,             // Circular dependency groups
  resolveConfig,
  initConfig,             // LLM provider config
} from "devlensio";

// Analyze a repo
const result = await analyzePipeline("/path/to/repo");

// Traverse the graph
const index = buildGraphIndex(result.allNodes, result.allEdges);
const impact = getBlastRadius(index, "src/auth/login.ts::login", { radius: 2 });
const cycles = findCycles(result.allNodes, result.allEdges);
```

Also exported: all core types (`CodeNode`, `CodeEdge`, `NodeType`, `EdgeType`, …) and config helpers. See `dist/index.d.ts` for the full surface.

---

## Node & edge types

**Node types**

| Type | What it represents |
| :-- | :-- |
| `COMPONENT` | React / UI component |
| `HOOK` | React custom hook |
| `FUNCTION` | Plain function |
| `STATE_STORE` | State management (Zustand, Redux, etc.) |
| `UTILITY` | Utility / helper module |
| `FILE` | File-level node |
| `ROUTE` | Application route |
| `TEST` | Test file |
| `THIRD_PARTY` | External dependency |

**Edge types**

`CALLS`, `IMPORTS`, `READS_FROM`, `WRITES_TO`, `PROP_PASS`, `EMITS`, `LISTENS`, `WRAPPED_BY`, `GUARDS`, `HANDLES`, `TESTS`, `USES`, `NEXTJS_API_CALL`, `NAVIGATES_TO`

Each node carries: **importance score** + **functional summary** + **technical summary** + **security assessment** (severity + notes).

---

## Configuration

For summarization, configure your LLM provider in `~/.devlens/config.json` or via environment:

```env
LLM_PROVIDER=openrouter     # ollama | openai | anthropic | openrouter | gemini
LLM_MODEL=grok-4.1-fast
LLM_API_KEY=your_key        # Not needed for Ollama
LLM_BASE_URL=               # e.g. http://localhost:11434 for Ollama
```

Supported providers: **Anthropic**, **OpenAI**, **OpenRouter**, **Gemini**, **Ollama** (local).

---

## Repository layout

```
src/
├── fingerprint/    # Detect framework, language, router, state, data layer
├── filesystem/     # Route detection (Next.js, React Router, Express, etc.)
├── parser/         # AST extraction → nodes (ts-morph)
├── graph/          # Edge detectors, traversal API, lookup maps
├── scoring/        # Multi-pass importance scoring + noise filtering
├── clustering/     # Cohesive cluster computation
├── summarizer/     # LLM summarization pipeline, prompts, checkpoints
├── pipeline/       # analyzePipeline — orchestrates everything
├── jobs/           # Job queue, concurrency, SSE progress
├── storage/        # File-based graph persistence (~/.devlens)
├── config/         # Provider config resolution
├── server/         # HTTP API server (consumed by Web UI)
└── debug/          # Export and dev utilities
```

---

## Scripts

| Command | What it does |
| :-- | :-- |
| `bun run dev` | Watch-mode HTTP server |
| `bun run start` | Run the HTTP server |
| `bun run build` | Build `dist/` (the published artifact) |
| `bun test` | Run the test suite |
| `bun run export-graph` | Dump a graph for debugging |

---

## Relationship to DevLens OSS

`devlensio` is published to npm and consumed by [DevLens OSS](https://github.com/devlensio/devlensOSS), which provides the CLI, MCP server, Agent Skill, and Web UI on top of this engine.

The CLI binaries bundle whatever version of `devlensio` resolves at build time — so engine fixes ship to users after a `devlensio` release **and** a bump of the dependency pin in DevLens OSS.

---

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a hosted service, you must release your modifications under the same license.
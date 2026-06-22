# devlensio — the DevLens analysis engine

[![npm: devlensio](https://img.shields.io/badge/npm-devlensio-cb3837?logo=npm)](https://www.npmjs.com/package/devlensio)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

The core engine behind [DevLens](https://github.com/devlensio/devlensOSS). It turns a TypeScript / JavaScript / React / Next.js / Node.js repository into a **typed code graph** — nodes (components, hooks, functions, stores, routes, files, …) joined by typed edges — scores every node by architectural importance, optionally **summarizes** each node with an LLM (technical / business / security), and exposes a **traversal/query API**.

`devlensio` is a **library + local server**. The user-facing tools — the `devlens` CLI, the MCP server, the Agent Skill, and the Web UI — live in [DevLens OSS](https://github.com/devlensio/devlensOSS) and consume this package.

---

## Install

```bash
npm install devlensio
# or: bun add devlensio
```

Requires Node 18+ (or Bun). An LLM provider key is needed only for summarization, not for structural analysis.

---

## What it does (the pipeline)

```
Repo path
   │
[1] Fingerprint     detect language, framework, router, state manager, data layer, databases
[2] Filesystem scan extract routes (Next.js app/pages, Express, Fastify, Koa)
[3] Parse (ts-morph) walk every .ts/.tsx/.js/.jsx → nodes (typed params, return types, prop types)
[4] Edge detection  many detectors → CALLS, IMPORTS, READS_FROM, WRITES_TO, PROP_PASS, EMITS,
                    LISTENS, WRAPPED_BY, GUARDS, HANDLES, TESTS, USES
[5] Scoring         multi-pass importance scoring + noise filtering (no AI)
[6] Clustering      cohesive cluster assignment
[7] Summarize       (optional) topologically-ordered LLM summaries, checkpoint/resume, MapReduce
   │
   ▼
Graph persisted to ~/.devlens  →  queried via the traversal API / CLI / MCP / UI
```

Structural analysis is fast and deterministic; summarization is the only step that calls an LLM and reuses unchanged nodes across commits.

---

## Public API

```ts
import {
  analyzePipeline,        // build the graph (nodes, edges, scores)
  runSummarization,       // generate technical/business/security summaries
  computeClusters,        // cohesive clustering
  buildGraphIndex,        // index nodes+edges for traversal
  getBlastRadius,         // upstream dependents ("what breaks if I change this")
  getKHop,                // downstream dependencies ("what this needs")
  getSubgraph,            // cohesive cluster around a seed
  findCycles,             // circular-dependency groups
  resolveConfig, initConfig,   // LLM provider config (~/.devlens/config.json)
  storage, queue,         // file-based graph storage + job queue singletons
} from "devlensio";

// Analyze a repo → graph
const result = await analyzePipeline("/path/to/repo", /* isGithubRepo */ false);
// result.allNodes, result.allEdges, result.nodeScores

// Query the graph
const index  = buildGraphIndex(result.allNodes, result.allEdges);
const impact = getBlastRadius(index, "src/auth/login.ts::login", { radius: 2 });
const cycles = findCycles(result.allNodes, result.allEdges);
```

Also exported: all core types (`CodeNode`, `CodeEdge`, `NodeType`, `EdgeType`, …), config helpers (`maskConfig`, `writeConfig`), pre-scan helpers (`readPackageDependencies`, `categorizeLibrary`), and `EDGE_LABELS`. See `dist/index.d.ts` for the full surface.

### Node & edge types

- **Node types:** `COMPONENT`, `HOOK`, `FUNCTION`, `STATE_STORE`, `UTILITY`, `FILE`, `ROUTE`, `TEST`, `STORY`, `THIRD_PARTY` (+ internal `GHOST`).
- **Edge types:** `CALLS`, `IMPORTS`, `READS_FROM`, `WRITES_TO`, `PROP_PASS`, `EMITS`, `LISTENS`, `WRAPPED_BY`, `GUARDS`, `HANDLES`, `TESTS`, `USES`.
- Each node carries an importance score and (after summarization) a technical summary, a business summary, and a security assessment (`none|low|medium|high` + notes).

---

## Configuration

Summarization config lives in `~/.devlens/config.json` (set via `initConfig`/`writeConfig`, or env vars loaded with dotenv). Supported providers: **Anthropic**, **OpenAI**, **OpenRouter**, **Gemini**, **Ollama** (local).

```env
LLM_PROVIDER=openrouter        # ollama | openai | anthropic | openrouter | gemini
LLM_MODEL=grok-4.1-fast
LLM_API_KEY=your_api_key       # not needed for ollama
LLM_BASE_URL=                  # e.g. http://localhost:11434 for Ollama
```

Graphs and config are stored under `~/.devlens` and shared with all DevLens tools.

---

## Repo layout

```
src/
├── fingerprint/   # detect framework, language, router, state, data layer, databases
├── filesystem/    # route detection (Next.js app/pages, Express, Fastify, Koa)
├── parser/        # ts-morph AST extraction → nodes
├── graph/         # edge detectors, traversal API, third-party libs, lookup maps
├── scoring/       # multi-pass importance scoring + noise filtering
├── clustering/    # cohesive cluster computation
├── summarizer/    # LLM summarization (technical/business/security), prompts, checkpoints
├── pipeline/      # analyzePipeline — orchestrates the whole analysis
├── jobs/          # job queue, concurrency, SSE progress events
├── storage/       # file-based graph persistence (~/.devlens)
├── config/        # provider config resolution
├── server/        # HTTP API server (consumed by the DevLens Web UI)
└── debug/         # exportGraph and dev utilities
```

---

## Scripts

| Script | Does |
| :-- | :-- |
| `bun run dev` | watch-mode HTTP server (`src/server/index.ts`) |
| `bun run start` | run the HTTP server |
| `bun run build` | `tsc --project tsconfig.build.json` → `dist/` (the published artifact) |
| `bun test` | run the test suite |
| `bun run export-graph` | dump a graph for debugging |

---

## Relationship to DevLens OSS

`devlensio` is published to npm and consumed by [DevLens OSS](https://github.com/devlensio/devlensOSS), which provides the `devlens` CLI (`@devlensio/cli`), the MCP server, the `/devlens` Agent Skill, and the Web UI on top of this engine. The CLI binaries bundle whatever version of `devlensio` resolves at build time, so engine fixes ship to users after a `devlensio` release **and** a bump of the dependency pin in DevLens OSS.

---

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a hosted service, you must release your modifications under the same license.

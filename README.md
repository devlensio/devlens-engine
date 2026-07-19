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
  resolveConfig,          // Resolve active provider config (flat)
  initConfig,             // LLM provider config
  loadCatalog,            // Provider catalog (name, label, protocol, baseUrl, requiresKey)
  findProvider,           // Look up a provider by name in the catalog
  listModels,             // Fetch live model list from a provider's models endpoint
  resolveAllProviders,    // Get all configured providers + active pointer
  setActiveProvider,      // Switch the active provider by composite key
  removeProviderConfig,   // Remove a provider entry (refuses active entry)
  writeConfig,            // Upsert a provider entry and mark it active
} from "devlensio";

// Analyze a repo
const result = await analyzePipeline("/path/to/repo");

// Traverse the graph
const index = buildGraphIndex(result.allNodes, result.allEdges);
const impact = getBlastRadius(index, "src/auth/login.ts::login", { radius: 2 });
const cycles = findCycles(result.allNodes, result.allEdges);

// Discover providers and their models
const catalog = loadCatalog();
const deepseekModels = await listModels({
  protocol: "openai",
  baseUrl: "https://api.deepseek.com",
  apiKey: "...",
});

// Multi-provider management
const allProviders = resolveAllProviders();
// → { active: "openai:deepseek", providers: [{ provider:"openai", providerName:"deepseek", ... }] }

setActiveProvider("openai:deepseek");   // Switch active provider
removeProviderConfig("anthropic:anthropic"); // Remove entry (throws if active)

// Upsert a provider entry (marks it active)
writeConfig({
  summarization: {
    provider: "openai",
    providerName: "deepseek",
    model: "deepseek-chat",
    baseUrl: "https://api.deepseek.com",
    batchSize: 50,
  },
});
```

Also exported: all core types (`CodeNode`, `CodeEdge`, `NodeType`, `EdgeType`, `CatalogProvider`, `ProviderConfigEntry`, `SummarizationConfig`, …) and config helpers. See `dist/index.d.ts` for the full surface.

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

### Provider model: protocol vs brand

The engine splits provider identity into two orthogonal concerns:

| Field | Meaning | Values |
| :-- | :-- | :-- |
| `provider` | Wire protocol (`"openai"` or `"anthropic"`) — routes to the correct SDK | `"openai"` / `"anthropic"` |
| `providerName` | Brand identity — picks `baseUrl` + key rules from the catalog, or a custom name | Any string (e.g. `"deepseek"`, `"my-gateway"`) |

### Multi-provider storage

`~/.devlens/config.json` now holds a **registry** of all configured providers, keyed by composite key (`${protocol}:${providerName}`), with one marked `active`:

```json
{
  "summarization": {
    "active": "openai:deepseek",
    "providers": {
      "openai:deepseek": {
        "provider": "openai",
        "providerName": "deepseek",
        "model": "deepseek-chat",
        "apiKey": "sk-...",
        "baseUrl": "https://api.deepseek.com",
        "batchSize": 50
      },
      "anthropic:anthropic": {
        "provider": "anthropic",
        "providerName": "anthropic",
        "model": "claude-haiku-4-5",
        "apiKey": "sk-...",
        "baseUrl": "https://api.anthropic.com",
        "batchSize": 50
      }
    }
  }
}
```

Key behaviours:
- **Saving a provider upserts it into the registry and marks it active** — previous entries are preserved.
- **Switching active is a separate operation** (`setActiveProvider()`) that rewrites only the `active` pointer.
- **Removing a provider** (`removeProviderConfig()`) refuses to delete the active entry — switch first.
- **Legacy flat configs auto-migrate** to the multi-provider format on first load.

### Environment variables

```env
DEVLENS_LLM_PROVIDER=openai          # Wire protocol — "openai" | "anthropic"
DEVLENS_LLM_PROVIDER_NAME=deepseek   # Brand — picks baseUrl + key rules from catalog
DEVLENS_LLM_MODEL=deepseek-chat
DEVLENS_LLM_KEY=your_key
DEVLENS_LLM_BASE_URL=                # Override base URL (optional)
```

### Config resolution priority

```
request headers (cloud)  >  config.json  >  env vars  >  catalog defaults  >  code defaults
```

### Provider catalog

A built-in catalog ships with the engine (`providers.default.json`) — no config required for known providers. Models are **never hardcoded** in the catalog; they are discovered dynamically from each provider's `/models` endpoint at runtime.

**Built-in providers:** DeepSeek, OpenAI, Anthropic, Google Gemini, Groq, Mistral, xAI Grok, OpenRouter, Ollama (local).

Extend or override via `~/.devlens/providers.json` (deep-merged by `name`):

```json
{
  "version": 2,
  "providers": [
    {
      "name": "my-gateway",
      "label": "My Gateway",
      "protocol": "openai",
      "baseUrl": "http://localhost:8080/v1",
      "requiresKey": false
    }
  ]
}
```

**Custom providers** can be added at any time — no engine update needed. Any provider not in the catalog is saved with its user-specified `baseUrl`, `protocol`, and `providerName`.

---

## How model discovery works

The engine exposes `listModels()` — a pure function with **two** lister branches matching the two protocols:

| Protocol | Endpoint | Covers |
| :-- | :-- | :-- |
| `openai` | `GET {baseUrl}/models` | openai, deepseek, groq, mistral, xai, gemini, openrouter, ollama, custom OpenAI-style |
| `anthropic` | `GET {baseUrl}/v1/models` (paginated) | anthropic, custom Anthropic-style |

A custom-model entry is always available — essential for OpenRouter's huge catalog and as a fallback when listing fails.

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
│   └── providers/  # Generic OpenAI & Anthropic clients, model discovery
├── pipeline/       # analyzePipeline — orchestrates everything
├── jobs/           # Job queue, concurrency, SSE progress
├── storage/        # File-based graph persistence (~/.devlens)
├── config/         # Provider config resolution (types, catalog, writer, env)
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

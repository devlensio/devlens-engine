# `devlensio` — The DevLens Analysis Engine

[![npm: devlensio](https://img.shields.io/badge/npm-devlensio-cb3837?logo=npm)](https://www.npmjs.com/package/devlensio)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

The core engine behind [DevLens](https://github.com/devlensio/devlensOSS) — the codebase visualizer.

Point it at any repository and it builds a **typed code graph**: every file, function, class, route, and data model becomes a *node*, connected by *edges* that show what imports what, what calls what, and how data flows. Each node gets an importance score and — optionally — an AI-generated functional, technical, and security summary.

It understands **6 languages out of the box** — TypeScript, JavaScript, Python, Java, Go, and Rust — with framework-aware parsing (React, Next.js, Express, Django, FastAPI, Spring Boot, Gin, Axum, and more). No tree-sitter, no generic AST guesswork: every language uses its own mature, native parser.

The user-facing tools — CLI, MCP server, Agent Skill, and Web UI — all live in [DevLens OSS](https://github.com/devlensio/devlensOSS) and consume this package.

---

## What it does

Analyzing a repo runs through a simple 7-step pipeline:

```
Repo path
   │
[1] Fingerprint     → which language & framework? (React, Express, Django, Spring, Gin, Axum …)
[2] Route detection → every URL the app serves, with the handler behind each route
[3] AST parsing      → per-language parser walks the source → typed nodes (files, functions, classes, structs, traits …)
[4] Edge detection   → links nodes: CALLS, IMPORTS, HANDLES, IMPLEMENTS, EXTENDS, READS_FROM, WRITES_TO + more
[5] Scoring          → deterministic importance scoring (no AI)
[6] Clustering       → groups related nodes into cohesive clusters
[7] Summarize (opt)  → LLM summaries — functional + technical + security
   │
   ▼
Graph saved to ~/.devlens → queried via the traversal API / CLI / MCP / UI
```

Structural analysis is fast and deterministic. Summarization is the only step that calls an LLM — and unchanged nodes are reused across commits (90%+ free on re-runs).

---

## Supported languages & frameworks

Every language uses a **native parser** — no tree-sitter. TypeScript/JavaScript is parsed inline by the engine; Python, Java, Go, and Rust each run a small language-native extractor that the engine orchestrates over JSON.

| Language | Extractor | Runtime needed on the analyzing machine | Frameworks detected (routes + data layer) |
| :-- | :-- | :-- | :-- |
| **TypeScript / JavaScript** | Inline (`ts-morph`) | none | React (incl. React Router), Next.js, Express, Fastify, Koa, Hono, Elysia, Bun |
| **Python** | Native (stdlib `ast`) | Python 3.11+ (private venv, auto-created) | Django, Flask, FastAPI, DRF · SQLAlchemy / Django ORM |
| **Java** | Native (JavaParser) | JVM 17+ | Spring Boot, Quarkus · JPA |
| **Go** | Native (prebuilt static binary) | none | net/http, Gin, Echo, Fiber · GORM, database/sql |
| **Rust** | Native (prebuilt static binary) | none | Axum, Actix-web, Rocket, utoipa-axum · Diesel |

**Zero-toolchain languages.** Go and Rust ship as prebuilt static binaries for Linux / macOS / Windows (amd64 + arm64), and the Java extractor ships as a prebuilt fat jar — no compiler, Maven, or Gradle needed where the analysis runs. Python creates a private `.venv` on install (idempotent, skipped if `python3` isn't found).

---

## Install

```bash
bun add devlensio
# or
npm install devlensio
```

The engine runs on **Bun** — its published entry imports from `bun` (used by the job queue), so plain-Node loading isn't supported. No LLM key is needed for structural analysis — it's fully offline and deterministic. Keys are only needed for AI summaries. See the language table above for per-language runtime requirements.

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

**Node types** — everything the graph knows about

| Type | What it means | Where you'll see it |
| :-- | :-- | :-- |
| `COMPONENT` | A React / UI component — something that renders UI | TS/JS |
| `HOOK` | A React custom hook (`useX`), including the state/functions it returns | TS/JS |
| `FUNCTION` | Any plain function — helper, callback, utility, serverless handler | TS/JS, Python, Go, Rust |
| `STATE_STORE` | A central state container (Zustand, Redux, …) | TS/JS |
| `UTILITY` | A helper module — code that isn't UI and isn't a component | TS/JS |
| `CLASS` | A class — a blueprint for objects (`class User {}`). JS ships props/state types & decorators for React class components | TS/JS, Python, Java |
| `METHOD` | A function attached to a class — shown as `ClassName.method` | TS/JS, Python, Java, Go, Rust |
| `INTERFACE` | A type contract — the shape implementing types must satisfy | Java, Go |
| `ENUM` | A fixed set of named values (e.g. `Status.Active`) | Java, Rust |
| `STRUCT` | A plain data structure with fields (record-like) | Go, Rust |
| `TRAIT` | Rust's version of an interface — a set of behaviors a type can implement | Rust |
| `IMPL_BLOCK` | A Rust `impl` block that adds methods & behavior to a type | Rust |
| `FILE` | One source file — the root node the rest of that file attaches to | every language |
| `ROUTE` | An application route — a URL the app serves, with the handler behind it | every language |
| `TEST` | A test file (`.test.tsx`, `_test.go`, `test_*.py`, …) | every language |
| `STORY` | A Storybook story file | TS/JS |
| `GHOST` | An invisible "event" node that ties event emitters to listeners via `EMITS` / `LISTENS` | TS/JS event graph |
| `THIRD_PARTY` | An external package/dependency — shown but not parsed | every language |
| `MODULE` / `PACKAGE` | Namespace / package node | reserved — not emitted yet |

**Edge types** — the arrows between nodes

| Edge | What it means | Where you'll see it |
| :-- | :-- | :-- |
| `CALLS` | A calls B — one function/method invokes another | all languages |
| `IMPORTS` | A file imports another file or package | all languages |
| `READS_FROM` | A reads data from B — a state store, model, or DB query (`User.objects.get`, `session.query(User)`, `db.Find`) | state + data layers (TS/JS, Python, Java, Go ORM) |
| `WRITES_TO` | A writes/updates data in B (`store.set(...)`, `user.save()`, `db.Create(...)`) | state + data layers (same as above) |
| `PROP_PASS` | A React prop flows from a parent component to a child | TS/JS |
| `EMITS` | A emits an event | TS/JS event graph |
| `LISTENS` | A subscribes to an event | TS/JS event graph |
| `WRAPPED_BY` | A is wrapped by B (e.g. a context provider wraps its consumers) | TS/JS |
| `GUARDS` | A guards B — a route guard / middleware protecting a route or handler | route layers |
| `HANDLES` | A route is handled by a handler — the controller/viewset/function behind a URL | all languages' routes |
| `TESTS` | A test file verifies the code it points to | all languages |
| `USES` | A JSX component uses an external function/hook internally | TS/JS |
| `NEXTJS_API_CALL` | A component fetches a Next.js API route | TS/JS Next.js |
| `NAVIGATES_TO` | Client-side navigation points to a route | TS/JS |
| `IMPLEMENTS` | A type implements a contract — class implements an interface, Go struct implements an interface, Rust type implements a trait | Java, Go, Rust, Python (ABC/Protocol) |
| `EXTENDS` | A inherits / embeds B — class extends a base class, Go struct embeds another, Rust supertrait | class-based languages |
| `EXPORTS` | reserved — declared, not yet emitted | — |
| `THROWS` | reserved — declared, not yet emitted | — |

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
├── parser/         # AST extraction → nodes (ts-morph) — the inline JS/TS extractor
├── extractors/     # Extractor registry, language detection, subprocess runner
├── graph/          # Edge detectors, traversal API, lookup maps
├── scoring/        # Multi-pass importance scoring + noise filtering + pruning
├── clustering/     # Cohesive cluster computation
├── summarizer/     # LLM summarization pipeline, prompts, checkpoints
│   └── providers/  # Generic OpenAI & Anthropic clients, model discovery
├── pipeline/       # analyzePipeline — orchestrates everything
├── jobs/           # Job queue, concurrency, SSE progress
├── storage/        # File-based graph persistence (~/.devlens)
├── config/         # Provider config resolution (types, catalog, writer, env)
├── server/         # HTTP API server (consumed by Web UI)
└── debug/          # Export and validation utilities

extractors/             # Native subprocess extractors (not part of the TS build)
├── python/             # Python extractor (stdlib `ast`, pip package, auto-venv)
├── java/               # Java extractor (JavaParser, prebuilt fat jar)
├── go/                 # Go extractor (go/ast + go/types, prebuilt static binary)
└── rust/               # Rust extractor (syn, prebuilt static binary)
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

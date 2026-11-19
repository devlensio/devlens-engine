export type Language = "javascript" | "typescript" | "python" | "java" | "go" | "rust" | "unknown";


export type Framework =
  | "nextjs"
  | "react"
  | "express"
  | "fastify"
  | "koa"
  | "hono"
  | "elysia"
  | "bun"

  // Python
  | "django"
  | "flask"
  | "fastapi"

  // Java
  | "spring-boot"
  | "quarkus"

  // Go
  | "gin"
  | "echo"
  | "fiber"
  | "net-http"

  // Rust
  | "actix-web"
  | "rocket"
  | "axum"

  | "unknown";


export type FrontendFramework = "nextjs" | "react";
export type BackendFramework = "express" | "fastify" | "koa" | "hono" | "elysia" | "bun";  // no unknown here


export type RouterType =
  | "app"
  | "pages"
  | "app+pages"
  | "react-router"
  | "none";


export type ProjectType = "frontend" | "backend" | "fullstack" | "unknown";

// ─── State Management 
export type StateLibrary =
  | "zustand"
  | "redux"
  | "recoil"
  | "jotai"
  | "context-only";

// ─── Data Fetching ───
export type DataFetchingLibrary = "react-query" | "swr" | "axios" | "fetch";

// ─── Databases ───────
export type DatabaseLibrary =
  | "prisma"
  | "drizzle"
  | "mongodb"
  | "firebase"
  | "supabase"
  | "planetscale"
  | "postgres"
  | "mysql"
  | "sqlite";

// ─── Project Fingerprint 
export interface ProjectFingerprint {
  language: Language;
  projectType: ProjectType;
  framework: Framework;
  router: RouterType;
  stateManagement: StateLibrary[];
  dataFetching: DataFetchingLibrary[];
  databases: DatabaseLibrary[];
  rawDependencies: Record<string, string>;
}

// ─── Filesystem Nodes 
export type RouteNodeType =
  | "PAGE"
  | "LAYOUT"
  | "API_ROUTE"
  | "LOADING"
  | "ERROR"
  | "MIDDLEWARE"
  | "NOT_FOUND"
  | "REACT_ROUTER_ROUTE";

export interface RouteNode {
  type: RouteNodeType;
  nodeId?:string;
  urlPath: string;
  filePath: string;
  isDynamic: boolean;
  isCatchAll: boolean;
  isGroupRoute: boolean;
  layoutPath?: string;
  params?: string[];
  httpMethods?: string[];
  rendersComponent?: string;  // React Router: component this route renders (<Route element={<Home/>}>)
}

export interface BackendRouteNode {
  type: "BACKEND_ROUTE";
  nodeId?:string;
  urlPath: string;
  filePath: string;
  httpMethod: string;
  handlerName?: string;
  framework: Framework;  // Changed from BackendFramework → Framework (supports all languages)
  isDynamic: boolean;
  params?: string[];
  inlineHandler?: {
    rawCode: string;
    startLine: number;
    endLine: number;
  }
}

// ─── Code Nodes ──────
export type NodeType =
  | "COMPONENT"
  | "HOOK"
  | "FUNCTION"
  | "STATE_STORE"
  | "UTILITY"
  | "FILE"
  | "GHOST"
  | "ROUTE"
  | "TEST"
  | "STORY"
  | "THIRD_PARTY"
  | "CLASS"
  | "METHOD"
  | "INTERFACE"
  | "ENUM"
  | "STRUCT"
  | "MODULE"
  | "TRAIT"
  | "IMPL_BLOCK"
  | "PACKAGE";

// Structured call-site record captured by every language extractor.
// metadata.calls (string[]) stays for compatibility; callSites adds the
// argument shape needed for overload-aware CALLS edge resolution.
//
// Since callOrder/v1 this is ONE RECORD PER OCCURRENCE (no more shape dedup),
// so `order` is the node's lexical call sequence. See docs/CALL_ORDER.md — that
// document is the contract; do not change a field's meaning without it.
export interface CallSite {
  name: string;                 // call expression text ("foo", "obj.method")
  argCount: number;             // number of arguments at the call site
  argTypes?: string[];          // cheaply-inferable arg types (literals, annotations)
  hasSpread?: boolean;          // call contains a spread argument (arity unknowable)

  // ── callOrder/v1 — all optional so old graphs and old extractors stay valid ──
  /** "call" (default) or "hook" (use*). Hooks are excluded from metadata.calls. */
  kind?: CallSiteKind;
  /** 1-based lexical rank among every recorded site of the owner node. */
  order?: number;
  /** 1-based line of the call expression in the file. */
  line?: number;
  /** 0-based column, so two calls on one line stay distinguishable. */
  col?: number;
  /** `order` of the enclosing call expression: foo(bar()) → bar.nested = foo.order. */
  nested?: number;
  /** Which execution region the site belongs to. Default "inline". */
  scope?: CallScope;
  /** The frame suspends on this call (await). */
  awaited?: boolean;
  /** When it runs relative to the frame. Absent = no evidence of detachment. */
  defer?: DeferKind;
  /** Provenance for the scheduler symbol ("tokio::spawn", "useEffect"). */
  deferDetail?: string;
  /** May run in parallel with the frame (thread / task / goroutine). */
  conc?: boolean;
  /** May execute 0..N times (loop body or iteration callback). */
  repeat?: boolean;
  /** May execute 0 times (branch / short-circuit / catch). */
  maybe?: boolean;
  /** Its result can abort the remaining calls in the block (Rust `?`). */
  earlyExit?: boolean;
}

export type CallSiteKind = "call" | "hook";

/**
 * Execution region of a call site.
 *   inline   — runs in the owner's frame body (normal straight-line path)
 *   callback — inside a callback/closure passed to a call (timer, promise, hook, map…)
 *   handler  — inside a JSX attribute expression / externally triggered registration
 *   nested   — inside a function declared inside the owner (it has no node of its own)
 *   module   — FILE node: runs at module load
 */
export type CallScope = "inline" | "callback" | "handler" | "nested" | "module";

/**
 * When a detached call runs relative to the frame. Absent = no evidence of
 * detachment (never a guarantee of inline execution).
 */
export type DeferKind =
  | "timer"      // macrotask: setTimeout, call_later, Timer, AfterFunc
  | "promise"    // continuation: .then, CompletableFuture, create_task, tokio::spawn
  | "microtask"  // queueMicrotask, process.nextTick, setImmediate
  | "event"      // externally triggered: addEventListener, JSX handler, signals
  | "postRender" // framework commit-phase: useEffect, onMounted, @PostConstruct
  | "onReturn"   // at frame exit, LIFO: Go defer, finally, Drop
  | "unknown";   // callback position detected, scheduler unclassifiable

/**
 * One entry of `metadata.resolvedCalls`: the first call site that resolved to a
 * local/third-party node. `callSites` keeps the complete per-occurrence truth;
 * this is the compact view a renderer needs for one edge, deliberately small so
 * the cloud can ship it as a jsonb slice.
 */
export interface ResolvedCall {
  name: string;             // declaration name the edge points at
  nodeId: string;
  firstOrder?: number;      // order of the first occurrence that resolved here
  line?: number;            // line of that occurrence
  defer?: DeferKind;
  deferDetail?: string;
  awaited?: boolean;
  conc?: boolean;
  repeat?: boolean;
  maybe?: boolean;
  /** Every ordinal that reached this target, ascending, only when > 1. The
   *  node carries the repeat positions itself so no consumer needs the edge
   *  mirror (docs/CALL_ORDER.md §3.2). */
  orders?: number[];
}

export interface CodeNode {
  id: string;
  name: string;
  type: NodeType;
  filePath: string;
  startLine: number;
  endLine: number;
  rawCode?: string; //! IMPORTANT: never persisted to database (without user permission), discarded after summarization
  codeHash?: string;
  technicalSummary?: string;  // what the code does: inputs, outputs, side effects
  businessSummary?:  string;  // what it means in product terms (auth, checkout etc.)
  security?: {
    severity: "none" | "low" | "medium" | "high";
    summary:  string;
  };
  summaryModel?:     string;  // e.g. "claude-haiku-4-5" or "qwen2.5-coder:3b"
  summarizedAt?:     string;  // ISO timestamp
  isEmbedded?: boolean; //tells if vectors has been generated for the node or not.
  parentFile?: string; //points to the FILE node id for this file
  score?: Number;
  metadata: Record<string, unknown>;
}

// ─── Graph Edges ─────
export type EdgeType =
  | "CALLS"
  | "IMPORTS"
  | "READS_FROM"
  | "WRITES_TO"
  | "PROP_PASS"
  | "EMITS"
  | "LISTENS"
  | "WRAPPED_BY"
  | "GUARDS"
  | "HANDLES"  // SPECIAL EDGES FOR THE ROUTE NODE TYPE
  | "TESTS"  //Special edge from Test files to the components/nodes it tests
  | "USES"  // New type of Edge added, specific for JSX components to external functions it USES 
  | "NEXTJS_API_CALL" // New Edge added for the nextjs backend api routes 
  | "NAVIGATES_TO" // NEW Edge added for the client side navigation to the route nodes
  | "IMPLEMENTS" // New Edge added for the implementation of interfaces by classes or structs (NEW LANGUAGES)
  | "EXTENDS"
  | "EXPORTS"
  | "THROWS"


export interface CodeEdge {
  from: string;
  to: string;
  type: EdgeType;
  metadata?: Record<string, unknown>;
}

// ─── Exports Map (cross-repo linkage) ─────────────────────────────────────────

//
// The flattened export surface of this repo, shipped as part of the graph
// artifact next to nodes/edges. Built by the engine (which has every file in
// memory at parse time); consumers of the map NEVER walk export chains —
// every value is the final, resolved nodeId as it appears in the nodes array,
// overload suffixes (#arity / #arity#sig8) included.
//
//   exports[subpath][exportedName] = [nodeId, ...]
//
// Key = the name the IMPORTER sees (alias-resolved). Value shape is UNIFORMLY
// an array: single element = unique resolution; multiple elements = either an
// overload group of one callable (call-site narrowing via #arity/#sig8 is
// possible) or a TRUE ambiguity (distinct symbols under one public name), in
// which case the name is also listed in ambiguousNames[subpath] and consumers
// must not guess.
//
export interface GraphExports {
  exports: Record<string, Record<string, string[]>>;
  ambiguousNames: Record<string, string[]>;
}


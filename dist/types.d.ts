export type Language = "javascript" | "typescript" | "python" | "java" | "go" | "rust" | "unknown";
export type Framework = "nextjs" | "react" | "express" | "fastify" | "koa" | "hono" | "elysia" | "bun" | "django" | "flask" | "fastapi" | "spring-boot" | "quarkus" | "gin" | "echo" | "fiber" | "net-http" | "actix-web" | "rocket" | "axum" | "unknown";
export type FrontendFramework = "nextjs" | "react";
export type BackendFramework = "express" | "fastify" | "koa" | "hono" | "elysia" | "bun";
export type RouterType = "app" | "pages" | "app+pages" | "react-router" | "none";
export type ProjectType = "frontend" | "backend" | "fullstack" | "unknown";
export type StateLibrary = "zustand" | "redux" | "recoil" | "jotai" | "context-only";
export type DataFetchingLibrary = "react-query" | "swr" | "axios" | "fetch";
export type DatabaseLibrary = "prisma" | "drizzle" | "mongodb" | "firebase" | "supabase" | "planetscale" | "postgres" | "mysql" | "sqlite";
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
export type RouteNodeType = "PAGE" | "LAYOUT" | "API_ROUTE" | "LOADING" | "ERROR" | "MIDDLEWARE" | "NOT_FOUND" | "REACT_ROUTER_ROUTE";
export interface RouteNode {
    type: RouteNodeType;
    nodeId?: string;
    urlPath: string;
    filePath: string;
    isDynamic: boolean;
    isCatchAll: boolean;
    isGroupRoute: boolean;
    layoutPath?: string;
    params?: string[];
    httpMethods?: string[];
    rendersComponent?: string;
}
export interface BackendRouteNode {
    type: "BACKEND_ROUTE";
    nodeId?: string;
    urlPath: string;
    filePath: string;
    httpMethod: string;
    handlerName?: string;
    framework: Framework;
    isDynamic: boolean;
    params?: string[];
    inlineHandler?: {
        rawCode: string;
        startLine: number;
        endLine: number;
    };
}
export type NodeType = "COMPONENT" | "HOOK" | "FUNCTION" | "STATE_STORE" | "UTILITY" | "FILE" | "GHOST" | "ROUTE" | "TEST" | "STORY" | "THIRD_PARTY" | "CLASS" | "METHOD" | "INTERFACE" | "ENUM" | "STRUCT" | "MODULE" | "TRAIT" | "IMPL_BLOCK" | "PACKAGE";
export interface CallSite {
    name: string;
    argCount: number;
    argTypes?: string[];
    hasSpread?: boolean;
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
export type DeferKind = "timer" | "promise" | "microtask" | "event" | "postRender" | "onReturn" | "unknown";
/**
 * One entry of `metadata.resolvedCalls`: the first call site that resolved to a
 * local/third-party node. `callSites` keeps the complete per-occurrence truth;
 * this is the compact view a renderer needs for one edge, deliberately small so
 * the cloud can ship it as a jsonb slice.
 */
export interface ResolvedCall {
    name: string;
    nodeId: string;
    firstOrder?: number;
    line?: number;
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
    rawCode?: string;
    codeHash?: string;
    technicalSummary?: string;
    businessSummary?: string;
    security?: {
        severity: "none" | "low" | "medium" | "high";
        summary: string;
    };
    summaryModel?: string;
    summarizedAt?: string;
    isEmbedded?: boolean;
    parentFile?: string;
    score?: Number;
    metadata: Record<string, unknown>;
}
export type EdgeType = "CALLS" | "IMPORTS" | "READS_FROM" | "WRITES_TO" | "PROP_PASS" | "EMITS" | "LISTENS" | "WRAPPED_BY" | "GUARDS" | "HANDLES" | "TESTS" | "USES" | "NEXTJS_API_CALL" | "NAVIGATES_TO" | "IMPLEMENTS" | "EXTENDS" | "EXPORTS" | "THROWS";
export interface CodeEdge {
    from: string;
    to: string;
    type: EdgeType;
    metadata?: Record<string, unknown>;
}
export interface GraphExports {
    exports: Record<string, Record<string, string[]>>;
    ambiguousNames: Record<string, string[]>;
}

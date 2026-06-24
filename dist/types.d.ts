export type Language = "javascript" | "typescript" | "python" | "unknown";
export type Framework = "nextjs" | "react" | "express" | "fastify" | "koa" | "unknown";
export type FrontendFramework = "nextjs" | "react";
export type BackendFramework = "express" | "fastify" | "koa";
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
export type RouteNodeType = "PAGE" | "LAYOUT" | "API_ROUTE" | "LOADING" | "ERROR" | "MIDDLEWARE" | "NOT_FOUND";
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
}
export interface BackendRouteNode {
    type: "BACKEND_ROUTE";
    nodeId?: string;
    urlPath: string;
    filePath: string;
    httpMethod: string;
    handlerName?: string;
    framework: BackendFramework;
    isDynamic: boolean;
    params?: string[];
    inlineHandler?: {
        rawCode: string;
        startLine: number;
        endLine: number;
    };
}
export type NodeType = "COMPONENT" | "HOOK" | "FUNCTION" | "STATE_STORE" | "UTILITY" | "FILE" | "GHOST" | "ROUTE" | "TEST" | "STORY" | "THIRD_PARTY";
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
export type EdgeType = "CALLS" | "IMPORTS" | "READS_FROM" | "WRITES_TO" | "PROP_PASS" | "EMITS" | "LISTENS" | "WRAPPED_BY" | "GUARDS" | "HANDLES" | "TESTS" | "USES" | "NEXTJS_API_CALL";
export interface CodeEdge {
    from: string;
    to: string;
    type: EdgeType;
    metadata?: Record<string, unknown>;
}

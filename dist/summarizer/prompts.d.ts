import type { CodeNode, CodeEdge, RouteNode, BackendRouteNode, ProjectFingerprint } from "../types.js";
import type { LLMMessage } from "./providers/types.js";
export interface EdgeIndex {
    outgoing: Map<string, Map<string, string[]>>;
    incoming: Map<string, Map<string, string[]>>;
}
export interface RouteIndex {
    byFilePath: Map<string, RouteNode | BackendRouteNode>;
}
export declare function buildEdgeIndex(edges: CodeEdge[]): EdgeIndex;
export declare function buildRouteIndex(routes: RouteNode[] | BackendRouteNode[]): RouteIndex;
export interface PromptContext {
    node: CodeNode;
    allNodes: Map<string, CodeNode>;
    edgeIndex: EdgeIndex;
    routeIndex: RouteIndex;
    systemPrompt: string;
}
export declare function buildSystemPrompt(fingerprint: ProjectFingerprint): string;
export declare const EDGE_LABELS: Record<string, string>;
export declare function buildPrompt(ctx: PromptContext): LLMMessage[];
export declare function buildCycleGroupPrompt(nodeIds: string[], ctx: Omit<PromptContext, "node">): LLMMessage[];

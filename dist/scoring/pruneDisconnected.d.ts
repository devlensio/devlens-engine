import type { CodeNode, CodeEdge } from "../types.js";
export declare const PRUNABLE_TYPES: Set<string>;
export interface PruneResult {
    nodes: CodeNode[];
    edges: CodeEdge[];
    removedNodeCount: number;
}
export declare function pruneDisconnected(nodes: CodeNode[], edges: CodeEdge[]): PruneResult;

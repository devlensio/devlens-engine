import type { CodeNode, CodeEdge } from "../types.js";
export interface FilterResult {
    nodes: CodeNode[];
    edges: CodeEdge[];
    removedNodeCount: number;
    removedEdgeCount: number;
}
export declare const DEFAULT_THRESHOLDS: {
    NODE_MIN_SCORE: number;
    FILE_MIN_SCORE: number;
    GHOST_MIN_SCORE: number;
};
export interface FilterThresholds {
    nodeMinScore?: number;
    fileMinScore?: number;
    ghostMinScore?: number;
}
export declare function filterNoise(nodes: CodeNode[], edges: CodeEdge[], nodeScores: Map<string, number>, thresholds?: FilterThresholds): FilterResult;

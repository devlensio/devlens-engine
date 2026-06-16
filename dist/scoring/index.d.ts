import type { CodeNode, CodeEdge } from "../types.js";
import { type FilterThresholds } from "./noiseFilter.js";
export interface ScoringResult {
    filteredNodes: CodeNode[];
    filteredEdges: CodeEdge[];
    nodeScores: Map<string, number>;
    stats: {
        totalNodesBeforeFilter: number;
        totalEdgesBeforeFilter: number;
        totalNodesAfterFilter: number;
        totalEdgesAfterFilter: number;
        removedNodeCount: number;
        removedEdgeCount: number;
        averageNodeScore: number;
        topScoringNodes: {
            name: string;
            score: number;
            type: string;
        }[];
    };
}
export declare function scoreAndFilter(nodes: CodeNode[], edges: CodeEdge[], thresholds?: FilterThresholds, existingScores?: Map<string, number>): ScoringResult;

import type { CycleGroup } from "../summarizer/types.js";
import { CodeEdge, CodeNode, EdgeType } from "../types.js";
export interface GraphIndex {
    nodesById: Map<string, CodeNode>;
    forward: Map<string, CodeEdge[]>;
    reverse: Map<string, CodeEdge[]>;
    nodesByFilePath: Map<string, string[]>;
}
export declare function buildGraphIndex(nodes: CodeNode[], edges: CodeEdge[]): GraphIndex;
export interface TraversalHit {
    nodeId: string;
    hop: number;
    viaEdge: EdgeType;
}
export interface TraversalResult {
    seedId: string;
    direction: "upstream" | "downstream";
    hits: TraversalHit[];
    truncated: boolean;
    stoppedAtRadius: number;
    hop1Count: number;
    radiusUsed: number;
    radiusWasExplicit: boolean;
}
export interface TraversalOpts {
    radius?: number;
    edgeTypes?: EdgeType[];
}
export declare function getBlastRadius(index: GraphIndex, seedId: string, opts?: TraversalOpts): TraversalResult;
export declare function getKHop(index: GraphIndex, seedId: string, opts?: TraversalOpts): TraversalResult;
export interface SubgraphResult {
    seedNodeId: string;
    clusterId: string;
    nodes: CodeNode[];
    edges: CodeEdge[];
}
export declare function getSubgraph(allNodes: CodeNode[], allEdges: CodeEdge[], nodeScores: Record<string, number>, seedNodeId: string): SubgraphResult | undefined;
export declare function findCycles(nodes: CodeNode[], edges: CodeEdge[]): CycleGroup[];

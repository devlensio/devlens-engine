import type { CodeEdge, CodeNode } from "../types.js";
export interface ClusterNode {
    nodeId: string;
    rank: number;
}
export interface ClusterFile {
    filePath: string;
    nodeIds: ClusterNode[];
}
export interface Cluster {
    id: string;
    label: string;
    files: ClusterFile[];
    nodeCount: number;
    topNodes: string[];
}
export interface InterClusterEdge {
    from: string;
    to: string;
    weight: number;
}
export interface ClusterResult {
    clusters: Cluster[];
    interClusterEdges: InterClusterEdge[];
    clusterMembership: Record<string, string>;
}
export declare function computeClusters(allNodes: CodeNode[], allEdges: CodeEdge[], nodeScores: Record<string, number>): ClusterResult;

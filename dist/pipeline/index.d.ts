import type { FilterThresholds } from "../scoring/noiseFilter.js";
import type { CodeNode, CodeEdge, ProjectFingerprint, RouteNode, BackendRouteNode } from "../types.js";
export type { FilterThresholds };
export interface GitInfo {
    commitHash: string;
    branch: string;
    message: string;
    hasGit: boolean;
}
export interface PipelineOptions {
    thresholds?: FilterThresholds;
    onStep?: (step: "fingerprint" | "filesystem" | "parse" | "edges" | "scoring") => void;
    includedThirdPartyLibs?: string[];
}
export interface PipelineStats {
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
    topScoringFiles: {
        name: string;
        score: number;
        filePath: string;
    }[];
}
export interface PipelineResult {
    graphId: string;
    repoPath: string;
    analyzedAt: string;
    fingerprint: ProjectFingerprint;
    routes: RouteNode[] | BackendRouteNode[];
    nodes: CodeNode[];
    edges: CodeEdge[];
    allNodes: CodeNode[];
    allEdges: CodeEdge[];
    nodeScores: Record<string, number>;
    stats: PipelineStats;
    isGithubRepo: boolean;
    gitInfo: GitInfo;
}
export declare function analyzePipeline(repoPath: string, isGithubRepo: boolean, options?: PipelineOptions): Promise<PipelineResult>;
export declare function refilterPipeline(stored: PipelineResult, thresholds: FilterThresholds): Pick<PipelineResult, "nodes" | "edges" | "stats">;

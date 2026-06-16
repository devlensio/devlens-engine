import type { PipelineResult, PipelineStats } from "../pipeline/index.js";
import type { CodeNode, CodeEdge } from "../types.js";
import type { GraphStorage } from "./interface.js";
export interface GraphIndexEntry {
    graphId: string;
    repoPath: string;
    isGithubRepo: boolean;
    githubUrl: string | null;
    framework: string;
    language: string;
    latestCommit: string;
    latestAnalyzedAt: string;
    commitCount: number;
}
export interface CommitSummary {
    commitHash: string;
    branch: string;
    message: string;
    analyzedAt: string;
    nodeCount: number;
    edgeCount: number;
    hasGit: boolean;
    isSummarized?: boolean;
}
export interface GraphMeta {
    graphId: string;
    repoPath: string;
    isGithubRepo: boolean;
    githubUrl: string | null;
    githubOwner: string | null;
    githubRepo: string | null;
    fingerprint: PipelineResult["fingerprint"];
    routes: PipelineResult["routes"];
    commits: CommitSummary[];
    summarizedCommits: string[];
}
export interface CommitData {
    commitHash: string;
    analyzedAt: string;
    nodes: CodeNode[];
    edges: CodeEdge[];
    allNodes: CodeNode[];
    allEdges: CodeEdge[];
    nodeScores: Record<string, number>;
    stats: PipelineStats;
}
export interface NodeDiff {
    added: DiffNode[];
    removed: DiffNode[];
    codeChanged: DiffNode[];
    scoreChanged: ScoreChange[];
    edgesChanged: EdgeChange[];
    moved: MovedNode[];
    unchanged: number;
}
interface DiffNode {
    nodeId: string;
    name: string;
    type: string;
    score: number;
    filePath: string;
}
interface ScoreChange {
    nodeId: string;
    name: string;
    type: string;
    scoreBefore: number;
    scoreAfter: number;
    delta: number;
}
interface EdgeChange {
    nodeId: string;
    name: string;
    addedEdges: {
        to: string;
        type: string;
    }[];
    removedEdges: {
        to: string;
        type: string;
    }[];
}
interface MovedNode {
    nodeId: string;
    name: string;
    fromFile: string;
    toFile: string;
    scoreBefore: number;
    scoreAfter: number;
}
export declare function getCheckpointPath(graphId: string, commitHash: string): string;
export declare function saveGraph(result: PipelineResult, options?: {
    force?: boolean;
}): void;
export declare function getGraph(graphId: string, commitHash?: string): PipelineResult | undefined;
export declare function getNodeCode(graphId: string, commitHash: string, nodeId: string): CodeNode | undefined;
export declare function listGraphs(): GraphIndexEntry[];
export declare function getGraphMeta(graphId: string): GraphMeta | undefined;
export declare function deleteGraph(graphId: string): boolean;
export declare function deleteCommit(graphId: string, commitHash: string): boolean;
export declare function diffCommits(graphId: string, fromHash: string, toHash: string): NodeDiff | undefined;
export declare function markCommitSummarized(graphId: string, commitHash: string): void;
export declare function isCommitSummarized(graphId: string, commitHash: string): boolean;
export declare function findLastSummarizedAncestor(graphId: string, commitHash: string, repoPath: string): Promise<string | undefined>;
export declare function saveNodeSummaries(graphId: string, commitHash: string, nodeUpdates: Map<string, {
    technicalSummary: string;
    businessSummary: string;
    security: {
        severity: "none" | "low" | "medium" | "high";
        summary: string;
    };
    summaryModel: string;
    summarizedAt: string;
}>): void;
export declare function removeFromSummarizedCommits(graphId: string, commitHash: string): void;
export declare const fileStorage: GraphStorage;
export {};

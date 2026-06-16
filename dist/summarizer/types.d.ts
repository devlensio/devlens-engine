import type { PipelineResult } from "../pipeline/index.js";
export interface NodeSummary {
    technicalSummary: string;
    businessSummary: string;
    security: {
        severity: "none" | "low" | "medium" | "high";
        summary: string;
    };
    model: string;
    summarizedAt: string;
    tokensUsed?: number;
}
export interface CycleGroup {
    nodeIds: string[];
    size: number;
}
export interface SummaryCheckpoint {
    graphId: string;
    commitHash: string;
    status: "running" | "paused" | "completed";
    createdAt: string;
    updatedAt: string;
    nodeOrder: string[][];
    cycleGroups: CycleGroup[];
    fileNodes: string[];
    lastCompletedLevel: number;
    lastCompletedCycleGroup: number;
    lastCompletedFileNode: number;
    totalNodes: number;
    completedNodes: number;
}
export interface SummarizationCallbacks {
    onStarted: (totalNodes: number) => void;
    onProgress: (completed: number, total: number, nodeName: string) => void;
    onPause: () => void;
    onCancel: (cleanedUp: boolean) => void;
    onComplete: () => void;
    onError: (error: string) => void;
}
export interface SummarizationInput {
    job: import("../jobs/types.js").Job;
    queue: import("../jobs/queue/interface.js").JobQueue;
    graphId: string;
    commitHash: string;
    repoPath: string;
    previousCommitHash?: string;
    routes: PipelineResult["routes"];
    callbacks: SummarizationCallbacks;
}
export interface TopologicalResult {
    nodeOrder: string[][];
    cycleGroups: CycleGroup[];
    fileNodes: string[];
}
export declare const MAX_GROUP_SUMMARY_SIZE = 3;
export declare const MAPREDUCE_TOKEN_THRESHOLD = 1200;
export declare const FILE_BATCH_SIZE = 10;

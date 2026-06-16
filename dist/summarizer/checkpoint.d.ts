import type { SummaryCheckpoint } from "./types.js";
export declare function loadCheckpoint(graphId: string, commitHash: string): SummaryCheckpoint | undefined;
export declare function saveCheckpoint(checkpoint: SummaryCheckpoint): void;
export declare function deleteCheckpoint(graphId: string, commitHash: string): void;
export declare function createCheckpoint(graphId: string, commitHash: string, nodeOrder: string[][], cycleGroups: SummaryCheckpoint["cycleGroups"], fileNodes: string[]): SummaryCheckpoint;
export type ResumePhase = "nodes" | "cycles" | "files" | "done";
export interface ResumePoint {
    phase: ResumePhase;
    index: number;
}
export declare function getResumePoint(checkpoint: SummaryCheckpoint): ResumePoint;
export declare function markLevelCompleted(checkpoint: SummaryCheckpoint, levelIndex: number): void;
export declare function markCycleGroupCompleted(checkpoint: SummaryCheckpoint, groupIndex: number): void;
export declare function markFileNodeCompleted(checkpoint: SummaryCheckpoint, index: number): void;
export declare function markFileNodeBatchCompleted(checkpoint: SummaryCheckpoint, batchEnd: number, count: number): void;

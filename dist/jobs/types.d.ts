import type { DevLensConfig } from "../config/index.js";
import type { FilterThresholds } from "../pipeline/index.js";
export type JobStatus = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";
export type JobPhase = "analysis" | "summarization";
export type AnalysisStep = "fingerprint" | "filesystem" | "parse" | "edges" | "scoring";
export type ProgressEvent = {
    event: "queued";
    jobId: string;
    position: number;
} | {
    event: "analysis_started";
    jobId: string;
} | {
    event: "analysis_progress";
    jobId: string;
    step: AnalysisStep;
} | {
    event: "analysis_complete";
    jobId: string;
    graphId: string;
    nodeCount: number;
    edgeCount: number;
} | {
    event: "summarization_started";
    jobId: string;
    totalNodes: number;
} | {
    event: "summarization_progress";
    jobId: string;
    completed: number;
    total: number;
    nodeName: string;
} | {
    event: "summarization_complete";
    jobId: string;
} | {
    event: "paused";
    jobId: string;
    completedNodes: number;
    totalNodes: number;
} | {
    event: "resumed";
    jobId: string;
    completedNodes: number;
    totalNodes: number;
} | {
    event: "cancelled";
    jobId: string;
    cleanedUp: boolean;
} | {
    event: "completed";
    jobId: string;
    graphId: string;
} | {
    event: "failed";
    jobId: string;
    error: string;
};
export interface Job {
    jobId: string;
    status: JobStatus;
    phase: JobPhase | null;
    repoPath: string;
    isGithubRepo: boolean;
    thresholds?: FilterThresholds;
    config: DevLensConfig;
    skipSummarization?: boolean;
    graphId?: string;
    events: ProgressEvent[];
    pauseRequested: boolean;
    cancelRequested: boolean;
    summarizationTotal?: number;
    summarizationCompleted?: number;
    createdAt: string;
    startedAt?: string;
    pausedAt?: string;
    cancelledAt?: string;
    completedAt?: string;
    failedAt?: string;
    error?: string;
    forceSummarize?: boolean;
    includedThirdPartyLibs?: string[];
}
export interface JobInput {
    repoPath: string;
    isGithubRepo?: boolean;
    skipSummarization: boolean;
    thresholds?: FilterThresholds;
    config: DevLensConfig;
    forceSummarize?: boolean;
    includedThirdPartyLibs?: string[];
}
export interface JobSummary {
    jobId: string;
    status: JobStatus;
    phase: JobPhase | null;
    repoPath: string;
    graphId?: string;
    summarizationTotal?: number;
    summarizationCompleted?: number;
    createdAt: string;
    startedAt?: string;
    pausedAt?: string;
    cancelledAt?: string;
    completedAt?: string;
    failedAt?: string;
    error?: string;
}
export declare const TERMINAL_STATUSES: Set<JobStatus>;
export declare function isTerminal(status: JobStatus): boolean;
export declare function isResumable(status: JobStatus): boolean;
export declare function toJobSummary(job: Job): JobSummary;

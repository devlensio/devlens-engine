import { Job, JobInput, JobSummary, ProgressEvent } from "../types.js";
import { JobQueue } from "./interface.js";
export declare class InMemoryQueue implements JobQueue {
    private jobs;
    private subscribers;
    private waitingQueue;
    enqueue(input: JobInput): Job;
    getJob(jobId: string): Job | undefined;
    listJobs(): JobSummary[];
    findActiveJob(repoPath: string): Job | undefined;
    pauseJob(jobId: string): boolean;
    resumeJob(jobId: string): boolean;
    cancelJob(jobId: string): boolean;
    subscribe(jobId: string, onEvent: (event: ProgressEvent) => void, onCompleted: () => void): () => void;
    updateJob(jobId: string, updates: Partial<Job>): void;
    emitEvent(jobId: string, event: ProgressEvent): void;
    private getRunningCount;
    _markFailed(jobId: string, error: string): void;
    private onJobTerminated;
    _markPaused(jobId: string): void;
    _markCancelled(jobId: string, cleanedUp: boolean): void;
    _markCompleted(jobId: string, graphId: string): void;
    private startJob;
}

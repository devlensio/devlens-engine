import type { Job, JobInput, JobSummary, ProgressEvent } from "../types.js";
export interface JobQueue {
    enqueue(input: JobInput): Job;
    getJob(jobId: string): Job | undefined;
    listJobs(): JobSummary[];
    findActiveJob(repoPath: string): Job | undefined;
    pauseJob(jobId: string): boolean;
    resumeJob(jobId: string): boolean;
    cancelJob(jobId: string): boolean;
    emitEvent(jobId: string, event: ProgressEvent): void;
    subscribe(jobId: string, onEvent: (event: ProgressEvent) => void, onCompleted: () => void): () => void;
    updateJob(jobId: string, updates: Partial<Job>): void;
}

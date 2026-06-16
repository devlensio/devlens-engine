// Jobs in these statuses are done — they will never change state again.
// Used by the queue to decide when to clean up SSE subscribers.
export const TERMINAL_STATUSES = new Set([
    "completed",
    "failed",
    "cancelled",
]);
export function isTerminal(status) {
    return TERMINAL_STATUSES.has(status);
}
// Only paused jobs can be resumed.
// Cancelled jobs cannot — their checkpoints are deleted.
export function isResumable(status) {
    return status === "paused";
}
export function toJobSummary(job) {
    return {
        jobId: job.jobId,
        status: job.status,
        phase: job.phase,
        repoPath: job.repoPath,
        graphId: job.graphId,
        summarizationTotal: job.summarizationTotal,
        summarizationCompleted: job.summarizationCompleted,
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        pausedAt: job.pausedAt,
        cancelledAt: job.cancelledAt,
        completedAt: job.completedAt,
        failedAt: job.failedAt,
        error: job.error,
    };
}

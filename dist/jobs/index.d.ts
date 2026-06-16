import { JobQueue } from "./queue/interface.js";
export declare const queue: JobQueue;
export type { JobQueue } from "./queue/interface.js";
export type { Job, JobSummary, JobStatus, JobPhase, ProgressEvent, JobInput } from "./types.js";
export { isTerminal, isResumable, toJobSummary } from "./types.js";

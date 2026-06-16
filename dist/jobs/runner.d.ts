import { Job } from "./types.js";
import { JobQueue } from "./queue/interface.js";
export declare function runJob(job: Job, queue: JobQueue): Promise<void>;

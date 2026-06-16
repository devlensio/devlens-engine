import { InMemoryQueue } from "./queue/memory.js";
function createQueue() {
    return new InMemoryQueue();
}
// Singleton Queue
//
// One queue instance for the entire server process.
// All handlers import this — never instantiate their own queue.
// This is what ensures job deduplication works across requests.
export const queue = createQueue();
export { isTerminal, isResumable, toJobSummary } from "./types.js";

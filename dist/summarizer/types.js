//storing types used for summarization flow
// Edge types that drive topological sort order.
// A node must wait for all nodes it has these edges TO before being summarized.
// export const HARD_DEPENDENCY_EDGES = new Set([
//   "CALLS",
//   "READS_FROM",
//   "WRITES_TO",
//   "GUARDS",
// ]);
// Cycle groups at or below this size → summarize together in one LLM call
// Above this → summarize individually
export const MAX_GROUP_SUMMARY_SIZE = 3;
// Nodes whose source code exceeds this token estimate → MapReduce
// ~1200 tokens ≈ 900 lines — only very large files hit this
export const MAPREDUCE_TOKEN_THRESHOLD = 1200;
// Batch size for the files to be summarized at a time
export const FILE_BATCH_SIZE = 10;

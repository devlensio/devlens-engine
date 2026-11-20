// ─── Summarization Architecture ───────────────────────────────────────────────
//
// Triggered after Phase 1 (analysis) completes for a job.
//
// SMART REUSE
//   Before summarizing, we check if the commit was already summarized (skip entirely),
//   or if a previous summarized commit exists — nodes whose codeHash hasn't changed
//   get their summaries copied for free without any LLM call.
//
// JOB-SCOPED INDEXES
//   edgeIndex, routeIndex, systemPrompt, and allNodesMap are built ONCE per job
//   before the batch loop starts. A job is tied to a single commit — nodes, edges,
//   and routes never change mid-job even if the user edits code. Building indexes
//   once and reusing them across all batches avoids O(n×e) redundant work.
//
// THREE PHASES (in order)
//   Phase 1 — nodeOrder[][]   topo-sorted levels, each level runs in parallel
//   Phase 2 — cycleGroups[]   nodes with circular deps, grouped or individual
//   Phase 3 — fileNodes[]     FILE nodes last — use child summaries as context
//
// PAUSE / CANCEL
//   Signals are checked between levels/groups — never mid-level.
//   Levels complete atomically so resume always starts at a clean boundary.
//   Checkpoint is saved after every level/group — O(1) resume via lastCompletedLevel.
//
// MAPREDUCE
//   Nodes whose rawCode exceeds MAPREDUCE_TOKEN_THRESHOLD are split into chunks,
//   each chunk summarized in parallel (map), then reduced into one final summary.

import { storage }               from "../storage/index.js";
import { resolveConfig }         from "../config/index.js";
import type { CodeNode }              from "../types.js";
import { FILE_BATCH_SIZE, type SummarizationInput, type NodeFailure, type SummarizationStats } from "./types.js";
import { buildTopologicalOrder } from "./topological.js";
import {
  createCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  deleteCheckpoint,
  getResumePoint,
  markLevelCompleted,
  markCycleGroupCompleted,
  markFileNodeCompleted,
  markFileNodeBatchCompleted,
  markNodeFailed,
  markNodeRecovered,
} from "./checkpoint.js";
import {
  buildEdgeIndex,
  buildRouteIndex,
  buildSystemPrompt,
  buildPrompt,
  buildCycleGroupPrompt,
} from "./prompts.js";
import { createLLMClient }       from "./providers/index.js";
import { errorMessage }          from "./providers/errors.js";
import { exceedsThreshold, mapreduceSummarize } from "./mapreduce.js";
import { withRetry }              from "./retry.js";
import { MAX_GROUP_SUMMARY_SIZE } from "./types.js";
 
// ─── LLM concurrency ──────────────────────────────────────────────────────────
//
// A topological level can hold hundreds of nodes and each one is an independent
// LLM request. Firing the whole level at once hammers the provider and gets 429s
// on every call (measured: 2400+ retries, zero completions on a 3.2k-node repo),
// so requests are bounded here rather than in the provider. Env-tunable because
// providers differ; the default is conservative.
const LLM_CONCURRENCY = (() => {
  const raw = Number(process.env.DEVLENS_LLM_CONCURRENCY ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 24;
})();

const MAX_CONSECUTIVE_FAILURES = (() => {
  const raw = Number(process.env.DEVLENS_MAX_CONSECUTIVE_FAILURES ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 12;
})();

class SummarizationAborted extends Error {}

async function mapLimited<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(LLM_CONCURRENCY, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!);
      }
    }
  );
  await Promise.all(workers);
}

// ─── runSummarization ─────────────────────────────────────────────────────────
//
// Main entry point — called by runner.ts after Phase 1 completes.
// Handles fresh runs and resumes from checkpoint transparently.
//
// Flow:
//   1. Load commit data (nodes, edges, fingerprint, routes)
//   2. Check if already summarized → skip
//   3. Copy summaries from previous commit where codeHash matches → free reuse
//   4. Build indexes once (edges, routes, system prompt, allNodes map)
//   5. Build or load checkpoint
//   6. Run three phases: nodeOrder levels → cycleGroups → fileNodes
//   7. Save summaries to storage after every level/group
//   8. Check pause/cancel signals between levels
 
export async function runSummarization(input: SummarizationInput): Promise<void> {
  const { job, queue, graphId, commitHash, repoPath, routes, callbacks } = input;
 
  // ── Step 1: Load commit data ───────────────────────────────────────────────
  const result = storage.getGraph(graphId, commitHash);
  if (!result) {
    callbacks.onError(`Commit data not found: ${graphId}/${commitHash}`);
    return;
  }
 
  // ── Step 2: Skip if already summarized ────────────────────────────────────
  if (storage.isCommitSummarized(graphId, commitHash)) {
    callbacks.onComplete();
    console.log("Already Summarized!");
    return;
  }
 
  // ── Step 3: Copy summaries from previous commit where codeHash matches ────
  // Nodes whose code hasn't changed don't need re-summarization.
  // We identify them by codeHash — if it matches, copy the summary directly.
  // Skipped when forceSummarize=true so every node gets a fresh LLM call.
  if (input.previousCommitHash && !job.forceSummarize) {
    const prevResult = storage.getGraph(graphId, input.previousCommitHash);
    if (prevResult) {
      const prevById = new Map(prevResult.allNodes.map(n => [n.id, n]));
      let duplicateNodes = 0;
      for (const node of result.allNodes) {
        const prev = prevById.get(node.id);
        if (
          prev &&
          prev.technicalSummary &&
          node.codeHash &&
          node.codeHash === prev.codeHash
        ) {
          node.technicalSummary = prev.technicalSummary;
          node.businessSummary  = prev.businessSummary;
          node.security         = prev.security;
          node.summaryModel     = prev.summaryModel;
          node.summarizedAt     = prev.summarizedAt;
          duplicateNodes++;
        }
      }
      const toSummarize = result.allNodes.filter(n => !n.technicalSummary).length;
      console.log(`${duplicateNodes} copied, ${toSummarize} to summarize`);
      console.log(duplicateNodes ,"Nodes' Summaries were copied from previous Hash", input.previousCommitHash);
    }
  }
 
  // ── Step 4: Build job-scoped indexes — built once, reused every batch ─────
  const config      = await resolveConfig();
  const client      = createLLMClient(config.summarization);
  const allNodesMap = new Map<string, CodeNode>(result.allNodes.map(n => [n.id, n]));
  const edgeIndex   = buildEdgeIndex(result.allEdges);
  const routeIndex  = buildRouteIndex(routes);
  const systemPrompt = buildSystemPrompt(result.fingerprint);
 
  // Validate LLM connection before starting — fail fast
  try {
    await client.validateConnection();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "LLM connection failed";
    callbacks.onError(msg);
    return;
  }
 
  // ── Step 5: Build or load checkpoint ──────────────────────────────────────
  //
  // forceSummarize means "from scratch": the caller already dropped every summary
  // for this commit, so a checkpoint from an interrupted run is stale state that
  // describes work which no longer exists. Resuming into it marks those levels
  // complete with nothing written behind them, and the run then reports 100% while
  // most nodes stay unsummarized (measured: 791/3217 on a 3.2k-node repo).
  if (job.forceSummarize) deleteCheckpoint(graphId, commitHash);
  let checkpoint = loadCheckpoint(graphId, commitHash);
  const isResume = !!checkpoint;
 
  if (!checkpoint) {
    // Fresh run — build topo order and create checkpoint
    const { nodeOrder, cycleGroups, fileNodes } = buildTopologicalOrder(
      result.allNodes,
      result.allEdges
    );
    checkpoint = createCheckpoint(graphId, commitHash, nodeOrder, cycleGroups, fileNodes);
  }
 
  // On resume: nodes from already-completed levels may have summaries in memory
  // (merged into the commit file by saveGraph on restart) but saveBatch will never
  // be called for skipped levels — so those summaries would sit in memory and never
  // be re-persisted after the fresh saveGraph overwrote the file.
  // Fix: flush all already-summarized nodes to disk in one pass before the loop starts.
  if (isResume) {
    const alreadySummarized = result.allNodes.filter(n => n.technicalSummary);
    if (alreadySummarized.length > 0) {
      const updates = new Map(alreadySummarized.map(n => [n.id, {
        technicalSummary: n.technicalSummary!,
        businessSummary:  n.businessSummary  ?? "",
        security:         n.security  ??  { severity: "none" as const, summary: "" },
        summaryModel:     n.summaryModel     ?? "",
        summarizedAt:     n.summarizedAt     ?? new Date().toISOString(),
      }]));
      storage.saveNodeSummaries(graphId, commitHash, updates);
      console.log(`♻️  Re-persisted ${alreadySummarized.length} summaries from pre-crash levels`);
    }
  }
 
  // Notify caller of total work
  callbacks.onStarted(checkpoint.totalNodes);
 
  const failures: NodeFailure[] = [];
  const failedIds = new Set<string>(checkpoint.failedNodes ?? []);
  let consecutiveFailures = 0;
  let summarizedCount = 0;
  let skippedCount = 0;

  function recordFailure(node: CodeNode, err: unknown): void {
    const message = errorMessage(err);
    if (!failedIds.has(node.id)) failures.push({ nodeId: node.id, message });
    failedIds.add(node.id);
    markNodeFailed(checkpoint!, node.id);
    consecutiveFailures++;
    console.warn(`[summarizer] ${node.id} failed (${failures.length} so far): ${message}`);

    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      throw new SummarizationAborted(
        `${consecutiveFailures} consecutive nodes failed — last error: ${message}`,
      );
    }
  }

  async function summarizeNode(node: CodeNode): Promise<void> {
    if (node.technicalSummary) {
      skippedCount++;
      return;
    }

    try {
      const output = await withRetry(
        () => exceedsThreshold(node)
          ? mapreduceSummarize(node, client, systemPrompt)
          : client.summarize({
              messages: buildPrompt({ node, allNodes: allNodesMap, edgeIndex, routeIndex, systemPrompt }),
              temperature: 0,
            }),
        undefined,
        node.id,
      );

      node.technicalSummary = output.technicalSummary;
      node.businessSummary  = output.businessSummary;
      node.security         = output.security;
      node.summaryModel     = client.model;
      node.summarizedAt     = new Date().toISOString();

      summarizedCount++;
      consecutiveFailures = 0;
      if (failedIds.delete(node.id)) markNodeRecovered(checkpoint!, node.id);
    } catch (err) {
      recordFailure(node, err);
    }
  }

  async function retryFailedNodes(nodes: CodeNode[], label: string): Promise<void> {
    const todo = nodes.filter(n => !n.technicalSummary);
    if (todo.length === 0) return;

    console.log(`↻ ${label} — retrying ${todo.length} node(s)`);
    consecutiveFailures = 0;
    await mapLimited(todo, summarizeNode);
    savePartial(todo);
    saveCheckpoint(checkpoint!);
  }

  // ── Helper: save a batch of node updates to disk ──────────────────────────
  // Partial flush: a single level can hold thousands of nodes (measured: 2612 on a
  // 3.2k-node repo), and saveBatch only runs once the whole level finishes — so a
  // crash or cancel mid-level wrote nothing. This flushes the nodes that already
  // have summaries, which is idempotent because saveNodeSummaries is an upsert.
  const SAVE_EVERY = 200;
  function savePartial(nodes: CodeNode[]): void {
    const done = nodes.filter(n => n.technicalSummary);
    if (done.length === 0) return;
    saveBatch(done);
    console.log(`💾 Partial flush — ${done.length}/${nodes.length} nodes of this level saved`);
  }

  function saveBatch(nodes: CodeNode[]): void {
    const updates = new Map(nodes.map(n => [n.id, {
      technicalSummary: n.technicalSummary!,
      businessSummary:  n.businessSummary  ?? "",
      security:         n.security         ?? { severity: "none" as const, summary: "" },
      summaryModel:     n.summaryModel     ?? client.model,
      summarizedAt:     n.summarizedAt     ?? new Date().toISOString(),
    }]));
    storage.saveNodeSummaries(graphId, commitHash, updates);
  }
 
  // ── Helper: check pause/cancel signals ────────────────────────────────────
  function shouldPause(): boolean  { return queue.getJob(job.jobId)?.pauseRequested  ?? false; }
  function shouldCancel(): boolean { return queue.getJob(job.jobId)?.cancelRequested ?? false; }
 
  // ── Derive start indexes for all three phases ─────────────────────────────
  // If resumePoint is past a phase entirely, start index = length (skips loop).
  const resumePoint = getResumePoint(checkpoint);
 
  const levelStart = resumePoint.phase === "nodes"                                 ? resumePoint.index :
                     resumePoint.phase === "done"                                  ? checkpoint.nodeOrder.length :
                     /* cycles or files — nodes already done */                      checkpoint.nodeOrder.length;
 
  const cycleStart = resumePoint.phase === "cycles"                                ? resumePoint.index :
                     resumePoint.phase === "files" || resumePoint.phase === "done" ? checkpoint.cycleGroups.length :
                     /* nodes phase — cycles not started yet */                      0;
 
  const fileStart  = resumePoint.phase === "files"                                 ? resumePoint.index :
                     resumePoint.phase === "done"                                  ? checkpoint.fileNodes.length :
                     /* nodes or cycles phase — files not started yet */             0;
 
  let abortReason: string | undefined;

  try {
    if (failedIds.size > 0) {
      const pending = [...failedIds]
        .map(id => allNodesMap.get(id))
        .filter((n): n is CodeNode => !!n);
      await retryFailedNodes(pending, "nodes that failed in an earlier run");
    }

    // ── Step 6: Phase 1 — nodeOrder levels ────────────────────────────────────
    // Each level is independent — all nodes in a level run in parallel.
    // Levels complete atomically — checkpoint saves after each full level.
    for (let lvl = levelStart; lvl < checkpoint.nodeOrder.length; lvl++) {
        const level = checkpoint.nodeOrder[lvl];
        const nodes = level.map(id => allNodesMap.get(id)).filter(Boolean) as CodeNode[];
        
        const newInLevel = nodes.filter(n => !n.technicalSummary).length;
        console.log(`🔍 Level ${lvl}: ${nodes.length} nodes, ${newInLevel} new to summarize (skipped ${nodes.length - newInLevel})`);
        // The whole level is independent, but the request count is bounded, and the
        // completed prefix is flushed periodically so a crash cannot lose the level.
        let flushed = 0;
        await mapLimited(nodes, async (n) => {
          await summarizeNode(n);
          if (++flushed % SAVE_EVERY === 0) savePartial(nodes);
        });
        saveBatch(nodes);
        markLevelCompleted(checkpoint, lvl);
        saveCheckpoint(checkpoint);
        callbacks.onProgress(checkpoint.completedNodes, checkpoint.totalNodes, `level ${lvl}`);
 
        if (shouldCancel()) {
          deleteCheckpoint(graphId, commitHash);
          callbacks.onCancel(true);
          return;
        }
 
        if (shouldPause()) {
          checkpoint.status = "paused";
          saveCheckpoint(checkpoint);
          callbacks.onPause();
          return;
        }
    }
 
    // ── Step 7: Phase 2 — cycleGroups ─────────────────────────────────────────
    for (let gi = cycleStart; gi < checkpoint.cycleGroups.length; gi++) {
      const group = checkpoint.cycleGroups[gi];
      const nodes = group.nodeIds.map(id => allNodesMap.get(id)).filter(Boolean) as CodeNode[];
 
      if (group.size <= MAX_GROUP_SUMMARY_SIZE) {
        // Small cycle — one grouped LLM call
        console.log(` Starting grouped LLM summary for cycle group ${gi} (${group.nodeIds.length} nodes)`);
        const messages = buildCycleGroupPrompt(group.nodeIds, { allNodes: allNodesMap, edgeIndex, routeIndex, systemPrompt });
        const output   = await client.summarize({ messages, temperature: 0 });
 
        // For grouped calls the LLM returns one summary — apply to all nodes in group
        for (const node of nodes) {
          node.technicalSummary = output.technicalSummary;
          node.businessSummary  = output.businessSummary;
          node.security         = output.security;
          node.summaryModel     = client.model;
          node.summarizedAt     = new Date().toISOString();
        }
      } else {
        // Large cycle — summarize individually
        await mapLimited(nodes, summarizeNode);
      }
 
      saveBatch(nodes);
      markCycleGroupCompleted(checkpoint, gi);
      saveCheckpoint(checkpoint);
      callbacks.onProgress(checkpoint.completedNodes, checkpoint.totalNodes, `cycle group ${gi}`);
 
      if (shouldCancel()) {
        deleteCheckpoint(graphId, commitHash);
        callbacks.onCancel(true);
        return;
      }
 
      if (shouldPause()) {
        checkpoint.status = "paused";
        saveCheckpoint(checkpoint);
        callbacks.onPause();
        return;
      }
    }
 
    // ── Step 8: Phase 3 — fileNodes ───────────────────────────────────────────
    // FILE nodes summarized last — they use child summaries as context.
     for (let fi = fileStart; fi < checkpoint.fileNodes.length; fi += FILE_BATCH_SIZE) {
      const batchEnd   = Math.min(fi + FILE_BATCH_SIZE - 1, checkpoint.fileNodes.length - 1);
      const batchIds   = checkpoint.fileNodes.slice(fi, batchEnd + 1);
      const batchNodes = batchIds.map(id => allNodesMap.get(id)).filter(Boolean) as CodeNode[];
  
      //Debug-Log
      const newInBatch = batchNodes.filter(n => !n.technicalSummary).length;
      console.log(`🔍 File batch ${fi}-${batchEnd}: ${batchNodes.length} nodes, ${newInBatch} new to summarize (skipped ${batchNodes.length - newInBatch})`);

      await mapLimited(batchNodes, summarizeNode);
      saveBatch(batchNodes);
      markFileNodeBatchCompleted(checkpoint, batchEnd, batchNodes.length);
      saveCheckpoint(checkpoint);
      callbacks.onProgress(
        checkpoint.completedNodes,
        checkpoint.totalNodes,
        `file batch ${fi}-${batchEnd}`
      );
 
      if (shouldCancel()) {
        deleteCheckpoint(graphId, commitHash);
        callbacks.onCancel(true);
        return;
      }
 
      if (shouldPause()) {
        checkpoint.status = "paused";
        saveCheckpoint(checkpoint);
        callbacks.onPause();
        return;
      }
    }
 

    if (failedIds.size > 0) {
      const pending = [...failedIds]
        .map(id => allNodesMap.get(id))
        .filter((n): n is CodeNode => !!n);
      await retryFailedNodes(pending, "final retry");
    }
  } catch (err) {
    if (!(err instanceof SummarizationAborted)) throw err;
    abortReason = errorMessage(err);
    console.warn(`[summarizer] stopping early: ${abortReason}`);
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  const stats: SummarizationStats = {
    summarized: summarizedCount,
    failed:     failedIds.size,
    skipped:    skippedCount,
    failures,
  };

  if (failedIds.size === 0) {
    storage.markCommitSummarized(graphId, commitHash);
    deleteCheckpoint(graphId, commitHash);
    console.log(`✅ Summarized ${stats.summarized} nodes (${stats.skipped} reused)`);
    callbacks.onComplete(stats);
    return;
  }

  checkpoint.failedNodes = [...failedIds];
  saveCheckpoint(checkpoint);

  const sample = failures.slice(-3).map(f => `${f.nodeId}: ${f.message}`).join(" · ");
  const message =
    `${stats.failed} node(s) could not be summarized` +
    (abortReason ? ` — stopped early: ${abortReason}` : "") +
    `. ${stats.summarized} summaries were saved` +
    (sample ? `. Last errors — ${sample}` : "");

  console.warn(`[summarizer] ${message}`);

  if (abortReason) {
    callbacks.onError(`${message}. Progress is saved — run summarization again to resume.`);
    return;
  }

  callbacks.onComplete(stats);
}

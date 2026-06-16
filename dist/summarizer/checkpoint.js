// Purely a read/write utility — no LLM calls, no complex logic.
//
// createCheckpoint()  — called at start of fresh summarization run
// loadCheckpoint()    — called on resume
// saveCheckpoint()    — called after every level/group completes
// deleteCheckpoint()  — called on cancel or completion
// getResumePoint()    — returns { phase, levelIndex } — where to continue from
import fs from "fs";
import { getCheckpointPath } from "../storage/fileStorage.js";
// ─── Load / Save / Delete ─────────────────────────────────────────────────────
export function loadCheckpoint(graphId, commitHash) {
    const file = getCheckpointPath(graphId, commitHash);
    if (!fs.existsSync(file))
        return undefined;
    try {
        return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch {
        return undefined;
    }
}
export function saveCheckpoint(checkpoint) {
    const file = getCheckpointPath(checkpoint.graphId, checkpoint.commitHash);
    checkpoint.updatedAt = new Date().toISOString();
    // Atomic write — never corrupts on crash mid-write
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(checkpoint, null, 2), "utf-8");
    fs.renameSync(tmp, file);
}
export function deleteCheckpoint(graphId, commitHash) {
    const file = getCheckpointPath(graphId, commitHash);
    if (fs.existsSync(file))
        fs.unlinkSync(file);
}
// ─── Create ───────────────────────────────────────────────────────────────────
//
// Called once at the start of a fresh summarization run.
// nodeOrder is now string[][] — each inner array is one parallel level.
// On resume we load this file and never redo the topo sort.
export function createCheckpoint(graphId, commitHash, nodeOrder, cycleGroups, fileNodes) {
    const now = new Date().toISOString();
    const totalRegularNodes = nodeOrder.reduce((sum, level) => sum + level.length, 0);
    const totalCycleNodes = cycleGroups.reduce((sum, g) => sum + g.size, 0);
    const totalNodes = totalRegularNodes + totalCycleNodes + fileNodes.length;
    const checkpoint = {
        graphId,
        commitHash,
        status: "running",
        createdAt: now,
        updatedAt: now,
        nodeOrder,
        cycleGroups,
        fileNodes,
        // -1 = not started for all three phases
        lastCompletedLevel: -1,
        lastCompletedCycleGroup: -1,
        lastCompletedFileNode: -1,
        totalNodes,
        completedNodes: 0,
    };
    saveCheckpoint(checkpoint);
    return checkpoint;
}
export function getResumePoint(checkpoint) {
    // Phase 1 — regular nodes (level by level)
    if (checkpoint.lastCompletedLevel < checkpoint.nodeOrder.length - 1) {
        return {
            phase: "nodes",
            index: checkpoint.lastCompletedLevel + 1,
        };
    }
    // Phase 2 — cycle groups
    if (checkpoint.lastCompletedCycleGroup < checkpoint.cycleGroups.length - 1) {
        return {
            phase: "cycles",
            index: checkpoint.lastCompletedCycleGroup + 1,
        };
    }
    // Phase 3 — file nodes
    if (checkpoint.lastCompletedFileNode < checkpoint.fileNodes.length - 1) {
        return {
            phase: "files",
            index: checkpoint.lastCompletedFileNode + 1,
        };
    }
    return { phase: "done", index: -1 };
}
// ─── Progress update helpers ──────────────────────────────────────────────────
//
// Called by the batch loop after each level/group/file completes.
// Marks an entire level as completed — levels are atomic.
export function markLevelCompleted(checkpoint, levelIndex) {
    checkpoint.lastCompletedLevel = levelIndex;
    checkpoint.completedNodes += checkpoint.nodeOrder[levelIndex].length;
}
export function markCycleGroupCompleted(checkpoint, groupIndex) {
    checkpoint.lastCompletedCycleGroup = groupIndex;
    checkpoint.completedNodes += checkpoint.cycleGroups[groupIndex].size;
}
export function markFileNodeCompleted(checkpoint, index) {
    checkpoint.lastCompletedFileNode = index;
    checkpoint.completedNodes++;
}
// Marks a batch of file nodes as completed.
// batchEnd = index of the LAST node in the batch (inclusive).
// count    = how many nodes were actually in the batch (may be < batchSize at end).
export function markFileNodeBatchCompleted(checkpoint, batchEnd, count) {
    checkpoint.lastCompletedFileNode = batchEnd;
    checkpoint.completedNodes += count;
}

// Storage round-trip + back-compat tests for the exports map.
//
// STORAGE_DIR is computed from os.homedir() at module load, so these tests
// point it at a temp dir via DEVLENS_STORAGE_DIR and import the module
// dynamically AFTER setting the env var — nothing here ever touches the
// real ~/.devlens.

import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import type { PipelineResult } from "../pipeline/index.js";
import type { CodeNode, CodeEdge, GraphExports } from "../types.js";

const FAKE_STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-storage-test-"));
process.env.DEVLENS_STORAGE_DIR = FAKE_STORAGE_ROOT;

const { saveGraph, getGraph, deleteGraph } = await import("./fileStorage.js");

function makeNode(id: string, name: string): CodeNode {
  return {
    id,
    name,
    type: "FUNCTION",
    filePath: `src/${name}.ts`,
    startLine: 1,
    endLine: 2,
    parentFile: `file::src/${name}.ts`,
    metadata: {},
  };
}

function makeResult(overrides: Partial<PipelineResult> & { graphId: string }): PipelineResult {
  const nodes = [makeNode("src/alpha.ts::alpha", "alpha"), makeNode("src/alpha.ts::alpha#2", "alpha")];
  const edges: CodeEdge[] = [];
  return {
    repoPath: FAKE_STORAGE_ROOT,
    analyzedAt: "2026-10-07T00:00:00.000Z",
    fingerprint: { language: "typescript" } as PipelineResult["fingerprint"],
    routes: [],
    nodes,
    edges,
    allNodes: nodes,
    allEdges: edges,
    nodeScores: {},
    stats: {
      totalNodesBeforeFilter: nodes.length,
      totalEdgesBeforeFilter: 0,
      totalNodesAfterFilter: nodes.length,
      totalEdgesAfterFilter: 0,
      removedNodeCount: 0,
      removedEdgeCount: 0,
      averageNodeScore: 0,
      topScoringNodes: [],
      topScoringFiles: [],
    },
    isGithubRepo: false,
    gitInfo: { commitHash: "abc12345", branch: "main", message: "test", hasGit: true },
    ...overrides,
  } as PipelineResult;
}

const MAP: GraphExports = {
  exports: {
    ".": {
      alpha: ["src/alpha.ts::alpha", "src/alpha.ts::alpha#2"],
      beta: ["src/beta.ts::beta"],
    },
    "./server": { serve: ["src/server.ts::serve"] },
  },
  ambiguousNames: {},
};

describe("exports map persistence (saveGraph -> getGraph)", () => {
  test("round trip: map survives byte-for-byte, including multi-id groups and order", () => {
    const result = makeResult({ graphId: "rt-test-graph", exports: MAP });
    saveGraph(result, { force: true });

    const loaded = getGraph("rt-test-graph", "abc12345");
    expect(loaded).toBeDefined();
    expect(loaded!.exports).toBeDefined();
    // deep identity: shape, keys, values, AND array order within groups
    expect(loaded!.exports).toEqual(MAP);
    expect(loaded!.exports!.exports["."].alpha).toEqual(["src/alpha.ts::alpha", "src/alpha.ts::alpha#2"]);
    expect(loaded!.exports!.ambiguousNames).toEqual({});

    deleteGraph("rt-test-graph");
  });

  test("legacy artifact without the exports field: loads, yields undefined, no fabricated empty map", () => {
    const result = makeResult({ graphId: "legacy-test-graph" });
    delete (result as { exports?: unknown }).exports;
    saveGraph(result, { force: true });

    const commitFile = path.join(
      FAKE_STORAGE_ROOT, "graphs", "legacy-test-graph", "commits", "abc12345.json"
    );
    const onDisk = JSON.parse(fs.readFileSync(commitFile, "utf-8"));
    expect("exports" in onDisk).toBe(false);

    const loaded = getGraph("legacy-test-graph", "abc12345");
    expect(loaded).toBeDefined();
    expect(loaded!.exports).toBeUndefined();

    deleteGraph("legacy-test-graph");
  });

  test("degraded input: exports present but EMPTY subpaths load without crash", () => {
    const emptyMap: GraphExports = { exports: { ".": {} }, ambiguousNames: {} };
    const result = makeResult({ graphId: "empty-map-graph", exports: emptyMap });
    saveGraph(result, { force: true });

    const loaded = getGraph("empty-map-graph", "abc12345");
    expect(loaded).toBeDefined();
    expect(loaded!.exports).toEqual(emptyMap);

    deleteGraph("empty-map-graph");
  });

  test("degraded input: exports referencing node ids ABSENT from the nodes array load without crash", () => {
    const danglingMap: GraphExports = {
      exports: { ".": { ghost: ["src/gone.ts::gone"] } },
      ambiguousNames: {},
    };
    const result = makeResult({ graphId: "dangling-map-graph", exports: danglingMap });
    saveGraph(result, { force: true });

    const loaded = getGraph("dangling-map-graph", "abc12345");
    expect(loaded).toBeDefined();
    expect(loaded!.exports).toEqual(danglingMap);
    expect(loaded!.exports!.exports["."].ghost).toEqual(["src/gone.ts::gone"]);

    deleteGraph("dangling-map-graph");
  });
});

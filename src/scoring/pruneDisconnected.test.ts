import { describe, expect, test } from "bun:test";
import { pruneDisconnected, PRUNABLE_TYPES } from "./pruneDisconnected.js";
import type { CodeNode, CodeEdge } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeNode(overrides: Partial<CodeNode> & { id: string; name: string }): CodeNode {
  return {
    type:       "FUNCTION",
    filePath:   "src/test.go",
    startLine:  1,
    endLine:    10,
    parentFile: "file::src/test.go",
    metadata:   {},
    ...overrides,
  };
}

function makeFileNode(filePath: string, childNodeIds: string[] = []): CodeNode {
  return {
    id:         `file::${filePath}`,
    name:       filePath.split("/").pop()!,
    type:       "FILE",
    filePath,
    startLine:  0,
    endLine:    100,
    parentFile: `file::${filePath}`,
    metadata:   { nodeCount: childNodeIds.length, childNodeIds },
  };
}

function makeEdge(from: string, to: string, type: CodeEdge["type"] = "CALLS"): CodeEdge {
  return { from, to, type, metadata: {} };
}

// ─── pruneDisconnected ─────────────────────────────────────────────────────

describe("pruneDisconnected", () => {
  test("PRUNABLE_TYPES covers the 5 declaration types", () => {
    expect([...PRUNABLE_TYPES].sort()).toEqual(["ENUM", "INTERFACE", "PACKAGE", "STRUCT", "TRAIT"]);
  });

  test("drops zero-edge STRUCT/INTERFACE/ENUM/PACKAGE/TRAIT nodes", () => {
    const nodes: CodeNode[] = [
      makeFileNode("a.go", ["a.go::Keep", "a.go::Drop"]),
      makeNode({ id: "a.go::Keep", name: "Keep", type: "STRUCT", parentFile: "file::a.go" }),
      makeNode({ id: "a.go::Drop", name: "Drop", type: "STRUCT", parentFile: "file::a.go" }),
      makeNode({ id: "a.go::Iface", name: "Iface", type: "INTERFACE", parentFile: "file::a.go" }),
      makeNode({ id: "a.go::Color", name: "Color", type: "ENUM", parentFile: "file::a.go" }),
      makeNode({ id: "pkg::example.com/mod", name: "mod", type: "PACKAGE", filePath: "" }),
      makeNode({ id: "a.go::Trait", name: "Trait", type: "TRAIT", parentFile: "file::a.go" }),
      makeNode({ id: "a.go::fn", name: "fn", type: "FUNCTION", parentFile: "file::a.go" }),
    ];
    // Keep STRUCT is a CALLS target; everything else floats
    const edges: CodeEdge[] = [makeEdge("a.go::fn", "a.go::Keep")];

    const { nodes: kept, removedNodeCount } = pruneDisconnected(nodes, edges);

    expect(removedNodeCount).toBe(5);
    const ids = kept.map((n) => n.id);
    expect(ids).toContain("a.go::Keep");
    expect(ids).toContain("a.go::fn");
    expect(ids).not.toContain("a.go::Drop");
    expect(ids).not.toContain("a.go::Iface");
    expect(ids).not.toContain("a.go::Color");
    expect(ids).not.toContain("pkg::example.com/mod");
    expect(ids).not.toContain("a.go::Trait");
  });

  test("connected prunable nodes survive (edge in EITHER direction)", () => {
    const nodes: CodeNode[] = [
      makeNode({ id: "s.go::Impl", name: "Impl", type: "STRUCT", parentFile: "file::s.go" }),
      makeNode({ id: "s.go::Iface", name: "Iface", type: "INTERFACE", parentFile: "file::s.go" }),
      makeNode({ id: "s.go::Color", name: "Color", type: "ENUM", parentFile: "file::s.go" }),
    ];
    // STRUCT implements INTERFACE (source), ENUM is the CALLS target
    const edges: CodeEdge[] = [
      makeEdge("s.go::Impl", "s.go::Iface", "IMPLEMENTS"),
      makeEdge("s.go::fn", "s.go::Color"),
    ];

    const { nodes: kept, removedNodeCount } = pruneDisconnected(nodes, edges);
    expect(removedNodeCount).toBe(0);
    expect(kept.map((n) => n.id).sort()).toEqual(["s.go::Color", "s.go::Iface", "s.go::Impl"]);
  });

  test("cleans childNodeIds + nodeCount on FILE parents", () => {
    const nodes: CodeNode[] = [
      makeFileNode("a.go", ["a.go::Keep", "a.go::Drop", "a.go::fn"]),
      makeNode({ id: "a.go::Keep", name: "Keep", type: "STRUCT", parentFile: "file::a.go" }),
      makeNode({ id: "a.go::Drop", name: "Drop", type: "ENUM", parentFile: "file::a.go" }),
      makeNode({ id: "a.go::fn", name: "fn", type: "FUNCTION", parentFile: "file::a.go" }),
    ];
    const edges: CodeEdge[] = [makeEdge("a.go::fn", "a.go::Keep")];

    const { nodes: kept } = pruneDisconnected(nodes, edges);
    const file = kept.find((n) => n.type === "FILE")!;
    expect(file.metadata.childNodeIds).toEqual(["a.go::Keep", "a.go::fn"]);
    expect(file.metadata.nodeCount).toBe(2);
  });

  test("cleans resolvedCalls entries pointing at pruned nodes", () => {
    const nodes: CodeNode[] = [
      makeNode({
        id: "a.go::fn", name: "fn", type: "FUNCTION", parentFile: "file::a.go",
        metadata: { resolvedCalls: [{ name: "Color.Red", nodeId: "a.go::Color" }] },
      }),
      makeNode({ id: "a.go::Color", name: "Color", type: "ENUM", parentFile: "file::a.go" }),
    ];
    const { nodes: kept } = pruneDisconnected(nodes, []);
    const fn = kept.find((n) => n.id === "a.go::fn")!;
    expect(fn.metadata.resolvedCalls).toEqual([]);
  });

  test("idempotent — pruning an already-pruned graph is a no-op", () => {
    const nodes: CodeNode[] = [
      makeFileNode("a.go", ["a.go::fn"]),
      makeNode({ id: "a.go::fn", name: "fn", type: "FUNCTION", parentFile: "file::a.go" }),
      makeNode({ id: "a.go::Color", name: "Color", type: "ENUM", parentFile: "file::a.go" }),
    ];
    const edges: CodeEdge[] = [makeEdge("a.go::fn", "a.go::Color")]; // enum connected → kept

    const first = pruneDisconnected(nodes, edges);
    const second = pruneDisconnected(first.nodes, first.edges);
    expect(second.removedNodeCount).toBe(0);
    expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
  });

  test("CLASS/METHOD/FUNCTION/ROUTE/FILE/TEST are never pruned", () => {
    const nodes: CodeNode[] = [
      makeNode({ id: "c.go::K", name: "K", type: "CLASS", parentFile: "file::c.go" }),
      makeNode({ id: "c.go::m", name: "m", type: "METHOD", parentFile: "file::c.go" }),
      makeNode({ id: "c.go::f", name: "f", type: "FUNCTION", parentFile: "file::c.go" }),
      makeNode({ id: "c.go::r", name: "r", type: "ROUTE", parentFile: "file::c.go" }),
      makeNode({ id: "file::c_test.go", name: "c_test.go", type: "TEST", parentFile: "file::c_test.go" }),
    ];
    const { nodes: kept, removedNodeCount } = pruneDisconnected(nodes, []);
    expect(removedNodeCount).toBe(0);
    expect(kept).toHaveLength(5);
  });
});

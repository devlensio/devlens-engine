import { describe, expect, test } from "bun:test";
import { buildPrompt, buildSystemPrompt } from "./prompts.js";
import type { CodeNode, ResolvedCall } from "../types.js";

function node(over: Partial<CodeNode> & { id: string; name: string }): CodeNode {
  return {
    type: "FUNCTION",
    filePath: "src/handler.ts",
    startLine: 1,
    endLine: 10,
    metadata: {},
    ...over,
  } as CodeNode;
}

function ctx(node: CodeNode, allNodes: CodeNode[], systemPrompt = "SYS") {
  const outgoing = new Map<string, Map<string, string[]>>();
  for (const dep of allNodes) {
    if (!outgoing.has(node.id)) outgoing.set(node.id, new Map());
    const inner = outgoing.get(node.id)!;
    if (!inner.has("CALLS")) inner.set("CALLS", []);
    inner.get("CALLS")!.push(dep.id);
  }
  return {
    node,
    allNodes: new Map(allNodes.map((n) => [n.id, n])),
    edgeIndex: { outgoing, incoming: new Map() },
    routeIndex: { byFilePath: new Map() },
    systemPrompt,
  } as any;
}

const userPrompt = (c: any) => buildPrompt(c)[1].content as string;

describe("summarizer prompt — call order", () => {
  const parseBody = node({
    id: "f::parseBody", name: "parseBody", technicalSummary: "Reads the raw request body.",
  });
  const validate = node({
    id: "f::validateUser", name: "validateUser", technicalSummary: "Checks the payload against schema rules.",
  });
  const save = node({
    id: "f::save", name: "save", technicalSummary: "Upserts the user row.",
  });
  const notify = node({
    id: "f::notify", name: "sendEmail", technicalSummary: "Queues the welcome email.",
  });

  // Deliberately passed in a different order than the call order, so the test
  // fails if we render edge/insertion order instead of firstOrder.
  const resolved: ResolvedCall[] = [
    { name: "save", nodeId: "f::save", firstOrder: 3, repeat: true, maybe: true },
    { name: "parseBody", nodeId: "f::parseBody", firstOrder: 1, awaited: true },
    { name: "validateUser", nodeId: "f::validateUser", firstOrder: 2 },
    { name: "sendEmail", nodeId: "f::notify", firstOrder: 4, defer: "timer" },
  ];

  const caller = node({
    id: "f::handler",
    name: "handler",
    rawCode: "async function handler(req) { ... }",
    metadata: { resolvedCalls: resolved },
  });

  test("callees are numbered in execution order, not edge order", () => {
    const prompt = userPrompt(ctx(caller, [save, parseBody, validate, notify]));
    const lines = prompt.split("\n").filter((l) => /^\s+\d+\. /.test(l));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("1. parseBody");
    expect(lines[1]).toContain("2. validateUser");
    expect(lines[2]).toContain("3. save");
    expect(lines[3]).toContain("4. sendEmail");
  });

  test("markers are rendered from the resolved call record", () => {
    const prompt = userPrompt(ctx(caller, [parseBody, validate, save, notify]));
    expect(prompt).toContain("1. parseBody [FUNCTION] (await)");
    expect(prompt).toContain("3. save [FUNCTION] (loop, conditional)");
    expect(prompt).toContain("4. sendEmail [FUNCTION] (deferred:timer)");
    // no markers on an unconditional, awaited-free callee
    expect(prompt).toContain("2. validateUser [FUNCTION] —");
  });

  test("callee summaries are still included", () => {
    const prompt = userPrompt(ctx(caller, [parseBody, validate, save, notify]));
    expect(prompt).toContain("Reads the raw request body.");
    expect(prompt).toContain("Checks the payload against schema rules.");
    expect(prompt).toContain("Upserts the user row.");
  });

  test("repeated callees report how many positions reached them", () => {
    const twice = node({
      id: "f::dup", name: "dup",
      metadata: {
        resolvedCalls: [
          { name: "a", nodeId: "f::a", firstOrder: 1, orders: [1, 3] },
        ] as ResolvedCall[],
      },
    });
    const a = node({ id: "f::a", name: "a", technicalSummary: "Does a." });
    expect(userPrompt(ctx(twice, [a]))).toContain("(reached x2)");
  });

  test("a node without ordering renders exactly as before", () => {
    const plain = node({ id: "f::plain", name: "plain", metadata: {} });
    const prompt = userPrompt(ctx(plain, [parseBody, validate]));
    expect(prompt).not.toContain("Call sequence");
    expect(prompt).toContain("### Dependencies");
    expect(prompt).toContain("Calls:\n  parseBody [FUNCTION]");
  });

  test("system prompt documents every marker", () => {
    const sys = buildSystemPrompt({
      framework: "next", language: "typescript", projectType: "web",
      stateManagement: [], databases: [], dataFetching: [],
    } as any);
    for (const marker of ["await", "parallel", "loop", "conditional", "deferred", "reached xN"]) {
      expect(sys).toContain(marker);
    }
    // The ordered flow is only useful if the summary narrates it.
    expect(sys).toContain("three or more ordered callees");
  });
});

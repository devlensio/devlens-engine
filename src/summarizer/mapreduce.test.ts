import { describe, expect, it } from "bun:test";
import type { CodeNode } from "../types.js";
import type { LLMClient, LLMRequest, NodeSummaryOutput } from "./providers/types.js";
import { mapreduceSummarize, exceedsThreshold } from "./mapreduce.js";
import { MAPREDUCE_TOKEN_THRESHOLD } from "./types.js";

function bigNode(): CodeNode {
  const line = "export function thing(n: number) { return n + 1; }\n";
  return {
    id: "src/big.ts::big",
    name: "big",
    type: "FUNCTION",
    filePath: "src/big.ts",
    rawCode: line.repeat(Math.ceil((MAPREDUCE_TOKEN_THRESHOLD * 4) / line.length) + 40),
  } as CodeNode;
}

function summary(text: string): NodeSummaryOutput {
  return {
    technicalSummary: text,
    businessSummary: "",
    security: { severity: "none", summary: "" },
    tokensUsed: 5,
  };
}

/** Fails the nth client call, in order, according to `shouldFail`. */
function client(shouldFail: (call: number, req: LLMRequest) => boolean, label = "ok"): LLMClient {
  let calls = 0;
  return {
    provider: "openai",
    model: "mock",
    async summarize(req: LLMRequest) {
      calls++;
      if (shouldFail(calls, req)) throw new Error(`call ${calls} exploded`);
      return summary(`${label} ${calls}`);
    },
    async validateConnection() {},
  } as unknown as LLMClient;
}

describe("mapreduce", () => {
  it("routes oversized nodes through the threshold check", () => {
    expect(exceedsThreshold(bigNode())).toBe(true);
  });

  it("keeps the chunks that worked when one chunk fails", async () => {
    const out = await mapreduceSummarize(bigNode(), client(c => c === 1), "sys");
    // Chunk 1 failed, the reduce pass then answered — a summary exists, and the
    // node is not reported as a failure.
    expect(out.technicalSummary.startsWith("ok ")).toBe(true);
    expect(out.tokensUsed).toBeGreaterThan(0);
  });

  it("saves the chunk summaries when the reduce pass fails", async () => {
    const out = await mapreduceSummarize(
      bigNode(),
      client((c, req) => req.messages.some(m => m.content.includes("final complete summary"))),
      "sys",
    );
    expect(out.technicalSummary).toContain("ok 1");
    expect(out.technicalSummary).toContain("ok 2");
    expect(out.security.severity).toBe("none");
  });

  it("throws the provider's error when every chunk fails", async () => {
    const err = await mapreduceSummarize(bigNode(), client(() => true), "sys").catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("call 1 exploded");
  });
});
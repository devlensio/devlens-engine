// End-to-end check that a summarization run survives provider failures:
// bad nodes are recorded and skipped, good nodes are persisted, the checkpoint
// keeps the failures, and a second run repairs them.
//
//   HOME=$(mktemp -d) DEVLENS_STORAGE_DIR=$HOME/.devlens \
//   DEVLENS_LLM_RETRY_BASE_MS=20 bun run scripts/verify-summarizer.ts

import fs from "fs";
import os from "os";
import path from "path";

const home = os.homedir();
fs.mkdirSync(path.join(home, ".devlens"), { recursive: true });

const GOOD = "<technical>Does a thing.</technical><business>Used by the app.</business><security_severity>none</security_severity>";
let failBeta = true;
let requests = 0;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = await req.text();
    requests++;
    if (failBeta && body.includes("beta")) {
      return Response.json({ error: { message: "quota exceeded", type: "rate_limit" } });
    }
    return Response.json({
      choices: [{ message: { role: "assistant", content: GOOD }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
  },
});

fs.writeFileSync(
  path.join(home, ".devlens", "config.json"),
  JSON.stringify(
    {
      summarization: {
        provider: "openai",
        providerName: "mock",
        model: "mock-model",
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
      },
    },
    null,
    2,
  ),
);

const { analyzePipeline } = await import("../src/pipeline/index.js");
const { storage } = await import("../src/storage/index.js");
const { getCheckpointPath } = await import("../src/storage/fileStorage.js");
const { runSummarization } = await import("../src/summarizer/index.js");

// Tiny repo — one directory, three modules, two of them calling into beta.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-sum-"));
fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "tiny", version: "1.0.0" }));
fs.mkdirSync(path.join(repo, "src"));
fs.writeFileSync(
  path.join(repo, "src", "beta.ts"),
  `export function beta() {\n  return 1;\n}\n`,
);
fs.writeFileSync(
  path.join(repo, "src", "alpha.ts"),
  `import { beta } from "./beta";\nexport function alpha() {\n  return beta() + 1;\n}\n`,
);
fs.writeFileSync(
  path.join(repo, "src", "gamma.ts"),
  `import { alpha } from "./alpha";\nexport function gamma() {\n  return alpha() * 2;\n}\n`,
);

const analysis = await analyzePipeline(repo, false, { includedThirdPartyLibs: [] });
storage.saveGraph(analysis, { force: true });

const job: any = {
  jobId: "verify-1",
  status: "running",
  phase: "summarization",
  repoPath: repo,
  isGithubRepo: false,
  config: {} as any,
  events: [],
  pauseRequested: false,
  cancelRequested: false,
  createdAt: new Date().toISOString(),
};

const queue: any = {
  getJob: () => job,
  updateJob: () => {},
  emitEvent: () => {},
};

function callbacks() {
  const seen: any = { completed: null, error: null, started: null };
  return {
    seen,
    cb: {
      onStarted: (n: number) => { seen.started = n; },
      onProgress: () => {},
      onPause: () => { seen.paused = true; },
      onCancel: () => { seen.cancelled = true; },
      onComplete: (stats: any) => { seen.completed = stats; },
      onError: (msg: string) => { seen.error = msg; },
    },
  };
}

async function summarize(tag: string) {
  const { seen, cb } = callbacks();
  await runSummarization({
    job,
    queue,
    graphId: analysis.graphId,
    commitHash: analysis.gitInfo.commitHash,
    repoPath: repo,
    routes: analysis.routes,
    callbacks: cb as any,
  });

  const graph = storage.getGraph(analysis.graphId, analysis.gitInfo.commitHash)!;
  const withSummary = graph.allNodes.filter((n) => n.technicalSummary).length;
  const without = graph.allNodes.filter((n) => !n.technicalSummary).map((n) => n.id);
  const checkpointPath = getCheckpointPath(analysis.graphId, analysis.gitInfo.commitHash);
  const checkpoint = fs.existsSync(checkpointPath) ? JSON.parse(fs.readFileSync(checkpointPath, "utf-8")) : null;

  console.log(`\n── ${tag} ──`);
  console.log("stats      :", JSON.stringify(seen.completed));
  console.log("error      :", seen.error);
  console.log("summarized :", withSummary, "of", graph.allNodes.length);
  console.log("still bare :", without);
  console.log("checkpoint :", checkpoint ? `failedNodes=${JSON.stringify(checkpoint.failedNodes)}` : "deleted");
  console.log("llm calls  :", requests);
  return { seen, withSummary, without, checkpoint };
}

const first = await summarize("run 1 — beta always fails");
if (!first.seen.completed || first.seen.completed.failed === 0) throw new Error("expected a partial completion");
if (first.withSummary === 0) throw new Error("expected the good nodes to be saved");
if (!first.checkpoint?.failedNodes?.length) throw new Error("expected failed nodes in the checkpoint");

failBeta = false;
const second = await summarize("run 2 — provider healthy, repair pass");
if (second.seen.completed?.failed !== 0) throw new Error("expected the repair pass to clear the failures");
if (second.without.length !== 0) throw new Error("expected every node to have a summary");

console.log("\nOK — partial run saved its work, and the next run repaired the gaps.");
server.stop(true);
process.exit(0);
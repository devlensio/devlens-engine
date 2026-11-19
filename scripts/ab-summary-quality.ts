// One-off: does the shipped prompt actually produce execution-ordered summaries,
// compared with the pre-callOrder prompt on the same nodes and the same model?
//
// CURRENT  = shipped prompt (ordered call sequence + "three or more callees" rule)
// BASELINE = the same prompt with that section and that rule removed, i.e. what the
//            summarizer sent before the change. Nothing else differs.
//
// Run: bun scripts/ab-summary-quality.ts <graphJson> [limit] [concurrency]
import { readFileSync } from "node:fs";
import { buildPrompt, buildEdgeIndex, buildRouteIndex, buildSystemPrompt } from "../src/summarizer/prompts.js";
import type { CodeNode, CodeEdge, RouteNode, BackendRouteNode, ProjectFingerprint } from "../src/types.js";

const graphPath = process.argv[2];
const LIMIT = Number(process.argv[3] ?? 30);
const CONC = Number(process.argv[4] ?? 6);
const KEY = readFileSync("/home/shivang/Folder E/DevLens Workspace/DevLens benchmarks/.secrets/qwen-key.txt", "utf8").trim();
const BASE = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
const MODEL = "deepseek-v4.1-flash";

const graph = JSON.parse(readFileSync(graphPath, "utf8")) as {
  nodes: CodeNode[]; edges: CodeEdge[]; routes?: (RouteNode | BackendRouteNode)[]; fingerprint?: ProjectFingerprint;
};
const allNodes = new Map(graph.nodes.map(n => [n.id, n]));
const edgeIndex = buildEdgeIndex(graph.edges ?? []);
const routeIndex = buildRouteIndex(graph.routes ?? []);
const fingerprint: ProjectFingerprint = graph.fingerprint ?? {
  language: "rust" as ProjectFingerprint["language"],
  projectType: "cli" as ProjectFingerprint["projectType"],
  framework: "none" as ProjectFingerprint["framework"],
  router: "none" as ProjectFingerprint["router"],
  stateManagement: [], dataFetching: [], databases: [], rawDependencies: {},
};
const systemPrompt = buildSystemPrompt(fingerprint);

// The pre-change prompt: no ordered sequence section, no "three or more" rule.
function stripBaseline(messages: { role: string; content: string }[]) {
  return messages.map(m => {
    if (m.role === "user") {
      const cut = m.content.replace(/\n### Call sequence \(execution order\)\n(?:.*\n)*?(?=\n### |\s*$)/, "\n");
      return { ...m, content: cut };
    }
    if (m.role === "system") {
      return {
        ...m,
        content: m.content
          .replace(/\n?When a node has three or more ordered callees[^\n]*\n?/i, "\n")
          .replace(/\n?### Call sequence \(execution order\)[\s\S]*?(?=\n\n|$)/i, ""),
      };
    }
    return m;
  });
}

const FLOW = /\bthen\b|followed by|in order|sequenc/i;
const MARK = /\bawait|async|parallel|concurren|loop|iterat|conditional|\bif\b|defer|later|after .* returns/i;

function score(summary: string, node: CodeNode) {
  const rc = (node.metadata?.resolvedCalls ?? []) as { name?: string; firstOrder?: number }[];
  const cand = new Map<string, number>();
  for (const c of rc) {
    if (c.name && typeof c.firstOrder === "number" && !cand.has(c.name)) cand.set(c.name, c.firstOrder);
  }
  const named = [...cand.entries()].filter(([nm]) => new RegExp(`\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(summary));
  const ordered = named.length >= 2
    ? [...named].sort((a, b) => a[1] - b[1]).map(e => e[0]).join("|") === named.map(e => e[0]).join("|")
    : null;
  return { namedCallees: named.length, ordered, flow: FLOW.test(summary), markers: MARK.test(summary), chars: summary.length };
}

async function call(messages: { role: string; content: string }[]) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0, max_tokens: 900 }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json() as { choices: { message: { content: string } }[] };
      return j.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return "";
}

const pick = graph.nodes
  .filter(n => (n.metadata?.resolvedCalls?.length ?? 0) >= 3 && (n.rawCode?.length ?? 0) > 0)
  .slice(0, LIMIT);

const rows: { id: string; cur: ReturnType<typeof score>; base: ReturnType<typeof score> }[] = [];
let idx = 0;
async function worker() {
  while (idx < pick.length) {
    const node = pick[idx++];
    const msgs = buildPrompt({ node, allNodes, edgeIndex, routeIndex, systemPrompt }) as { role: string; content: string }[];
    const [cur, base] = await Promise.all([call(msgs), call(stripBaseline(msgs))]);
    rows.push({ id: node.id, cur: score(cur, node), base: score(base, node) });
    process.stderr.write(".");
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

const pct = (x: number, d: number) => d === 0 ? "n/a" : `${((100 * x) / d).toFixed(0)}%`;
const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
for (const k of ["cur", "base"] as const) {
  const r = rows.map(x => x[k]);
  const orderable = r.filter(x => x.ordered !== null);
  const named3 = r.filter(x => x.namedCallees >= 3);
  console.log(`${k === "cur" ? "CURRENT " : "BASELINE"}  nodes=${r.length}`
    + `  order-ok=${pct(orderable.filter(x => x.ordered).length, orderable.length)}`
    + `  names>=3=${pct(named3.length, r.length)}`
    + `  flow=${pct(r.filter(x => x.flow).length, r.length)}`
    + `  markers=${pct(r.filter(x => x.markers).length, r.length)}`
    + `  medianChars=${med(r.map(x => x.chars))}`);
}
const both = rows.filter(x => x.cur.ordered !== null && x.base.ordered !== null);
console.log(`paired: current-better=${both.filter(x => x.cur.ordered && !x.base.ordered).length}`
  + ` baseline-better=${both.filter(x => !x.cur.ordered && x.base.ordered).length}`
  + ` same=${both.filter(x => x.cur.ordered === x.base.ordered).length}`);

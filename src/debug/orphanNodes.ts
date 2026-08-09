import path from "path";
import fs from "fs";
import { parseRepo } from "../parser/index.js";
import { analyzeFilesystem } from "../filesystem/index.js";
import { analyzeFingerprint } from "../fingerprint/index.js";
import { detectEdges } from "../graph/index.js";
import { scoreAndFilter } from "../scoring/index.js";

const repoPath = process.argv[2];
if (!repoPath) { console.error("Usage: bun run src/debug/orphanNodes.ts <repo-path>"); process.exit(1); }
const abs = path.resolve(repoPath);

const fingerprint = analyzeFingerprint(abs);
console.log("framework:", fingerprint.framework, "type:", fingerprint.projectType);
const routeNodes = analyzeFilesystem(abs, fingerprint);
console.log("routeNodes:", routeNodes.length, "(BACKEND_ROUTE count)");
const { nodes } = parseRepo(abs);
console.log("parsed nodes:", nodes.length);
const { edges, ghostNodes } = detectEdges(nodes, routeNodes, abs, fingerprint);
console.log("edges:", edges.length, "ghosts:", ghostNodes.length);

const allNodes = [...nodes, ...ghostNodes];
const { filteredNodes, filteredEdges } = scoreAndFilter(allNodes, edges);
console.log("after filter — nodes:", filteredNodes.length, "edges:", filteredEdges.length);

// Edge type histogram
console.log(`\n=== Edge type histogram ===`);
const hist = new Map<string, number>();
for (const e of filteredEdges as any[]) hist.set(e.type, (hist.get(e.type) ?? 0) + 1);
for (const [t, c] of [...hist.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${c}`);

// Orphans on FILTERED graph
const connected = new Set<string>();
for (const e of filteredEdges as any[]) { connected.add(e.from); connected.add(e.to); }
let orphans = filteredNodes.filter((n: any) => !connected.has(n.id));
console.log(`\n=== ORPHANS (filtered, no edges): ${orphans.length} ===`);

// Group: FILE not imported vs FUNCTION not called
const fileOrphans = orphans.filter((n:any)=>n.type==="FILE");
const fnOrphans = orphans.filter((n:any)=>n.type==="FUNCTION"||n.type==="HOOK"||n.type==="COMPONENT");
console.log(`  FILE orphans: ${fileOrphans.length}`);
console.log(`  FUNCTION/HOOK/COMPONENT orphans: ${fnOrphans.length}`);

// For FUNCTION/HOOK orphans in OSS server handlers — are they even called anywhere in OSS src?
console.log(`\n=== Sample FUNCTION/HOOK orphans (name + filePath) — checking if name appears in repo source ===`);
for (const n of fnOrphans.slice(0, 15)) {
  const name = (n as any).name;
  const fp = (n as any).filePath ?? "";
  // Crude: grep the repo for `\bname(` or `name)`
  // We'll just report; the user can decide.
  console.log(`  [${(n as any).type}] ${name}  in ${path.relative(abs, fp)}`);
}

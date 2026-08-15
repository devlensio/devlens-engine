import path from "path";
import { createHash } from "crypto";
import { execSync } from "child_process";
import { analyzeFingerprint } from "../fingerprint/index.js";
import { analyzeFilesystem } from "../filesystem/index.js";
import { parseRepo } from "../parser/index.js";
import { detectEdges } from "../graph/index.js";
import { buildThirdPartyNodes } from "../graph/thirdPartyLibs.js";
import { scoreAndFilter } from "../scoring/index.js";
import type { FilterThresholds } from "../scoring/noiseFilter.js";
import type {
  CodeNode,
  CodeEdge,
  ProjectFingerprint,
  RouteNode,
  BackendRouteNode,
} from "../types.js";
import { runExtractor } from "../extractors/runner.js";

export type { FilterThresholds };

//  Types 

export interface GitInfo {
  commitHash: string;   // 8-char short hash, or timestamp string if no git
  branch: string;
  message: string;
  hasGit: boolean;
}

export interface PipelineOptions {
  thresholds?: FilterThresholds;
  onStep?: (step: "fingerprint" | "filesystem" | "parse" | "edges" | "scoring") => void;
  includedThirdPartyLibs?: string[];
}

export interface PipelineStats {
  totalNodesBeforeFilter: number;
  totalEdgesBeforeFilter: number;
  totalNodesAfterFilter: number;
  totalEdgesAfterFilter: number;
  removedNodeCount: number;
  removedEdgeCount: number;
  averageNodeScore: number;
  topScoringNodes: { name: string; score: number; type: string }[];
  topScoringFiles: { name: string; score: number; filePath: string }[];
}

export interface PipelineResult {
  graphId: string;       // stable hash of repoPath — same repo always same id
  repoPath: string;
  analyzedAt: string;
  fingerprint: ProjectFingerprint;
  routes: (RouteNode | BackendRouteNode)[];
  nodes: CodeNode[];   // filtered — what frontend renders
  edges: CodeEdge[];   // filtered
  allNodes: CodeNode[];   // unfiltered — needed for refiltering
  allEdges: CodeEdge[];   // unfiltered — needed for refiltering
  nodeScores: Record<string, number>;  // ALL scores including removed nodes
  stats: PipelineStats;
  isGithubRepo: boolean;
  gitInfo: GitInfo;
}

//  Helpers 

// Deterministic graphId — same repo always produces same id
// This ensures multiple analyses of the same repo go into the same folder
function generateGraphId(repoPath: string, isGithubRepo: boolean): string {
  const normalized = isGithubRepo
    ? repoPath.toLowerCase().trim()         // normalize GitHub URL
    : path.resolve(repoPath).toLowerCase(); // normalize local path

  return createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 16);
}

// Gets current git state of the repo
// Falls back gracefully if git is not initialized
function getGitInfo(repoPath: string): GitInfo {
  try {
    const commitHash = execSync("git rev-parse HEAD", { cwd: repoPath })
      .toString().trim();
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath })
      .toString().trim();
    const message = execSync("git log -1 --pretty=%s", { cwd: repoPath })
      .toString().trim();

    return { commitHash, branch, message, hasGit: true };
  } catch {
    // No git, or no commits yet — use timestamp as version key
    return {
      commitHash: Date.now().toString(),
      branch: "unknown",
      message: "no git history",
      hasGit: false,
    };
  }
}

function buildStats(
  scoringResult: ReturnType<typeof scoreAndFilter>,
  allNodes: CodeNode[]
): PipelineStats {
  const topScoringFiles = allNodes
    .filter((n) => n.type === "FILE")
    .map((n) => ({
      name: n.name,
      score: scoringResult.nodeScores.get(n.id) ?? 0,
      filePath: n.filePath,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return {
    ...scoringResult.stats,
    topScoringFiles,
  };
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [k, v] of map) record[k] = v;
  return record;
}


//  routesToCodeNodes 
//
// Converts RouteNode[] / BackendRouteNode[] into ROUTE CodeNodes so they
// participate in the graph as first-class nodes.
//
// Route-specific fields go into metadata — CodeNode schema stays clean.
// IDs follow the same filePath::name convention as all other nodes so
// the lookup maps in buildLookupMaps() work without any changes.
//
// Naming convention:
//   Next.js page/layout/API:  "GET /api/users"  → id = "app/api/users/route.ts::GET /api/users"
//   Backend (Express etc.):   "POST /users"      → id = "src/routes/users.ts::POST /users"

export function routesToCodeNodes(
  routes: (RouteNode | BackendRouteNode)[],
  repoPath: string,
): CodeNode[] {
  const nodes: CodeNode[] = [];

  for (const route of routes) {
    // Make filePath relative — same as parser does for all other nodes
    const relativeFilePath = path.relative(repoPath, route.filePath).replace(/\\/g, "/");

    if (route.type === "BACKEND_ROUTE") {
      // Each backend route = one node per HTTP method + path combination
      const name = `${route.httpMethod} ${route.urlPath}`;
      const id   = `${relativeFilePath}::${name}`;


      // create synthetic function type nodes for the inline handlers
      let inlineHandlerId: string | undefined;
      if(route.inlineHandler){
        inlineHandlerId = `${relativeFilePath}::${name}::handler`;
        nodes.push({
          id:         inlineHandlerId,
          name:       `${name} handler`,
          type:       "FUNCTION",
          filePath:   relativeFilePath,
          startLine:  route.inlineHandler.startLine,
          endLine:    route.inlineHandler.endLine,
          rawCode:    route.inlineHandler.rawCode,
          codeHash:   createHash("sha256").update(route.inlineHandler.rawCode).digest("hex").slice(0, 16),
          parentFile: `file::${relativeFilePath}`,
          metadata: {
            isHttpHandler:   true,
            httpMethod:      route.httpMethod,
            isInlineHandler: true,
          },
        });
      }


      nodes.push({
        id,
        name,
        type:      "ROUTE",
        filePath:  relativeFilePath,
        startLine: 0,
        endLine:   0,
        parentFile: `file::${relativeFilePath}`,
        metadata: {
          urlPath:      route.urlPath,
          httpMethod:   route.httpMethod,
          isDynamic:    route.isDynamic,
          params:       route.params ?? [],
          framework:    route.framework,
          handlerName:  route.handlerName,  // used by routeEdges to resolve handler
          routeKind:    "backend",
        },
      });

    }else if (route.type === "REACT_ROUTER_ROUTE"){
      // React Router / TanStack / wouter route — a single ROUTE node, no method.
      const name = route.urlPath;
      const id = `${relativeFilePath}::${name}`;

      nodes.push({
         id,
        name,
        type:      "ROUTE",
        filePath:  relativeFilePath,
        startLine: 0,
        endLine:  0,
        parentFile: `file::${relativeFilePath}`,
        metadata: {
          urlPath:       route.urlPath,
          httpMethod:    null,
          isDynamic:     route.isDynamic,
          isCatchAll:    route.isCatchAll,
          isGroupRoute:  route.isGroupRoute,
          params:        route.params ?? [],
          routeNodeType:    "REACT_ROUTER_ROUTE",
          framework:        "react-router",
          routeKind:        "react-router",
          rendersComponent: route.rendersComponent,  // resolved to a HANDLES edge in routeEdge.ts
        },
      });

    } else {
      // Next.js RouteNode — one node per HTTP method for API routes,
      // one node for page/layout/etc.
      const httpMethods = route.httpMethods && route.httpMethods.length > 0
        ? route.httpMethods
        : route.type === "API_ROUTE"
          ? ["GET", "PUT", "POST", "DELETE", "PATCH"]   // fallback — we'll refine via routeEdges handler lookup
          : [null];           // non-API routes (PAGE, LAYOUT etc.) have no method

      for (const method of httpMethods) {
        const name = method
          ? `${method} ${route.urlPath}`
          : route.urlPath;
        const id = `${relativeFilePath}::${name}`;

        nodes.push({
          id,
          name,
          type:      "ROUTE",
          filePath:  relativeFilePath,
          startLine: 0,
          endLine:   0,
          parentFile: `file::${relativeFilePath}`,
          metadata: {
            urlPath:      route.urlPath,
            httpMethod:   method ?? null,
            isDynamic:    route.isDynamic,
            isCatchAll:   route.isCatchAll,
            isGroupRoute: route.isGroupRoute,
            params:       route.params ?? [],
            routeNodeType: route.type,        // PAGE | LAYOUT | API_ROUTE | etc.
            layoutPath:   route.layoutPath,
            framework:    "nextjs",
            routeKind:    "nextjs",
          },
        });
      }
    }
  }

  return nodes;
}


//  analyzePipeline 

export async function analyzePipeline(
  repoPath: string,
  isGithubRepo: boolean,
  options?: PipelineOptions
): Promise<PipelineResult> {

  const absoluteRepoPath = path.resolve(repoPath);


  const graphId = generateGraphId(repoPath, isGithubRepo);// stable, deterministic ID based on repo path
  const gitInfo = getGitInfo(absoluteRepoPath);
  const analyzedAt = new Date().toISOString();

  console.log(`\n🔍 devlens — analyzing ${absoluteRepoPath}`);
  console.log(`   Graph ID:   ${graphId}`);
  console.log(`   Commit:     ${gitInfo.commitHash} (${gitInfo.branch})`);
  console.log(`   Message:    ${gitInfo.message}`);

  // ── Steps 1-4: Run the extractor (inline for JS/TS, subprocess for others)
  //
  // The extractor handles fingerprinting, filesystem/route detection, parsing,
  // and edge detection. It returns nodes, edges, routes, and fingerprint
  // all in one ExtractorResult.
  //
  // For JS/TS: runs inline via ts-morph (same code as before, no subprocess)
  // For Python/Java/Go/Rust: spawns a child process

  const extractorResult = await runExtractor(absoluteRepoPath, {
    includeThirdPartyLibs: options?.includedThirdPartyLibs,
    onStep: options?.onStep,
  });

  console.log(
    `  Framework: ${extractorResult.fingerprint.framework}  |  ` +
    `Language: ${extractorResult.fingerprint.language}  |  ` +
    `Type: ${extractorResult.fingerprint.projectType}`
  );
  console.log(
    `  Files: ${extractorResult.stats.totalFiles}  |  ` +
    `Nodes: ${extractorResult.stats.totalNodes}  |  ` +
    `Skipped: ${extractorResult.stats.skippedFiles}`
  );
  console.log(`  Edges: ${extractorResult.edges.length}`);

  if (extractorResult.errors.length > 0) {
    console.warn(`  ⚠ ${extractorResult.errors.length} files had errors:`);
    for (const err of extractorResult.errors.slice(0, 5)) {
      console.warn(`    - ${err.file}: ${err.error}`);
    }
  }


  const allNodes: CodeNode[] = extractorResult.nodes;
  const allEdges: CodeEdge[] = extractorResult.edges;

  //  Step 5: Score and filter 
  console.log("\n[5/5] Scoring and filtering...");
  const scoringResult = scoreAndFilter(allNodes, allEdges, options?.thresholds);

  const nodeScores = mapToRecord(scoringResult.nodeScores);
  const stats = buildStats(scoringResult, allNodes);
  
  // Embed score directly onto every node — allNodes and filteredNodes both.
  // nodeScores map stays for diffCommits and refilterPipeline which need it,
  // but consumers (frontend, Neo4j, summarizer) get score on the node itself.
  for(const node of allNodes) {
    node.score = nodeScores[node.id] ?? 0;
  }

  console.log(`\n✅ Analysis complete — graph ${graphId} @ commit ${gitInfo.commitHash}`);

  return {
    graphId,
    repoPath: absoluteRepoPath,
    analyzedAt,
    fingerprint: extractorResult.fingerprint,
    routes: extractorResult.routes ?? [],
    nodes: scoringResult.filteredNodes,
    edges: scoringResult.filteredEdges,
    allNodes,
    allEdges,
    nodeScores,
    stats,
    isGithubRepo,
    gitInfo,
  };
}

//  refilterPipeline 

export function refilterPipeline(
  stored: PipelineResult,
  thresholds: FilterThresholds
): Pick<PipelineResult, "nodes" | "edges" | "stats"> {
  const existingScores = new Map<string, number>(
    Object.entries(stored.nodeScores)
  );

  const scoringResult = scoreAndFilter(
    stored.allNodes,
    stored.allEdges,
    thresholds,
    existingScores
  );

  const stats = buildStats(scoringResult, stored.allNodes);

  return {
    nodes: scoringResult.filteredNodes,
    edges: scoringResult.filteredEdges,
    stats,
  };
}


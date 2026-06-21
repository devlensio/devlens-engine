import { computeClusters } from "../clustering/index.js";
import { buildTopologicalOrder } from "../summarizer/topological.js";
import type { CycleGroup } from "../summarizer/types.js";
import { CodeEdge, CodeNode, EdgeType } from "../types.js";

export interface GraphIndex {
    nodesById: Map<string, CodeNode>;
    forward: Map<string, CodeEdge[]>;  // from -> outgoing edges (downstream / callees), used for kHops
    reverse: Map<string, CodeEdge[]>; // to -> incoming edges (used for blast radius)
    nodesByFilePath: Map<string, string[]>; // filepath -> nodeIds in that file
}

export function buildGraphIndex(nodes: CodeNode[], edges: CodeEdge[]): GraphIndex {
    const nodesById = new Map<string, CodeNode>();
    const forward = new Map<string, CodeEdge[]>();
    const reverse = new Map<string, CodeEdge[]>();
    const nodesByFilePath = new Map<string, string[]>();

    for (const node of nodes) {
        nodesById.set(node.id, node);
        const fp = node.filePath || "external";
        if (!nodesByFilePath.has(fp)) nodesByFilePath.set(fp, []);
        nodesByFilePath.get(fp)!.push(node.id);
    }

    for (const edge of edges) {
        if (!forward.has(edge.from)) forward.set(edge.from, []);
        forward.get(edge.from)!.push(edge);

        if (!reverse.has(edge.to)) reverse.set(edge.to, []);
        reverse.get(edge.to)!.push(edge);
    }

    return {nodesById, forward, reverse, nodesByFilePath};
}


export interface TraversalHit {
  nodeId:  string;
  hop:     number;     // distance from seed (1 = directly connected)
  viaEdge: EdgeType;   // edge type that first reached this node
}

export interface TraversalResult {
  seedId:            string;
  direction:         "upstream" | "downstream";
  hits:              TraversalHit[];
  truncated:         boolean;   // true = default-radius cap stopped us at hop 1
  stoppedAtRadius:   number;
  hop1Count:         number;
  radiusUsed:        number;
  radiusWasExplicit: boolean;
}

export interface TraversalOpts {
  radius?:    number;        // omitted => default 2 + cap; explicit => uncapped
  edgeTypes?: EdgeType[];    // restrict which edges BFS follows; default all
}

const DEFAULT_RADIUS = 2;
const HOP1_CAP       = 100;

function bfsTraverse(
  index: GraphIndex,
  seedId: string,
  direction: "upstream" | "downstream",
  opts: TraversalOpts = {}
): TraversalResult {
  const explicit   = opts.radius !== undefined;
  const maxRadius  = opts.radius ?? DEFAULT_RADIUS;
  const edgeFilter = opts.edgeTypes ? new Set(opts.edgeTypes) : null;
  // downstream (callees) walks forward edges; upstream (callers) walks reverse
  const adj = direction === "downstream" ? index.forward : index.reverse;

  const visited = new Set<string>([seedId]);   // seed excluded from results
  const hits: TraversalHit[] = [];
  let queue: string[] = [seedId];
  let hop1Count = 0;
  let truncated = false;
  let stoppedAtRadius = 0;

  for (let hop = 1; hop <= maxRadius; hop++) {
    const nextqueue: string[] = [];

    for (const nodeId of queue) {
      for (const edge of adj.get(nodeId) ?? []) {
        if (edgeFilter && !edgeFilter.has(edge.type)) continue;
        const neighborId = direction === "downstream" ? edge.to : edge.from;
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        hits.push({ nodeId: neighborId, hop, viaEdge: edge.type });
        nextqueue.push(neighborId);
      }
    }

    if (hop === 1) {
      hop1Count = nextqueue.length;
      // Cap applies ONLY on the default (non-explicit) path:
      // huge fanout → return hop-1 hits, skip deeper hops, flag truncated.
      if (!explicit && hop1Count >= HOP1_CAP) {
        truncated = true;
        stoppedAtRadius = 1;
        break;
      }
    }

    stoppedAtRadius = hop;
    queue = nextqueue;
    if (queue.length === 0) break;   // nothing more to expand
  }

  return {
    seedId, direction, hits, truncated, stoppedAtRadius, hop1Count,
    radiusUsed: maxRadius, radiusWasExplicit: explicit,
  };
}

// Upstream / dependents — "if I change this node, what is affected"
export function getBlastRadius(index: GraphIndex, seedId: string, opts?: TraversalOpts): TraversalResult {
  return bfsTraverse(index, seedId, "upstream", opts);
}

// Downstream / dependencies — "what this node calls/uses"
export function getKHop(index: GraphIndex, seedId: string, opts?: TraversalOpts): TraversalResult {
  return bfsTraverse(index, seedId, "downstream", opts);
}


export interface SubgraphResult {
    seedNodeId: string;
    clusterId: string;
    nodes: CodeNode[];
    edges: CodeEdge[]; // edge with BOTH ends inside the cluster
}

export function getSubgraph(
  allNodes: CodeNode[],
  allEdges: CodeEdge[],
  nodeScores: Record<string, number>,
  seedNodeId: string
): SubgraphResult | undefined {
  const { clusterMembership } = computeClusters(allNodes, allEdges, nodeScores);

  const clusterId = clusterMembership[seedNodeId];
  if (!clusterId) return undefined;   // seed not found / not clustered

  const memberIds = new Set<string>();
  for (const [nodeId, cId] of Object.entries(clusterMembership)) {
    if (cId === clusterId) memberIds.add(nodeId);
  }

  const nodes = allNodes.filter(n => memberIds.has(n.id));
  const edges = allEdges.filter(e => memberIds.has(e.from) && memberIds.has(e.to));

  return { seedNodeId, clusterId, nodes, edges };
}


// Cyclic dependency groups — reuses the connected-component detection that
// already runs inside the topological sort (src/summarizer/topological.ts).
export function findCycles(nodes: CodeNode[], edges: CodeEdge[]): CycleGroup[] {
  return buildTopologicalOrder(nodes, edges).cycleGroups;
}
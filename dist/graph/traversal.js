import { computeClusters } from "../clustering/index.js";
import { buildTopologicalOrder } from "../summarizer/topological.js";
export function buildGraphIndex(nodes, edges) {
    const nodesById = new Map();
    const forward = new Map();
    const reverse = new Map();
    const nodesByFilePath = new Map();
    for (const node of nodes) {
        nodesById.set(node.id, node);
        const fp = node.filePath || "external";
        if (!nodesByFilePath.has(fp))
            nodesByFilePath.set(fp, []);
        nodesByFilePath.get(fp).push(node.id);
    }
    for (const edge of edges) {
        if (!forward.has(edge.from))
            forward.set(edge.from, []);
        forward.get(edge.from).push(edge);
        if (!reverse.has(edge.to))
            reverse.set(edge.to, []);
        reverse.get(edge.to).push(edge);
    }
    return { nodesById, forward, reverse, nodesByFilePath };
}
const DEFAULT_RADIUS = 2;
const HOP1_CAP = 100;
function bfsTraverse(index, seedId, direction, opts = {}) {
    const explicit = opts.radius !== undefined;
    const maxRadius = opts.radius ?? DEFAULT_RADIUS;
    const edgeFilter = opts.edgeTypes ? new Set(opts.edgeTypes) : null;
    // downstream (callees) walks forward edges; upstream (callers) walks reverse
    const adj = direction === "downstream" ? index.forward : index.reverse;
    const visited = new Set([seedId]); // seed excluded from results
    const hits = [];
    let queue = [seedId];
    let hop1Count = 0;
    let truncated = false;
    let stoppedAtRadius = 0;
    for (let hop = 1; hop <= maxRadius; hop++) {
        const nextqueue = [];
        for (const nodeId of queue) {
            for (const edge of adj.get(nodeId) ?? []) {
                if (edgeFilter && !edgeFilter.has(edge.type))
                    continue;
                const neighborId = direction === "downstream" ? edge.to : edge.from;
                if (visited.has(neighborId))
                    continue;
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
        if (queue.length === 0)
            break; // nothing more to expand
    }
    return {
        seedId, direction, hits, truncated, stoppedAtRadius, hop1Count,
        radiusUsed: maxRadius, radiusWasExplicit: explicit,
    };
}
// Upstream / dependents — "if I change this node, what is affected"
export function getBlastRadius(index, seedId, opts) {
    return bfsTraverse(index, seedId, "upstream", opts);
}
// Downstream / dependencies — "what this node calls/uses"
export function getKHop(index, seedId, opts) {
    return bfsTraverse(index, seedId, "downstream", opts);
}
export function getSubgraph(allNodes, allEdges, nodeScores, seedNodeId) {
    const { clusterMembership } = computeClusters(allNodes, allEdges, nodeScores);
    const clusterId = clusterMembership[seedNodeId];
    if (!clusterId)
        return undefined; // seed not found / not clustered
    const memberIds = new Set();
    for (const [nodeId, cId] of Object.entries(clusterMembership)) {
        if (cId === clusterId)
            memberIds.add(nodeId);
    }
    const nodes = allNodes.filter(n => memberIds.has(n.id));
    const edges = allEdges.filter(e => memberIds.has(e.from) && memberIds.has(e.to));
    return { seedNodeId, clusterId, nodes, edges };
}
// Cyclic dependency groups — reuses the connected-component detection that
// already runs inside the topological sort (src/summarizer/topological.ts).
export function findCycles(nodes, edges) {
    return buildTopologicalOrder(nodes, edges).cycleGroups;
}

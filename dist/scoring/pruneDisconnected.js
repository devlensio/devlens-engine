// ─── Connected-only node pruning (engine-wide) ─────────────────────────────
//
// Type-declaration nodes (STRUCT/INTERFACE/ENUM/PACKAGE/TRAIT) are emitted by
// the language extractors as declarations, but a node with ZERO edge
// participation renders as a floating dot — pure noise. This pass drops those
// nodes from every language uniformly (Java INTERFACE/ENUM, Rust STRUCT/ENUM/
// TRAIT, Go STRUCT/INTERFACE/ENUM; Python/JS are unaffected — they don't emit
// these types, and CLASS stays always-on per the JS scope decision).
//
// Rule: a prunable node survives iff it is referenced by ≥1 edge (either
// direction). A Go ENUM implementing an interface or a Rust ENUM with an impl
// block is referenced → kept. Floating serializers/validators/enum constants →
// dropped.
//
// Idempotent: refiltering an already-pruned stored graph is a no-op.
export const PRUNABLE_TYPES = new Set([
    "STRUCT",
    "INTERFACE",
    "ENUM",
    "PACKAGE",
    "TRAIT",
]);
export function pruneDisconnected(nodes, edges) {
    const referenced = new Set();
    for (const e of edges) {
        referenced.add(e.from);
        referenced.add(e.to);
    }
    const removed = new Set();
    const kept = [];
    for (const node of nodes) {
        if (PRUNABLE_TYPES.has(node.type) && !referenced.has(node.id)) {
            removed.add(node.id);
            continue;
        }
        kept.push(node);
    }
    if (removed.size === 0) {
        return { nodes: kept, edges, removedNodeCount: 0 };
    }
    // Clean FILE parents: drop pruned ids from childNodeIds + nodeCount so the
    // frontend drill-down never references a node that isn't in the graph.
    for (const node of kept) {
        if (node.type === "FILE") {
            const meta = node.metadata;
            const childIds = meta.childNodeIds;
            if (Array.isArray(childIds)) {
                const clean = childIds.filter((id) => !removed.has(id));
                if (clean.length !== childIds.length) {
                    meta.childNodeIds = clean;
                    meta.nodeCount = clean.length;
                }
            }
        }
        // Any node may carry resolvedCalls pointing at a pruned declaration
        // (e.g. a call that resolved to an enum member) — drop the dangling refs.
        const resolvedCalls = node.metadata.resolvedCalls;
        if (Array.isArray(resolvedCalls)) {
            const cleanCalls = resolvedCalls.filter((r) => !removed.has(r.nodeId ?? ""));
            if (cleanCalls.length !== resolvedCalls.length) {
                node.metadata.resolvedCalls = cleanCalls;
            }
        }
    }
    return { nodes: kept, edges, removedNodeCount: removed.size };
}

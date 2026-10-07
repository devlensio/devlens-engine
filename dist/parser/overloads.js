// Overload disambiguation — same-name function-likes in the same file.
//
// Node ids are `${relativePath}::${name}`, so a file with two `formatValue`
// functions (or an overloaded `Logger.log` method pair) produced two nodes
// with ONE id; downstream dedupe (buildGraphResponse, summarizer, storage)
// silently dropped all but the first and every CALLS edge picked arbitrarily.
//
// Convention (mirrored by the Go/Java/Python/Rust extractors — keep in sync,
// see MULTI_LANGUAGE_EXPANSION.md):
//   - Unique name in file  → id unchanged (`utils.ts::formatValue`)
//   - Collision, distinct arities → `#arity` suffix (`utils.ts::formatValue#2`)
//   - Collision, same arity, different param types → `#arity#<sig8>` where
//     sig8 = first 8 hex of sha256 over the normalized param-type list
//   - Arity-suffix never uses ordinals: the suffix is the declaration's own
//     parameter count, so reordering functions in a file cannot change ids
//
// Signature-identical declarations (a TS overload signature plus an
// implementation with the same param list) collapse into ONE node, keeping
// the one with a body — they are the same callable.
import { createHash } from "crypto";
const OVERLOADABLE_TYPES = new Set(["FUNCTION", "METHOD"]);
function paramTypes(node) {
    const parameters = node.metadata?.parameters;
    if (!Array.isArray(parameters))
        return [];
    return parameters.map((p) => {
        const t = typeof p?.type === "string" && p.type.length > 0 ? p.type : "unknown";
        if (p?.isRest)
            return `...${t}`;
        if (p?.isOptional)
            return `${t}?`;
        return t;
    });
}
function signatureKey(node) {
    return `(${paramTypes(node).join(",")})`;
}
function hasBody(node) {
    return node.metadata?.isOverloadSignature !== true;
}
export function applyOverloadDisambiguation(nodes, relativePath) {
    // Group function-likes by name (METHOD names are dotted `Class.method`, so
    // same-name methods on different classes never collide here).
    const groups = new Map();
    for (const node of nodes) {
        if (!OVERLOADABLE_TYPES.has(node.type))
            continue;
        if (!groups.has(node.name))
            groups.set(node.name, []);
        groups.get(node.name).push(node);
    }
    for (const [name, group] of groups) {
        if (group.length < 2)
            continue;
        group.sort((a, b) => a.startLine - b.startLine);
        // Collapse signature-identical declarations, preferring the one with a body.
        // Single pass — each node's signature key is computed exactly once.
        const bySignature = new Map();
        const keys = new Map();
        for (const node of group) {
            const key = signatureKey(node);
            keys.set(node, key);
            const existing = bySignature.get(key);
            if (!existing) {
                bySignature.set(key, node);
                continue;
            }
            // Keep the implementation; drop the bare signature duplicate.
            if (!hasBody(existing) && hasBody(node))
                bySignature.set(key, node);
        }
        const survivors = [...bySignature.values()].sort((a, b) => a.startLine - b.startLine);
        if (survivors.length < group.length) {
            const kept = new Set(survivors);
            for (const node of group) {
                if (!kept.has(node))
                    node.metadata.isDuplicateOverload = true;
            }
        }
        // Single survivor after collapse → the name is unique again, no suffix.
        if (survivors.length < 2)
            continue;
        // Distinct arities within the group → readable `#arity` suffix.
        const arities = new Set(survivors.map((n) => n.metadata?.params?.length ?? 0));
        const useArityOnly = arities.size === survivors.length;
        for (const node of survivors) {
            const arity = node.metadata?.params?.length ?? 0;
            let suffix = `#${arity}`;
            if (!useArityOnly) {
                const sig8 = createHash("sha256").update(keys.get(node)).digest("hex").slice(0, 8);
                suffix = `#${arity}#${sig8}`;
            }
            node.id = `${relativePath}::${name}${suffix}`;
        }
    }
}

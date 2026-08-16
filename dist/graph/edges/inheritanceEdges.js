// inheritanceEdges.ts — EXTENDS / IMPLEMENTS edge detector for the inline
// JS/TS path.
//
// The classes extractor records `metadata.extendsType` (raw text, generics
// included) and `metadata.implementsTypes` (string[]) on CLASS nodes. This
// detector resolves those names against the lookup maps — mirroring how
// callEdges reads `metadata.calls` — and emits:
//
//   class X extends Y      → EXTENDS    (Y must resolve to a local CLASS node)
//   class X implements Y   → IMPLEMENTS (Y must resolve to a local CLASS node;
//                                        interface targets are ignored — JS/TS
//                                        deliberately has no INTERFACE nodes)
//
// Rules:
//   - Extends generics are stripped (`React.Component<Props>` → `React.Component`),
//     so third-party bases (no local node) are skipped, never dangling.
//   - Dotted bases (`ns.Base`) don't match plain node names → skipped.
//   - Name collisions resolve via closestByPath (same as callEdges).
//   - Edges are deduped by from→to:type.
import { closestByPath } from "./utils.js";
import { stripGenerics } from "../../parser/extractors/classes.js";
export function detectInheritanceEdges(nodes, lookupMp) {
    const edges = [];
    const created = new Set();
    const resolveTarget = (typeName, fromFile) => {
        const targets = lookupMp.nodesByName.get(typeName);
        if (!targets || targets.length === 0)
            return undefined;
        return targets.length === 1 ? targets[0] : closestByPath(targets, fromFile);
    };
    for (const node of nodes) {
        if (node.type !== "CLASS")
            continue;
        // ── EXTENDS ─────────────────────────────────────────────────────────
        const extendsType = node.metadata.extendsType;
        if (extendsType) {
            const base = stripGenerics(extendsType);
            const target = resolveTarget(base, node.filePath);
            if (target && target.type === "CLASS" && target.id !== node.id) {
                const key = `${node.id}→${target.id}:EXTENDS`;
                if (!created.has(key)) {
                    created.add(key);
                    edges.push({
                        from: node.id,
                        to: target.id,
                        type: "EXTENDS",
                        metadata: { extendsType },
                    });
                }
            }
        }
        // ── IMPLEMENTS (local CLASS targets only) ───────────────────────────
        const implementsTypes = node.metadata.implementsTypes;
        if (implementsTypes && implementsTypes.length > 0) {
            for (const impl of implementsTypes) {
                const target = resolveTarget(impl, node.filePath);
                if (!target || target.type !== "CLASS" || target.id === node.id)
                    continue;
                const key = `${node.id}→${target.id}:IMPLEMENTS`;
                if (!created.has(key)) {
                    created.add(key);
                    edges.push({
                        from: node.id,
                        to: target.id,
                        type: "IMPLEMENTS",
                        metadata: { implementsType: impl },
                    });
                }
            }
        }
    }
    return edges;
}

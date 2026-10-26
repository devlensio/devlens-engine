
// before creating edges, we need to build lookup maps for efficient node lookup in O(N)
import type { CodeNode } from "../types.js";

/** Where a local name in a file came from (the import statement, resolved). */
export interface ImportTarget {
    /** repo-relative file the specifier resolves to */
    targetFile: string;
    /** the name AS EXPORTED by targetFile ("default" / "*" for default+namespace) */
    importedName: string;
    kind: "named" | "default" | "namespace";
}

/** One hop of a re-export chain, recorded for provenance only. */
export interface ReexportLink {
    targetFile: string;
    targetName: string;
}

export interface LookupMaps {
    nodesByName: Map<string, CodeNode[]>;
    nodesByFile: Map<string, CodeNode[]>;
    fileNodesByPath: Map<string, CodeNode>; // filePath → FILE node
    storeNodes: CodeNode[];
    thirdPartyNodesByName: Map<string, CodeNode>;           // packageName → THIRD_PARTY node
    thirdPartyImportAliases: Map<string, Map<string, string>>; // filePath → (localAlias → thirdPartyNodeId)
    localImportSymbols: Map<string, Map<string, string>>;   // filePath → (localAlias → importedName)
    // ── module-scoped (binding-aware) resolution ──────────────────────────
    /** filePath → (local name → resolved import target) */
    importTargets: Map<string, Map<string, ImportTarget>>;
    /** filePath → (exported name → nodeIds in the ORIGIN file, overload-suffixed) */
    exportBindings: Map<string, Map<string, string[]>>;
    /** filePath → (exported name → next hop) — provenance only, never resolution */
    reexportLinks: Map<string, Map<string, ReexportLink>>;
    /** filePath → files pulled in by `export * from` — provenance only */
    reexportGlobs: Map<string, string[]>;
    /** every node id in the graph, for O(1) existence checks */
    nodeIds: Set<string>;
}

export function buildLookupMaps(codeNodes: CodeNode[]): LookupMaps {
    const nodesByName = new Map<string, CodeNode[]>();
    const nodesByFile = new Map<string, CodeNode[]>();
    const fileNodesByPath = new Map<string, CodeNode>();
    const storeNodes: CodeNode[] = [];
    const thirdPartyNodesByName = new Map<string, CodeNode>();
    const thirdPartyImportAliases = new Map<string, Map<string, string>>();
    const localImportSymbols = new Map<string, Map<string, string>>();
    const importTargets = new Map<string, Map<string, ImportTarget>>();
    const exportBindings = new Map<string, Map<string, string[]>>();
    const reexportLinks = new Map<string, Map<string, ReexportLink>>();
    const reexportGlobs = new Map<string, string[]>();
    const nodeIds = new Set<string>();

    for (const node of codeNodes) {
        if (node.type === "THIRD_PARTY") {
            thirdPartyNodesByName.set(node.name, node);
            nodeIds.add(node.id);
            continue;
        }

        // FILE nodes go into their own dedicated map — kept separate so other
        // detectors (guards, call edges, etc.) only see function/component nodes
        if (["FILE", "TEST", "STORY"].includes(node.type)) {
            fileNodesByPath.set(node.filePath, node);
            nodeIds.add(node.id);
            continue;
        }

        if (!nodesByName.has(node.name)) {
            nodesByName.set(node.name, []);
        }
        nodesByName.get(node.name)!.push(node);

        if (!nodesByFile.has(node.filePath)) {
            nodesByFile.set(node.filePath, []);
        }
        nodesByFile.get(node.filePath)!.push(node);

        if (node.type === "STATE_STORE") {
            storeNodes.push(node);
        }
        nodeIds.add(node.id);
    }
    return {
        nodesByName,
        nodesByFile,
        fileNodesByPath,
        storeNodes,
        thirdPartyNodesByName,
        thirdPartyImportAliases,
        localImportSymbols,
        importTargets,
        exportBindings,
        reexportLinks,
        reexportGlobs,
        nodeIds,
    };
}

/**
 * Rebuild a flat node list from the lookup maps.
 * Detectors that only receive `LookupMaps` (importEdges) need the node array to
 * index declarations — the maps are a partition of the same nodes, so this is
 * lossless and avoids threading the array through every signature.
 */
export function nodesFromLookup(lookup: LookupMaps): CodeNode[] {
    const out: CodeNode[] = [];
    for (const nodes of lookup.nodesByName.values()) out.push(...nodes);
    for (const node of lookup.fileNodesByPath.values()) out.push(node);
    return out;
}

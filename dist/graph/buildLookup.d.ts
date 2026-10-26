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
    fileNodesByPath: Map<string, CodeNode>;
    storeNodes: CodeNode[];
    thirdPartyNodesByName: Map<string, CodeNode>;
    thirdPartyImportAliases: Map<string, Map<string, string>>;
    localImportSymbols: Map<string, Map<string, string>>;
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
export declare function buildLookupMaps(codeNodes: CodeNode[]): LookupMaps;
/**
 * Rebuild a flat node list from the lookup maps.
 * Detectors that only receive `LookupMaps` (importEdges) need the node array to
 * index declarations — the maps are a partition of the same nodes, so this is
 * lossless and avoids threading the array through every signature.
 */
export declare function nodesFromLookup(lookup: LookupMaps): CodeNode[];

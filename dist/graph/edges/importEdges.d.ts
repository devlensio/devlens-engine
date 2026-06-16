import type { CodeEdge, CodeNode } from "../../types.js";
import type { LookupMaps } from "../buildLookup.js";
export declare function isLocalImport(importPath: string): boolean;
export interface ImportEdgeResult {
    edges: CodeEdge[];
    thirdPartyMethodNodes: CodeNode[];
}
export declare function detectImportEdges(lookupMp: LookupMaps, repoPath: string): ImportEdgeResult;

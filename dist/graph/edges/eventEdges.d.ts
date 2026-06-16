import type { CodeNode, CodeEdge } from "../../types.js";
import type { LookupMaps } from "../buildLookup.js";
export interface EventEdgeResult {
    edges: CodeEdge[];
    ghostNodes: CodeNode[];
}
export declare function detectEventEdges(lookup: LookupMaps, repoPath: string): EventEdgeResult;

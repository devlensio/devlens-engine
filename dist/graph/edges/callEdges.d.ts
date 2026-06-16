import type { CodeEdge, CodeNode } from "../../types.js";
import type { LookupMaps } from "../buildLookup.js";
export interface CallEdgeResult {
    edges: CodeEdge[];
    newThirdPartyNodes: CodeNode[];
}
export declare function detectCallEdges(nodes: CodeNode[], lookupMp: LookupMaps): CallEdgeResult;

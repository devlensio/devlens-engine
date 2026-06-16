import type { CodeEdge, CodeNode } from "../../types.js";
import type { LookupMaps } from "../buildLookup.js";
export declare function detectHookEdges(nodes: CodeNode[], lookup: LookupMaps): CodeEdge[];

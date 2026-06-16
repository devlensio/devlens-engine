import type { CodeEdge, CodeNode } from "../../types.js";
import type { LookupMaps } from "../buildLookup.js";
export declare function detectPropEdges(nodes: CodeNode[], lookupMp: LookupMaps, repoPath: string): CodeEdge[];

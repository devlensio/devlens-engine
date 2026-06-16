import type { CodeEdge, CodeNode } from "../types.js";
import type { TopologicalResult } from "./types.js";
export declare function buildTopologicalOrder(nodes: CodeNode[], edges: CodeEdge[]): TopologicalResult;

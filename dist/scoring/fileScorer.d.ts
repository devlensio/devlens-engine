import type { CodeNode } from "../types.js";
export declare function scoreFile(fileNode: CodeNode, children: CodeNode[], nodeScores: Map<string, number>, importedBy: number): number;

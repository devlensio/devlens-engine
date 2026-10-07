import type { CodeNode, GraphExports } from "../types.js";
export interface ParserResult {
    nodes: CodeNode[];
    exports?: GraphExports;
    stats: {
        totalFiles: number;
        totalNodes: number;
        componentCount: number;
        hookCount: number;
        functionCount: number;
        storeCount: number;
        classCount: number;
        methodCount: number;
        skippedFiles: number;
    };
}
export declare function parseRepo(repoPath: string): ParserResult;

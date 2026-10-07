import type { Project } from "ts-morph";
import type { CodeNode, GraphExports } from "../types.js";
export declare function buildExportsMap(project: Project, repoPath: string, nodes: CodeNode[]): GraphExports | undefined;
export declare function validateExportsMap(map: GraphExports, nodeIds: Set<string>): string[];
export declare function exportsMapStats(map: GraphExports): {
    subpaths: number;
    names: number;
    ambiguous: number;
};

import { CodeEdge, CodeNode } from "../../types.js";
export declare function detectNavigationEdges(nodes: CodeNode[], repoPath: string): {
    edges: CodeEdge[];
    ghostNodes: CodeNode[];
};

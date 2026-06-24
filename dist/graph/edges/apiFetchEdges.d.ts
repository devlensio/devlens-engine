import { CodeEdge, CodeNode } from "../../types.js";
export interface ApiFetchCall {
    callerType: string;
    rawUrl: string;
    resolvedUrl: string;
    method: string;
}
export declare function detectNextjsApiCallEdges(nodes: CodeNode[], repoPath: string): CodeEdge[];

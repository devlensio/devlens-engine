import type { BackendRouteNode, CodeEdge, CodeNode, ProjectFingerprint, RouteNode } from "../types.js";
export interface EdgeDetectionResult {
    edges: CodeEdge[];
    ghostNodes: CodeNode[];
}
export declare function detectEdges(nodes: CodeNode[], routeNodes: (RouteNode | BackendRouteNode)[], repoPath: string, fingerprint: ProjectFingerprint): EdgeDetectionResult;

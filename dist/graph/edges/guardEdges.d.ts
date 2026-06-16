import type { CodeNode, CodeEdge, RouteNode, BackendRouteNode, ProjectFingerprint } from "../../types.js";
import type { LookupMaps } from "../buildLookup.js";
export declare function detectGuardEdges(nodes: CodeNode[], lookup: LookupMaps, routeNodes: (RouteNode | BackendRouteNode)[], repoPath: string, fingerprint: ProjectFingerprint): CodeEdge[];

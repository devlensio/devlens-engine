import { Language, BackendRouteNode, CodeEdge, CodeNode, ProjectFingerprint, RouteNode } from "../types.js";
export interface ExtractorOptions {
    includeThirdPartyLibs?: string[];
}
export interface ExtractorInput {
    repoPath: string;
    options: ExtractorOptions;
}
export interface ExtractorStats {
    totalFiles: number;
    totalNodes: number;
    skippedFiles: number;
}
export interface ExtractorError {
    file: string;
    error: string;
}
export interface ExtractorResult {
    fingerprint: ProjectFingerprint;
    nodes: CodeNode[];
    edges: CodeEdge[];
    routes?: (RouteNode | BackendRouteNode)[];
    stats: ExtractorStats;
    errors: ExtractorError[];
}
export interface LanguageExtractor {
    language: Language;
    command: string;
    args: string[];
    /**
     * Parse the raw stdout from the extractor process into ExtractorResult.
     * The orchestrator calls this after the process exits successfully.
     *
     * Throwing here marks the extraction as failed.
     */
    parseResult: (stdout: string) => ExtractorResult;
}

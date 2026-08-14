// src/extractors/types.ts
//
// The Extractor Contract — defines the interface between the Node.js
// orchestrator and the native-language extractors (Python, Java, Go, Rust).
//
// Communication is JSON over stdin/stdout. See expansion-tracker/contract.html
// for the full spec.

import { Language, Framework, BackendFramework, BackendRouteNode, CodeEdge, CodeNode, ProjectFingerprint, RouteNode } from "../types.js";

export interface ExtractorOptions {
  includeThirdPartyLibs?: string[];
}

// Input to the langauge extractors
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

// Output from the language extractors
export interface ExtractorResult {
  fingerprint: ProjectFingerprint;
  nodes: CodeNode[];
  edges: CodeEdge[];
  routes?: (RouteNode | BackendRouteNode)[];
  stats: ExtractorStats;
  errors: ExtractorError[];
}


// Orchestrator interface for the extractors 

export interface LanguageExtractor {
  language: Language;
  command: string;  // Command to spawn — e.g. "python3" or the path to a binary
  args: string[];   // Arguments to pass to the command - e.g. ["-m", "devlens_extractors_python"] 

  /**
   * Parse the raw stdout from the extractor process into ExtractorResult.
   * The orchestrator calls this after the process exits successfully.
   *
   * Throwing here marks the extraction as failed.
   */
  parseResult: (stdout: string) => ExtractorResult;
}
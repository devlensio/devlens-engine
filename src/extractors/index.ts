// src/extractors/index.ts

import { Language } from "../types.js";
import { ExtractorResult, LanguageExtractor } from "./types.js";

// runner.ts is the main file entry point for the extractors. It contains the runExtractor() function which is called by the pipeline.

// Extractor registry - maps langauge to their extractor config.
// JS/TS is NOT here (it will be handled inline by the runner.ts)

// All subprocesses extractors must return the JSON (ExtractorResults) format
export function defaultParseResult(stdout: string) : ExtractorResult {
    return JSON.parse(stdout) as ExtractorResult;
}

// Subprocess Extractor Registry
// These extractors are spawned as child processes.

const SUBPROCESS_EXTRACTORS : Partial<Record<Language, LanguageExtractor>> = {
    python: {
        language: "python",
        command: "python3",
        args: ["-m", "devlens_extractors_python"],
        parseResult: defaultParseResult,
    },
    java: {
        language: "java",
        command: "java",
        args: ["-jar", "devlens_java_extractor.jar"],
        parseResult: defaultParseResult,
    },
    go: {
        language: "go",
        command: "devlens_go_extractor", // This is a compiled binary, so we can run it directly
        args: [],
        parseResult: defaultParseResult,
    },
    rust: {
        language: "rust",
        command: "devlens_rust_extractor",
        args: [],
        parseResult: defaultParseResult,
    }
}


// Public API to get the extractor config
export function getExtractor(language: Language): LanguageExtractor | undefined {
    return SUBPROCESS_EXTRACTORS[language];
}

// langauges handled inline meaning JS/TS
export const INLINE_LANGUAGES : Set<Language> = new Set(["javascript", "typescript"]);
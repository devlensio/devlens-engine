// src/extractors/index.ts
// Extractor registry - maps langauge to their extractor config.
// JS/TS is NOT here (it will be handled inline by the runner.ts)
// All subprocesses extractors must return the JSON (ExtractorResults) format
export function defaultParseResult(stdout) {
    return JSON.parse(stdout);
}
// Subprocess Extractor Registry
// These extractors are spawned as child processes.
const SUBPROCESS_EXTRACTORS = {
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
};
// Public API to get the extractor config
export function getExtractor(language) {
    return SUBPROCESS_EXTRACTORS[language];
}
// langauges handled inline meaning JS/TS
export const INLINE_LANGUAGES = new Set(["javascript", "typescript"]);

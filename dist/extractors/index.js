// src/extractors/index.ts
import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
// runner.ts is the main file entry point for the extractors. It contains the runExtractor() function which is called by the pipeline.
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
        // Absolute venv python when the postinstall created one (works from
        // node_modules); fall back to PATH python3 in dev/other setups.
        command: resolvePythonCommand(),
        args: ["-m", "devlens_extractors_python"],
        parseResult: defaultParseResult,
    },
    java: {
        language: "java",
        command: "java",
        // Absolute path — the runner spawns with cwd=repoPath, so a bare jar
        // name would be looked up inside the analyzed repo. fileURLToPath
        // also decodes percent-escapes (spaces in the path).
        args: ["-jar", fileURLToPath(new URL("../../extractors/java/devlens_java_extractor.jar", import.meta.url))],
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
// The python extractor is a pip package installed into a venv that the
// postinstall script creates (extractors/python/setup.mjs). Resolve that
// venv's interpreter absolutely — same pattern as the java jar path —
// because the runner spawns with cwd=repoPath. Platform-aware: Windows
// venvs put the interpreter at Scripts\python.exe, Unix at bin/python.
function resolvePythonCommand() {
    const venvBin = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
    const venvPython = fileURLToPath(new URL(`../../extractors/python/.venv/${venvBin}`, import.meta.url));
    return fs.existsSync(venvPython) ? venvPython : "python3";
}
// langauges handled inline meaning JS/TS
export const INLINE_LANGUAGES = new Set(["javascript", "typescript"]);
// Does `command` resolve? Absolute path → existsSync; bare name → PATH scan
// (cross-platform: PATHEXT on win32).
export function commandExists(command) {
    if (command.includes("/") || command.includes("\\")) {
        return fs.existsSync(command);
    }
    const pathEnv = process.env.PATH || "";
    const exts = process.platform === "win32"
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").toLowerCase().split(";")
        : [""];
    for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
        if (!dir)
            continue;
        for (const ext of exts) {
            if (fs.existsSync(path.join(dir, command + ext))
                || fs.existsSync(path.join(dir, command.toUpperCase() + ext))) {
                return true;
            }
        }
    }
    return false;
}

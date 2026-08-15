// src/extractors/index.ts

import { fileURLToPath } from "url";
import fs from "fs";
import path from "path";
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
        // Absolute per-platform static binary path — the runner spawns with
        // cwd=repoPath, so a bare name would be looked up inside the analyzed
        // repo. Cross-compiled at publish time by prepack → build.mjs.
        command: resolveGoBinaryPath(),
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

// The python extractor is a pip package installed into a venv that the
// postinstall script creates (extractors/python/setup.mjs). Resolve that
// venv's interpreter absolutely — same pattern as the java jar path —
// because the runner spawns with cwd=repoPath. Platform-aware: Windows
// venvs put the interpreter at Scripts\python.exe, Unix at bin/python.
function resolvePythonCommand(): string {
    const venvBin = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
    const venvPython = fileURLToPath(
        new URL(`../../extractors/python/.venv/${venvBin}`, import.meta.url)
    );
    return fs.existsSync(venvPython) ? venvPython : "python3";
}

// The Go extractor ships as a static binary per platform, cross-compiled at
// publish time (prepack → extractors/go/build.mjs). Resolve the CURRENT
// platform's binary absolutely — same reason as the java jar path (the runner
// spawns with cwd=repoPath). fileURLToPath also decodes percent-escapes
// (spaces in the path).
function resolveGoBinaryPath(): string {
    const platformDir = process.platform === "win32"
        ? "windows-amd64"
        : process.platform === "darwin"
            ? `darwin-${process.arch === "arm64" ? "arm64" : "amd64"}`
            : `linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
    const exe = process.platform === "win32" ? ".exe" : "";
    return fileURLToPath(
        new URL(`../../extractors/go/bin/${platformDir}/devlens_go_extractor${exe}`, import.meta.url)
    );
}

// langauges handled inline meaning JS/TS
export const INLINE_LANGUAGES : Set<Language> = new Set(["javascript", "typescript"]);

// Does `command` resolve? Absolute path → existsSync; bare name → PATH scan
// (cross-platform: PATHEXT on win32).
export function commandExists(command: string): boolean {
    if (command.includes("/") || command.includes("\\")) {
        return fs.existsSync(command);
    }
    const pathEnv = process.env.PATH || "";
    const exts = process.platform === "win32"
        ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").toLowerCase().split(";")
        : [""];
    for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
        if (!dir) continue;
        for (const ext of exts) {
            if (fs.existsSync(path.join(dir, command + ext))
                || fs.existsSync(path.join(dir, command.toUpperCase() + ext))) {
                return true;
            }
        }
    }
    return false;
}
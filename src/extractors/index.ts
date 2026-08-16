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

// ── extractor artifact resolution ────────────────────────────────────────────
// The subprocess extractors (python venv, java jar, go/rust static binaries)
// are DATA files inside the devlensio package. In a normal install they sit at
// `<pkg>/extractors/…` and resolve relative to this module. But when devlensio
// is BUNDLED into a standalone binary (`bun build --compile`, which is how the
// `@devlensio/cli` and MCP server ship), `import.meta.url` points at the binary
// itself, so the URL-relative path resolves to `/extractors/…` (nonexistent).
// The fallbacks below find the real extractor root for that case.

function resolveExtractorsRoot(): string | null {
  // 1. Env override (CI / unusual layouts): DEVLENS_EXTRACTORS_DIR = the
  //    `extractors/` directory itself.
  const env = process.env.DEVLENS_EXTRACTORS_DIR;
  if (env) {
    const candidate = path.resolve(env);
    if (fs.existsSync(path.join(candidate, "python")) && fs.existsSync(path.join(candidate, "java"))) {
      return candidate;
    }
  }
  // 2. Normal install: `<pkg>/dist/extractors/../../extractors` = `<pkg>/extractors`.
  const viaModule = fileURLToPath(new URL("../../extractors", import.meta.url));
  if (fs.existsSync(viaModule)) return viaModule;
  // 3. Bundled binary: walk up from this bundle's own directory AND from the
  //    cwd to find `<…>/node_modules/devlensio/extractors`. Covers running the
  //    compiled CLI inside a project that depends on devlensio, and global
  //    installs where devlensio sits hoisted beside the CLI package.
  const scanRoots = [
    fileURLToPath(new URL(".", import.meta.url)),
    process.cwd(),
  ];
  for (const start of scanRoots) {
    let dir = path.resolve(start);
    for (;;) {
      const candidate = path.join(dir, "node_modules", "devlensio", "extractors");
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

const extractorsRoot = resolveExtractorsRoot();

/** Absolute path to an extractor artifact under the resolved root (or null). */
function extractorArtifact(rel: string): string | null {
  return extractorsRoot ? path.join(extractorsRoot, rel) : null;
}

function resolvePythonCommand(): string {
  const venvBin = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  const venvPython =
    extractorArtifact(`python/.venv/${venvBin}`) ??
    // Last resort: URL-relative (pre-fix behavior for direct-from-dist runs).
    fileURLToPath(new URL(`../../extractors/python/.venv/${venvBin}`, import.meta.url));
  return fs.existsSync(venvPython) ? venvPython : "python3";
}

function platformDir(): string {
  return process.platform === "win32"
    ? "windows-amd64"
    : process.platform === "darwin"
      ? `darwin-${process.arch === "arm64" ? "arm64" : "amd64"}`
      : `linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
}

function resolveJavaJarPath(): string {
  const rel = "java/devlens_java_extractor.jar";
  return extractorArtifact(rel) ?? fileURLToPath(new URL(`../../extractors/${rel}`, import.meta.url));
}

function resolveGoBinaryPath(): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const rel = `go/bin/${platformDir()}/devlens_go_extractor${exe}`;
  return extractorArtifact(rel) ?? fileURLToPath(new URL(`../../extractors/${rel}`, import.meta.url));
}

function resolveRustBinaryPath(): string {
  const exe = process.platform === "win32" ? ".exe" : "";
  const rel = `rust/bin/${platformDir()}/devlens_rust_extractor${exe}`;
  return extractorArtifact(rel) ?? fileURLToPath(new URL(`../../extractors/${rel}`, import.meta.url));
}

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
        args: ["-jar", resolveJavaJarPath()],
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
        // Absolute per-platform static binary path — the runner spawns with
        // cwd=repoPath, so a bare name would be looked up inside the analyzed
        // repo. Cross-compiled at publish time by prepack → build.mjs.
        command: resolveRustBinaryPath(),
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
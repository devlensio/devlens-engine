// src/extractors/runner.ts
//
// The Runner — two execution modes:
//   1. Subprocess: spawns Python/Java/Go/Rust extractor as child process
//   2. Inline:     calls existing ts-morph code directly (no subprocess)
//
// The pipeline calls runExtractor() which auto-detects language and routes.
// This is basically the entry point for the extractor execution.
/*
What Actually Happens (Timeline)
spawn() creates the child process and returns immediately. The child is now running but waiting for input on stdin. Meanwhile, your Node.js code continues executing line by line.

Here's the real execution order:


TIME 0ms:   spawn("python3", ["-m", "devlens_extractors_python"])
            → child process starts, waits for stdin input

TIME 1ms:   child.stdout.on("data", ...)   ← registers callback (doesn't run yet)
TIME 2ms:   child.stderr.on("data", ...)   ← registers callback (doesn't run yet)
TIME 3ms:   setTimeout(...)                ← registers timer (doesn't fire yet)
TIME 4ms:   child.on("error", ...)         ← registers callback
TIME 5ms:   child.on("close", ...)         ← registers callback

TIME 6ms:   child.stdin.write(JSON.stringify(input))  ← NOW we send the repoPath
TIME 7ms:   child.stdin.end()              ← tells extractor "done sending"

            ← runSubprocessExtractor returns the Promise here
            ← Node.js moves on to other work

            ... child process is running, parsing the repo ...

TIME 5000ms: child finishes, writes JSON to stdout
             → "data" handler fires, collects stdout

TIME 5001ms: child exits with code 0
             → "close" handler fires
             → parseResult(stdout) runs
             → resolve(result) — the Promise resolves
*/
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { analyzeFingerprint } from "../fingerprint/index.js";
import { analyzeFilesystem } from "../filesystem/index.js";
import { routesToCodeNodes } from "../pipeline/index.js";
import { parseRepo } from "../parser/index.js";
import { buildThirdPartyNodes } from "../graph/thirdPartyLibs.js";
import { detectEdges } from "../graph/index.js";
import { detectLanguage } from "./detectLanguage.js";
import { getExtractor, INLINE_LANGUAGES, commandExists } from "./index.js";
// 1. Subprocess Extractor
// What it does: It will start a process for the given extractor, send it the input json, and wait for the output json. if the process times out, it will kill the process and return error result. If the process exits with non-zero code, it will return error result. If the process exits with zero code, it will parse the output json and return the result.
export async function runSubprocessExtractor(extractor, input, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve, reject) => {
        // Friendly guard for artifact-based extractors (java -jar ...):
        // the jar path is resolved from the package location, not repoPath.
        const jarArg = extractor.args.find((a) => a.endsWith(".jar"));
        if (jarArg && !fs.existsSync(jarArg)) {
            reject(new Error(`${extractor.language} extractor artifact not found: ${jarArg}. ` +
                `Build it first: node extractors/${extractor.language}/build.mjs`));
            return;
        }
        // Runtime prerequisites on the installing machine — friendly errors
        // instead of a raw spawn ENOENT.
        if (extractor.language === "java" && !commandExists("java")) {
            reject(new Error("java extractor requires a Java 17+ runtime (JVM) on PATH — " +
                "install a JDK (e.g. Adoptium Temurin) and retry."));
            return;
        }
        if (extractor.language === "python" && !commandExists(extractor.command)) {
            reject(new Error("python extractor unavailable: no Python 3.11+ found. Install Python, " +
                "or bootstrap the extractor venv: node extractors/python/setup.mjs"));
            return;
        }
        const child = spawn(extractor.command, extractor.args, { stdio: ["pipe", "pipe", "pipe"], cwd: input.repoPath });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => {
            stdout += data.toString();
        });
        child.stderr.on("data", (data) => {
            stderr += data.toString();
        });
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`${extractor.language} extractor timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                // Log stderr for debugging but don't crash — return error result
                reject(new Error(`${extractor.language} extractor exited with code ${code}.\n${stderr}`));
                return;
            }
            try {
                const result = extractor.parseResult(stdout);
                resolve(result);
            }
            catch (err) {
                reject(new Error(`Failed to parse ${extractor.language} extractor output: ` +
                    `${err instanceof Error ? err.message : String(err)}`));
            }
        });
        // Send input as JSON on stdin, then close stdin to signal "done sending"
        child.stdin.write(JSON.stringify(input));
        child.stdin.end();
    });
}
;
// 2. Inline Extractor
// calls existing ts-morph code directly (no subprocess). This is used for TypeScript/JavaScript projects. It returns the result directly without spawning a child process.
// This replicates steps 1-6 of the current analyzePipeline and wraps them
// into an ExtractorResult.
export async function runInlineExtractor(input, onStep) {
    const { repoPath, options } = input;
    const absoluteRepoPath = path.resolve(repoPath);
    // Step 1: fingerprint
    onStep?.("fingerprint");
    const fingerprint = analyzeFingerprint(absoluteRepoPath);
    // Step 2: Filesystem / routes
    onStep?.("filesystem");
    const routes = analyzeFilesystem(absoluteRepoPath, fingerprint);
    // Step 3: Convert routes -> CodeNodes (so that they can join the graph)
    // (no onStep here — it's part of the filesystem step)
    let routeNodes = routesToCodeNodes(routes, absoluteRepoPath);
    // Step 4: Parse source files into nodes 
    onStep?.("parse");
    const parserResult = parseRepo(absoluteRepoPath);
    // Step 5: Build Third party nodes (if options is provided)
    const thirdPartyNodes = buildThirdPartyNodes(absoluteRepoPath, options.includeThirdPartyLibs || []);
    //Step 6: We have all the Nodes, now build the edges.
    onStep?.("edges");
    const edgeResult = detectEdges([...parserResult.nodes, ...routeNodes, ...thirdPartyNodes], routes, absoluteRepoPath, fingerprint);
    // Step 7: Filter API route nodes without handlers (JS-specific cleanup)
    routeNodes = routeNodes.filter(routeNode => {
        if (routeNode.metadata.routeNodeType === "API_ROUTE") {
            return edgeResult.edges.some((edge) => edge.type === "HANDLES" && edge.from === routeNode.id);
        }
        return true;
    });
    // Step 8: Assemble final nodes and edges
    const allNodes = [
        ...parserResult.nodes,
        ...routeNodes,
        ...thirdPartyNodes,
        ...edgeResult.ghostNodes
    ];
    const allEdges = edgeResult.edges;
    const stats = {
        totalFiles: parserResult.stats.totalFiles,
        totalNodes: allNodes.length,
        skippedFiles: parserResult.stats.skippedFiles,
    };
    return {
        fingerprint,
        nodes: allNodes,
        edges: allEdges,
        routes,
        stats,
        errors: [],
    };
}
// 3. Dispatch - auto detect other langauges (apart from JS/TS) and routes
export async function runExtractor(repoPath, options) {
    const language = detectLanguage(repoPath);
    const input = {
        repoPath,
        options: {
            includeThirdPartyLibs: options?.includeThirdPartyLibs || []
        }
    };
    if (INLINE_LANGUAGES.has(language)) {
        return runInlineExtractor(input, options?.onStep);
    }
    // For other languages (python, Go, Rust, Java), we need to spawn a subprocess
    const extractor = getExtractor(language);
    if (!extractor) {
        throw new Error(`No extractor registered for language: "${language}". ` +
            `This language may not be supported yet.`);
    }
    ;
    return runSubprocessExtractor(extractor, input);
}

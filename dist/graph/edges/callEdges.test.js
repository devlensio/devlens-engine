import fs from "fs";
import path from "path";
import os from "os";
import { parseRepo } from "../../parser/index.js";
import { buildLookupMaps } from "../buildLookup.js";
import { detectImportEdges } from "./importEdges.js";
import { detectCallEdges } from "./callEdges.js";
import { buildThirdPartyNodes } from "../thirdPartyLibs.js";
// ─── Helpers ─────────────────────────────────────────────────────────────────
function createFakeRepo(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-calls-test-"));
    for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(tmpDir, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
    }
    return tmpDir;
}
function deleteFakeRepo(repoPath) {
    fs.rmSync(repoPath, { recursive: true, force: true });
}
// Mirrors the real pipeline: parse → lookup maps → import edges (populates
// thirdPartyImportAliases + localImportSymbols) → call edges.
// Returns edges AND the mutated node list (detectCallEdges writes
// metadata.resolvedCalls back onto nodes in place).
function detectCalls(repoPath, extraNodes = []) {
    const { nodes } = parseRepo(repoPath);
    const all = [...nodes, ...extraNodes];
    const lookup = buildLookupMaps(all);
    detectImportEdges(lookup, repoPath);
    const result = detectCallEdges(all, lookup);
    return { ...result, all };
}
// ─── Tests ───────────────────────────────────────────────────────────────────
describe("detectCallEdges with class methods", () => {
    // 21. this.save() inside a class → CALLS edge to Class.save
    it("resolves this.method() calls to the class METHOD node", () => {
        const repo = createFakeRepo({
            "src/svc.ts": `
        export class UserService {
          save() { return 1; }
          persist() { return this.save(); }
        }
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "src/svc.ts::UserService.persist",
            to: "src/svc.ts::UserService.save",
            type: "CALLS",
        }));
        deleteFakeRepo(repo);
    });
    // 22. Class.staticMethod() from a plain function
    it("resolves static calls made from outside the class", () => {
        const repo = createFakeRepo({
            "src/stat.ts": `
        export class MathUtils {
          static add(a: number, b: number) { return a + b; }
        }
        export function compute() { return MathUtils.add(1, 2); }
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "src/stat.ts::compute",
            to: "src/stat.ts::MathUtils.add",
            type: "CALLS",
        }));
        deleteFakeRepo(repo);
    });
    // 23. Local-variable instance calls are unresolvable (engine-wide limitation)
    it("does not resolve instance calls through local variables", () => {
        const repo = createFakeRepo({
            "src/local.ts": `
        export class UserService {
          get() { return 1; }
        }
        export function fetchUser() {
          const svc = new UserService();
          return svc.get();
        }
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges.some((e) => e.type === "CALLS" && e.to === "src/local.ts::UserService.get")).toBe(false);
        // Metadata preserved for LLM context
        const caller = parseRepo(repo).nodes.find((n) => n.name === "fetchUser");
        expect(caller?.metadata.calls).toContain("svc.get");
        deleteFakeRepo(repo);
    });
    // 24. Cross-file static call via named import
    it("resolves cross-file class method calls via dotted names", () => {
        const repo = createFakeRepo({
            "src/services.ts": `
        export class UserService {
          static get(id: string) { return id; }
        }
      `,
            "src/use.ts": `
        import { UserService } from "./services";
        export function load(id: string) { return UserService.get(id); }
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "src/use.ts::load",
            to: "src/services.ts::UserService.get",
            type: "CALLS",
        }));
        deleteFakeRepo(repo);
    });
    // 25. Aliased named import → localImportSymbols substitution
    it("resolves aliased imports via the local symbol map", () => {
        const repo = createFakeRepo({
            "src/services.ts": `
        export class UserService {
          static get(id: string) { return id; }
        }
      `,
            "src/use.ts": `
        import { UserService as US } from "./services";
        export function load(id: string) { return US.get(id); }
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "src/use.ts::load",
            to: "src/services.ts::UserService.get",
            type: "CALLS",
        }));
        deleteFakeRepo(repo);
    });
    // 26. Same method name in two files → closestByPath picks the nearest
    it("uses closestByPath for same-name method collisions", () => {
        const repo = createFakeRepo({
            "a/repo.ts": `export class Repo { get() { return "a"; } }`,
            "b/repo.ts": `export class Repo { get() { return "b"; } }`,
            "b/use.ts": `
        import { Repo } from "./repo";
        export function read() { return Repo.get(); }
      `,
        });
        const { edges } = detectCalls(repo);
        const edge = edges.find((e) => e.type === "CALLS" && e.from === "b/use.ts::read");
        expect(edge?.to).toBe("b/repo.ts::Repo.get");
        deleteFakeRepo(repo);
    });
    // 27. Method → plain function in the same file
    it("resolves calls from a method to a plain function", () => {
        const repo = createFakeRepo({
            "src/mix.ts": `
        function normalize(x: number) { return x; }
        export class Pipeline {
          run(x: number) { return normalize(x); }
        }
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "src/mix.ts::Pipeline.run",
            to: "src/mix.ts::normalize",
            type: "CALLS",
        }));
        deleteFakeRepo(repo);
    });
    // 28. Third-party call inside a method (axios.get → [npm]/axios::get)
    it("creates third-party edges for member calls inside methods", () => {
        const repo = createFakeRepo({
            "src/api.ts": `
        import axios from "axios";
        export class ApiClient {
          fetchUsers() { return axios.get("/users"); }
        }
      `,
        });
        const thirdParty = buildThirdPartyNodes(repo, ["axios"]);
        const { edges } = detectCalls(repo, thirdParty);
        const edge = edges.find((e) => e.type === "CALLS" && e.from === "src/api.ts::ApiClient.fetchUsers");
        expect(edge).toBeDefined();
        expect(edge?.to).toBe("[npm]/axios::get");
        expect(edge?.metadata?.isThirdParty).toBe(true);
        deleteFakeRepo(repo);
    });
    // resolvedCalls writeback on METHOD nodes
    it("writes resolvedCalls back onto METHOD nodes", () => {
        const repo = createFakeRepo({
            "src/wb.ts": `
        export class Counter {
          inc() { return 1; }
          bump() { return this.inc(); }
        }
      `,
        });
        const { all } = detectCalls(repo);
        const bump = all.find((n) => n.name === "Counter.bump");
        expect(bump?.metadata.resolvedCalls).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Counter.inc", nodeId: "src/wb.ts::Counter.inc" })]));
        deleteFakeRepo(repo);
    });
});
// ─── Overload-aware resolution (same-name candidates in one file) ─────────────
describe("detectCallEdges with overloads", () => {
    // Arity disambiguates same-name functions in one file
    it("routes each call to the overload matching its argument count", () => {
        const repo = createFakeRepo({
            "src/fmt.ts": `
        export function formatValue(v: string) { return v.trim(); }
        export function formatValue(v: string, n: number) { return v.repeat(n); }
        export function caller() {
          formatValue("a");
          formatValue("a", 3);
        }
      `,
        });
        const { edges } = detectCalls(repo);
        const callEdges = edges.filter((e) => e.type === "CALLS" && e.metadata?.calledName === "formatValue");
        const targets = callEdges.map((e) => e.to).sort();
        expect(targets).toEqual([
            "src/fmt.ts::formatValue#1",
            "src/fmt.ts::formatValue#2",
        ]);
        // resolution confidence recorded on the edge
        expect(callEdges.every((e) => e.metadata?.matchedBy === "arity")).toBe(true);
        deleteFakeRepo(repo);
    });
    // Same arity, different param types — literal arg types break the tie
    it("resolves same-arity overloads via argument type tags", () => {
        const repo = createFakeRepo({
            "src/dec.ts": `
        export function decode(input: string, mode: string) { return input; }
        export function decode(input: number, mode: string) { return String(input); }
        export function caller() {
          decode("abc", "utf8");
          decode(42, "utf8");
        }
      `,
        });
        const { edges } = detectCalls(repo);
        const callEdges = edges.filter((e) => e.type === "CALLS" && e.metadata?.calledName === "decode");
        // first call (string literal) → string overload; second (number literal) → number overload
        const stringTargets = callEdges.filter((e) => e.metadata?.matchedBy === "signature").map((e) => e.to).sort();
        expect(stringTargets.length).toBe(2);
        expect(stringTargets[0]).not.toBe(stringTargets[1]);
        deleteFakeRepo(repo);
    });
    // A caller can invoke two overloads of one name — two distinct edges
    it("emits one edge per overload call site, not one per name", () => {
        const repo = createFakeRepo({
            "src/multi.ts": `
        export function send(x: string) { return x; }
        export function send(x: string, y: string) { return x + y; }
        export function client() {
          send("a");
          send("a", "b");
        }
      `,
        });
        const { edges } = detectCalls(repo);
        const callEdges = edges.filter((e) => e.type === "CALLS" && e.metadata?.calledName === "send");
        expect(callEdges.length).toBe(2);
        expect(new Set(callEdges.map((e) => e.to)).size).toBe(2);
        deleteFakeRepo(repo);
    });
    // Spread calls have unknowable arity — must NOT confidently pick an overload
    it("falls back to path proximity for spread calls", () => {
        const repo = createFakeRepo({
            "src/spread.ts": `
        export function combine(a: string) { return a; }
        export function combine(a: string, b: string) { return a + b; }
        export function caller(...args: string[]) {
          return combine(...args);
        }
      `,
        });
        const { edges } = detectCalls(repo);
        const callEdges = edges.filter((e) => e.type === "CALLS" && e.metadata?.calledName === "combine");
        expect(callEdges.length).toBe(1);
        expect(callEdges[0].metadata?.matchedBy).toBe("name");
        deleteFakeRepo(repo);
    });
    // Optional params: a 1-arg call may hit a 2-param overload with optional 2nd
    it("lets optional parameters accept shorter calls via arity fallback", () => {
        const repo = createFakeRepo({
            "src/opt.ts": `
        export function render(template: string, opts?: object) { return template; }
        export function render(template: string, opts: object, mode: string) { return template; }
        export function caller() {
          render("t");
        }
      `,
        });
        const { edges } = detectCalls(repo);
        const callEdges = edges.filter((e) => e.type === "CALLS" && e.metadata?.calledName === "render");
        // 1-arg call: renderStrict requires 3 → excluded; render (optional) → match
        expect(callEdges.length).toBe(1);
        expect(callEdges[0].to).toBe("src/opt.ts::render#2");
        deleteFakeRepo(repo);
    });
    // Rest params accept any extra arguments
    it("lets rest parameters accept longer calls", () => {
        const repo = createFakeRepo({
            "src/rest.ts": `
        export function sum(first: number, ...rest: number[]) { return first; }
        export function pair(a: number, b: number) { return a; }
        export function caller() {
          sum(1, 2, 3, 4);
        }
      `,
        });
        const { edges } = detectCalls(repo);
        const callEdges = edges.filter((e) => e.type === "CALLS" && e.metadata?.calledName === "sum");
        expect(callEdges.length).toBe(1);
        expect(callEdges[0].to).toContain("sum");
        deleteFakeRepo(repo);
    });
    // Legacy behavior preserved when no overload shape exists
    it("still resolves plain single-candidate calls without callSites metadata", () => {
        const repo = createFakeRepo({
            "src/plain.ts": `
        export function helper(x: number) { return x; }
        export function caller() { return helper(1); }
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "src/plain.ts::caller",
            to: "src/plain.ts::helper",
            type: "CALLS",
        }));
        deleteFakeRepo(repo);
    });
    // Class method overloads resolve through dotted names
    it("resolves class method overloads by arity through dotted names", () => {
        const repo = createFakeRepo({
            "src/svc.ts": `
        export class Repo {
          find(id: string) { return id; }
          find(id: string, depth: number) { return id; }
        }
        export function caller() {
          Repo.find("a");
          Repo.find("a", 2);
        }
      `,
        });
        const { edges } = detectCalls(repo);
        const callEdges = edges.filter((e) => e.type === "CALLS" && e.metadata?.calledName === "Repo.find");
        expect(callEdges.map((e) => e.to).sort()).toEqual([
            "src/svc.ts::Repo.find#1",
            "src/svc.ts::Repo.find#2",
        ]);
        deleteFakeRepo(repo);
    });
});
// ─── Module-scope callers (FILE nodes) ────────────────────────────────────────
//
// Calls executed at file load are owned by the FILE node (moduleScope.ts).
// They must produce normal CALLS edges — no new edge type — with
// metadata.scope = "module" so consumers can label them.
describe("detectCallEdges with module-scope callers", () => {
    it("emits FILE -> FUNCTION CALLS from a top-level call", () => {
        const repo = createFakeRepo({
            "lib/startAll.ts": `export function startAll() { return () => {}; }`,
            "main.ts": `
        import { startAll } from "./lib/startAll";
        const cleanup = startAll();
        process.on("SIGTERM", cleanup);
      `,
        });
        const { edges, all } = detectCalls(repo);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "file::main.ts",
            to: "lib/startAll.ts::startAll",
            type: "CALLS",
            metadata: expect.objectContaining({ calledName: "startAll", scope: "module" }),
        }));
        const file = all.find((n) => n.id === "file::main.ts");
        expect(file.metadata.resolvedCalls).toEqual([
            { name: "startAll", nodeId: "lib/startAll.ts::startAll" },
        ]);
        deleteFakeRepo(repo);
    });
    it("resolves module-scope calls through a local import alias", () => {
        const repo = createFakeRepo({
            "lib/startAll.ts": `export function startAll() { return 1; }`,
            "main.ts": `
        import { startAll as boot } from "./lib/startAll";
        boot();
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "file::main.ts",
            to: "lib/startAll.ts::startAll",
            type: "CALLS",
            metadata: expect.objectContaining({ calledName: "startAll" }),
        }));
        deleteFakeRepo(repo);
    });
    it("does not tag function-origin calls with scope=module", () => {
        const repo = createFakeRepo({
            "src/a.ts": `
        export function helper() { return 1; }
        export function caller() { return helper(); }
      `,
        });
        const { edges } = detectCalls(repo);
        const edge = edges.find((e) => e.from === "src/a.ts::caller" && e.to === "src/a.ts::helper");
        expect(edge).toBeDefined();
        expect(edge.metadata?.scope).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("keeps module scope separate from a same-file function call", () => {
        const repo = createFakeRepo({
            "src/boot.ts": `
        export function helper() { return 1; }
        const sentinel = helper();
        export function caller() { return helper(); }
      `,
        });
        const { edges } = detectCalls(repo);
        const fromFile = edges.filter((e) => e.from === "file::src/boot.ts");
        const fromFn = edges.filter((e) => e.from === "src/boot.ts::caller");
        expect(fromFile).toHaveLength(1);
        expect(fromFile[0].to).toBe("src/boot.ts::helper");
        expect(fromFile[0].metadata?.scope).toBe("module");
        expect(fromFn).toHaveLength(1);
        expect(fromFn[0].metadata?.scope).toBeUndefined();
        deleteFakeRepo(repo);
    });
});
// ─── Third-party gate (must be identical to function callers) ────────────────
describe("detectCallEdges — module-scope third-party gate", () => {
    const files = {
        "package.json": JSON.stringify({
            name: "gate-fixture",
            version: "1.0.0",
            dependencies: { express: "^4.0.0" },
        }),
        "main.ts": `
      import express from "express";
      const app = express();
    `,
    };
    it("emits NO third-party node or CALLS edge when the option is absent", () => {
        const repo = createFakeRepo(files);
        const { edges, all } = detectCalls(repo); // no third-party nodes
        expect(all.some((n) => n.id.startsWith("[npm]"))).toBe(false);
        expect(edges.some((e) => e.to.startsWith("[npm]"))).toBe(false);
        // metadata still records the name (not gated)
        const file = all.find((n) => n.id === "file::main.ts");
        expect(file.metadata.calls).toContain("express");
        deleteFakeRepo(repo);
    });
    it("emits FILE -> [npm]/express CALLS when the option is set", () => {
        const repo = createFakeRepo(files);
        const extra = buildThirdPartyNodes(repo, ["express"]);
        const { edges } = detectCalls(repo, extra);
        expect(edges).toContainEqual(expect.objectContaining({
            from: "file::main.ts",
            to: "[npm]/express",
            type: "CALLS",
            metadata: expect.objectContaining({ isThirdParty: true, scope: "module" }),
        }));
        deleteFakeRepo(repo);
    });
});

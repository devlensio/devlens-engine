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

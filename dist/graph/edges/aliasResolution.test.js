// Alias / re-export resolution — the class of bug where the name at the call
// site never exists as a node.
//
// Covers (see docs/ENGINE_PIPELINE.html → "Resolving a call"):
//   1  plain import alias                    (`import { a as b }`)
//   2  re-export alias                       (`export { a as b } from`)
//   3  export * barrel + alias
//   4  rename on both hops
//   5  same exported name in two modules     (module-scoped, not closestByPath)
//   6  default export
//   7  namespace import member
//   8  member access through a re-exported class
//   9  overload group exported under one name (overload-suffixed ids)
//   10 deep chain (20 hops) — one edge, provenance chain recorded
//   11 re-export cycle                       (no hang, no throw)
//   12 unresolvable module                   (tier-3 fallback, no throw)
//   13 module-scope (FILE) caller through a re-export
//   14 third-party resolution untouched
import fs from "fs";
import path from "path";
import os from "os";
import { describe, it, expect } from "bun:test";
import { parseRepo } from "../../parser/index.js";
import { buildLookupMaps } from "../buildLookup.js";
import { detectImportEdges } from "./importEdges.js";
import { detectCallEdges } from "./callEdges.js";
import { buildThirdPartyNodes } from "../thirdPartyLibs.js";
function createRepo(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-alias-test-"));
    for (const [rel, content] of Object.entries(files)) {
        const full = path.join(dir, rel);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content);
    }
    return dir;
}
function dropRepo(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}
/** Mirrors the pipeline: parse → lookup maps → import edges → call edges. */
function detect(repoPath, extraNodes = []) {
    const { nodes } = parseRepo(repoPath);
    const all = [...nodes, ...extraNodes];
    const lookup = buildLookupMaps(all);
    detectImportEdges(lookup, repoPath);
    const result = detectCallEdges(all, lookup);
    return { ...result, all, lookup };
}
const localCalls = (edges) => edges.filter((e) => (e.type === "CALLS" || e.type === "USES") && !e.metadata?.isThirdParty);
const findCall = (edges, from, to) => edges.find((e) => e.from === from && (!to || e.to === to));
const TSCONFIG = JSON.stringify({
    compilerOptions: {
        target: "ES2020",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "~/*": ["./src/*"] },
        strict: true,
    },
    include: ["src"],
});
describe("alias resolution — one hop", () => {
    it("resolves a plain import alias (`import { data as httpResponse }`)", () => {
        const repo = createRepo({
            "src/http.ts": `export function data(body: unknown) { return body; }`,
            "src/route.ts": `import { data as httpResponse } from "./http";
export function loader() { return httpResponse({ ok: true }); }`,
        });
        const { edges } = detect(repo);
        const edge = findCall(edges, "src/route.ts::loader", "src/http.ts::data");
        expect(edge).toBeDefined();
        expect(edge?.metadata?.calledName).toBe("httpResponse");
        expect(edge?.metadata?.resolvedName).toBe("data");
        expect(edge?.metadata?.aliased).toBe(true);
        // no re-export hop → no chain noise on the edge
        expect(edge?.metadata?.aliasChain).toBeUndefined();
        dropRepo(repo);
    });
    it("resolves a re-export alias (`export { data as httpResponse } from`)", () => {
        const repo = createRepo({
            "tsconfig.json": TSCONFIG,
            "src/http.ts": `export function data(body: unknown) { return body; }`,
            "src/index.ts": `export { data as httpResponse } from "./http";`,
            "src/route.ts": `import { httpResponse } from "~/index";
export function loader() { return httpResponse({ ok: true }); }`,
        });
        const { edges } = detect(repo);
        const edge = findCall(edges, "src/route.ts::loader", "src/http.ts::data");
        expect(edge).toBeDefined();
        expect(edge?.metadata?.calledName).toBe("httpResponse");
        expect(edge?.metadata?.resolvedName).toBe("data");
        expect(edge?.metadata?.aliased).toBe(true);
        expect(edge?.metadata?.aliasChain).toEqual([
            "src/index.ts::httpResponse",
            "src/http.ts::data",
        ]);
        dropRepo(repo);
    });
    it("follows an `export * from` barrel that also renames", () => {
        const repo = createRepo({
            "src/inner.ts": `export function starOriginal() { return 7; }`,
            "src/mid.ts": `export * from "./inner";`,
            "src/outer.ts": `import { starOriginal as starAlias } from "./mid";
export function useStar() { return starAlias(); }`,
        });
        const { edges } = detect(repo);
        expect(findCall(edges, "src/outer.ts::useStar", "src/inner.ts::starOriginal")).toBeDefined();
        dropRepo(repo);
    });
    it("resolves a rename on both hops (import alias of an export alias)", () => {
        const repo = createRepo({
            "src/impl.ts": `export function realThing(x: number) { return x; }`,
            "src/mid.ts": `export { realThing as publicName } from "./impl";`,
            "src/use.ts": `import { publicName as local } from "./mid";
export function run() { return local(1); }`,
        });
        const { edges } = detect(repo);
        const edge = findCall(edges, "src/use.ts::run", "src/impl.ts::realThing");
        expect(edge).toBeDefined();
        expect(edge?.metadata?.resolvedName).toBe("realThing");
        dropRepo(repo);
    });
    it("resolves an import followed by a LOCAL re-export (`export { data as httpResponse }`)", () => {
        const repo = createRepo({
            "src/http.ts": `export function data() { return 1; }`,
            "src/index.ts": `import { data } from "./http";
export { data as httpResponse };`,
            "src/use.ts": `import { httpResponse } from "./index";
export function run() { return httpResponse(); }`,
        });
        const { edges } = detect(repo);
        const edge = findCall(edges, "src/use.ts::run", "src/http.ts::data");
        expect(edge).toBeDefined();
        expect(edge?.metadata?.resolvedName).toBe("data");
        // the local hop is recorded too: index.ts::httpResponse → index.ts::data
        expect(edge?.metadata?.aliasChain).toEqual([
            "src/index.ts::httpResponse",
            "src/index.ts::data",
            "src/http.ts::data",
        ]);
        dropRepo(repo);
    });
    it("follows a default export through a re-export", () => {
        const repo = createRepo({
            "src/client.ts": `export default function httpClient() { return 1; }`,
            "src/index.ts": `export { default as makeClient } from "./client";`,
            "src/use.ts": `import { makeClient } from "./index";
export function run() { return makeClient(); }`,
        });
        const { edges } = detect(repo);
        expect(findCall(edges, "src/use.ts::run", "src/client.ts::httpClient")).toBeDefined();
        dropRepo(repo);
    });
    it("resolves a member call through a namespace import", () => {
        const repo = createRepo({
            "src/tools.ts": `export function normalize(x: number) { return x; }`,
            "src/use.ts": `import * as Tools from "./tools";
export function run() { return Tools.normalize(1); }`,
        });
        const { edges } = detect(repo);
        expect(findCall(edges, "src/use.ts::run", "src/tools.ts::normalize")).toBeDefined();
        dropRepo(repo);
    });
});
describe("alias resolution — module scoping (no name guessing)", () => {
    it("sends each importer to its OWN module when two files export the same name", () => {
        const repo = createRepo({
            "a/http.ts": `export function data() { return "a"; }`,
            "b/http.ts": `export function data() { return "b"; }`,
            "a/index.ts": `export { data } from "./http";`,
            "b/index.ts": `export { data } from "./http";`,
            // a shallow path trick: the *nearer* file to use.ts is b/http.ts
            "a/use.ts": `import { data } from "./index";
export function readA() { return data(); }`,
            "b/use.ts": `import { data } from "./index";
export function readB() { return data(); }`,
        });
        const { edges } = detect(repo);
        expect(findCall(edges, "a/use.ts::readA", "a/http.ts::data")).toBeDefined();
        expect(findCall(edges, "b/use.ts::readB", "b/http.ts::data")).toBeDefined();
        // and the wrong cross-wire must not exist
        expect(findCall(edges, "a/use.ts::readA", "b/http.ts::data")).toBeUndefined();
        expect(findCall(edges, "b/use.ts::readB", "a/http.ts::data")).toBeUndefined();
        dropRepo(repo);
    });
    it("resolves a method on a re-exported class (dotted member id)", () => {
        const repo = createRepo({
            "src/services.ts": `export class UserService {
  static get(id: string) { return id; }
}`,
            "src/index.ts": `export { UserService as US } from "./services";`,
            "src/use.ts": `import { US } from "./index";
export function load(id: string) { return US.get(id); }`,
        });
        const { edges } = detect(repo);
        const edge = findCall(edges, "src/use.ts::load", "src/services.ts::UserService.get");
        expect(edge).toBeDefined();
        expect(edge?.metadata?.calledName).toBe("US.get");
        expect(edge?.metadata?.resolvedName).toBe("UserService.get");
        dropRepo(repo);
    });
    it("never invents an edge to the container when the member does not exist", () => {
        const repo = createRepo({
            "src/services.ts": `export class UserService { static get(id: string) { return id; } }`,
            "src/index.ts": `export { UserService } from "./services";`,
            "src/use.ts": `import { UserService } from "./index";
export function load() { return UserService.missing(); }`,
        });
        const { edges } = detect(repo);
        expect(edges.find((e) => e.from === "src/use.ts::load")).toBeUndefined();
        dropRepo(repo);
    });
});
describe("alias resolution — overloads keep their discriminated ids", () => {
    it("maps an exported overload group to the right `#arity` sibling", () => {
        const repo = createRepo({
            "src/fmt.ts": `export function fmt(x: string) { return x; }
export function fmt(x: string, y: number) { return x + y; }`,
            "src/index.ts": `export { fmt as format } from "./fmt";`,
            "src/use.ts": `import { format } from "./index";
export function one() { return format("a"); }
export function two() { return format("a", 1); }`,
        });
        const { edges, all } = detect(repo);
        const ids = all.filter((n) => n.name === "fmt").map((n) => n.id).sort();
        // the overload scheme owns id generation — the binding table must read it
        expect(ids).toEqual(["src/fmt.ts::fmt#1", "src/fmt.ts::fmt#2"]);
        const one = edges.find((e) => e.from === "src/use.ts::one");
        const two = edges.find((e) => e.from === "src/use.ts::two");
        expect(one?.to).toBe("src/fmt.ts::fmt#1");
        expect(two?.to).toBe("src/fmt.ts::fmt#2");
        dropRepo(repo);
    });
});
describe("alias resolution — deep chains", () => {
    function buildChainRepo(hops) {
        const files = {
            "src/chain/c00.ts": `export function realOriginal(x: number) { return x + 1; }`,
        };
        for (let i = 1; i <= hops; i++) {
            const prev = `c${String(i - 1).padStart(2, "0")}`;
            const cur = `c${String(i).padStart(2, "0")}`;
            const prevName = i === 1 ? "realOriginal" : `alias${String(i - 1).padStart(2, "0")}`;
            files[`src/chain/${cur}.ts`] = `export { ${prevName} as alias${String(i).padStart(2, "0")} } from "./${prev}";`;
        }
        const leaf = `c${String(hops).padStart(2, "0")}`;
        files["src/leaf.ts"] = `import { alias${String(hops).padStart(2, "0")} } from "./chain/${leaf}";
export function useLeaf() { return alias${String(hops).padStart(2, "0")}(41); }`;
        return createRepo(files);
    }
    it("collapses 20 re-export hops into ONE edge to the origin", () => {
        const repo = buildChainRepo(20);
        const { edges } = detect(repo);
        const calls = localCalls(edges).filter((e) => e.from === "src/leaf.ts::useLeaf");
        expect(calls).toHaveLength(1);
        expect(calls[0].to).toBe("src/chain/c00.ts::realOriginal");
        // provenance: every hop is recorded, in order, ending at the origin
        const chain = calls[0].metadata?.aliasChain;
        expect(chain[0]).toBe("src/chain/c20.ts::alias20");
        expect(chain[chain.length - 1]).toBe("src/chain/c00.ts::realOriginal");
        expect(chain).toHaveLength(21);
        dropRepo(repo);
    });
    it("holds for a 3-hop chain too (no depth-specific code path)", () => {
        const repo = buildChainRepo(3);
        const { edges } = detect(repo);
        const calls = localCalls(edges).filter((e) => e.from === "src/leaf.ts::useLeaf");
        expect(calls).toHaveLength(1);
        expect(calls[0].to).toBe("src/chain/c00.ts::realOriginal");
        expect((calls[0].metadata?.aliasChain).length).toBe(4);
        dropRepo(repo);
    });
});
describe("alias resolution — robustness", () => {
    it("survives a re-export cycle without hanging or throwing", () => {
        const repo = createRepo({
            "src/a.ts": `export { aliasB as aliasA } from "./b";`,
            "src/b.ts": `export { aliasA as aliasB } from "./a";`,
            "src/use.ts": `import { aliasA } from "./a";
export function run() { return aliasA(); }`,
        });
        const { edges } = detect(repo);
        // no declaration exists anywhere → no edge, but the run completes
        expect(edges.find((e) => e.from === "src/use.ts::run")).toBeUndefined();
        dropRepo(repo);
    });
    it("falls back silently when the module cannot be resolved", () => {
        const repo = createRepo({
            "src/use.ts": `import { missing } from "./nope";
export function run() { return missing(); }`,
        });
        const { edges } = detect(repo);
        expect(edges.find((e) => e.from === "src/use.ts::run")).toBeUndefined();
        dropRepo(repo);
    });
    it("keeps legacy name-based resolution when there is no import at all", () => {
        const repo = createRepo({
            "src/a.ts": `export function helper() { return 1; }
export function caller() { return helper(); }`,
        });
        const { edges } = detect(repo);
        expect(findCall(edges, "src/a.ts::caller", "src/a.ts::helper")).toBeDefined();
        dropRepo(repo);
    });
    it("resolves module-scope (FILE) callers through a re-export", () => {
        const repo = createRepo({
            "src/http.ts": `export function data() { return 1; }`,
            "src/index.ts": `export { data as httpResponse } from "./http";`,
            "src/main.ts": `import { httpResponse } from "./index";
const ready = httpResponse();`,
        });
        const { edges } = detect(repo);
        const edge = findCall(edges, "file::src/main.ts", "src/http.ts::data");
        expect(edge).toBeDefined();
        expect(edge?.metadata?.scope).toBe("module");
        dropRepo(repo);
    });
    it("leaves third-party resolution untouched", () => {
        const repo = createRepo({
            "src/api.ts": `import axios from "axios";
export function fetchUsers() { return axios.get("/users"); }`,
        });
        const thirdParty = buildThirdPartyNodes(repo, ["axios"]);
        const { edges } = detect(repo, thirdParty);
        const edge = edges.find((e) => e.from === "src/api.ts::fetchUsers" && e.metadata?.isThirdParty);
        expect(edge?.to).toBe("[npm]/axios::get");
        dropRepo(repo);
    });
    it("records the binding tables the fix depends on", () => {
        const repo = createRepo({
            "src/http.ts": `export function data() { return 1; }`,
            "src/index.ts": `export { data as httpResponse } from "./http";`,
            "src/use.ts": `import { httpResponse } from "./index";
export function run() { return httpResponse(); }`,
        });
        const { lookup } = detect(repo);
        expect(lookup.importTargets.get("src/use.ts")?.get("httpResponse")).toEqual({
            targetFile: "src/index.ts",
            importedName: "httpResponse",
            kind: "named",
        });
        expect(lookup.exportBindings.get("src/index.ts")?.get("httpResponse")).toEqual([
            "src/http.ts::data",
        ]);
        expect(lookup.reexportLinks.get("src/index.ts")?.get("httpResponse")).toEqual({
            targetFile: "src/http.ts",
            targetName: "data",
        });
        dropRepo(repo);
    });
});

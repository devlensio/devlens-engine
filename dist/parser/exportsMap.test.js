import fs from "fs";
import os from "os";
import path from "path";
import { parseRepo } from "./index.js";
import { buildLookupMaps } from "../graph/buildLookup.js";
import { detectImportEdges } from "../graph/edges/importEdges.js";
import { detectCallEdges } from "../graph/edges/callEdges.js";
function createFakeRepo(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-exports-map-test-"));
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
describe("exports map (cross-repo linkage)", () => {
    it("returns undefined when the repo has no package.json", () => {
        const repo = createFakeRepo({
            "src/a.ts": `export function alpha() { return 1; }\n`,
        });
        const result = parseRepo(repo);
        expect(result.exports).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("maps direct exports to single-element arrays of proper nodeIds", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export { alpha } from './a';\n`,
            "src/a.ts": `export function alpha() { return 1; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports).toBeDefined();
        expect(exports.exports["."]["alpha"]).toEqual(["src/a.ts::alpha"]);
        expect(exports.ambiguousNames).toEqual({});
        deleteFakeRepo(repo);
    });
    it("flattens chained re-exports to the final definition node", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export { beta } from './helpers';\n`,
            "src/helpers.ts": `export { beta } from './dateUtils';\n`,
            "src/dateUtils.ts": `export function beta(d: string) { return d; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["beta"]).toEqual(["src/dateUtils.ts::beta"]);
        deleteFakeRepo(repo);
    });
    it("keys the map by the name the importer sees when aliases are involved", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export { formatDate as fmtDate } from './dateUtils';\n`,
            "src/dateUtils.ts": `export function formatDate(d: string) { return d; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["fmtDate"]).toEqual(["src/dateUtils.ts::formatDate"]);
        expect(exports.exports["."]["formatDate"]).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("handles the name-swap case via bindings, never by string matching", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `
        export { formatDate as fmtDate } from './dateUtils';
        export { fmtDate as formatDate } from './misc';
      `,
            "src/dateUtils.ts": `export function formatDate(d: string) { return d; }\n`,
            "src/misc.ts": `export function fmtDate(x: number) { return x; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["fmtDate"]).toEqual(["src/dateUtils.ts::formatDate"]);
        expect(exports.exports["."]["formatDate"]).toEqual(["src/misc.ts::fmtDate"]);
        expect(exports.ambiguousNames).toEqual({});
        deleteFakeRepo(repo);
    });
    it("emits one map key per package.json exports subpath", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({
                name: "fakepkg",
                exports: {
                    ".": "./src/index.ts",
                    "./server": "./src/server/index.ts",
                },
            }),
            "src/index.ts": `export { alpha } from './a';\n`,
            "src/a.ts": `export function alpha() { return 1; }\n`,
            "src/server/index.ts": `export { serve } from './serve';\n`,
            "src/server/serve.ts": `export function serve() { return 2; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["alpha"]).toEqual(["src/a.ts::alpha"]);
        expect(exports.exports["./server"]["serve"]).toEqual(["src/server/serve.ts::serve"]);
        deleteFakeRepo(repo);
    });
    it("resolves dist entry targets back to src (same coordinate system as nodes)", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({
                name: "fakepkg",
                exports: { ".": { import: "./dist/index.js", types: "./dist/index.d.ts" } },
            }),
            "src/index.ts": `export { alpha } from './a';\n`,
            "src/a.ts": `export function alpha() { return 1; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["alpha"]).toEqual(["src/a.ts::alpha"]);
        deleteFakeRepo(repo);
    });
    it("falls back to main/module when the exports field is absent", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./dist/index.js" }),
            "src/index.ts": `export { alpha } from './a';\n`,
            "src/a.ts": `export function alpha() { return 1; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["alpha"]).toEqual(["src/a.ts::alpha"]);
        deleteFakeRepo(repo);
    });
    it("emits distinct #arity suffixed nodeIds for same-name different-arity exports", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export { formatValue } from './arity';\n`,
            "src/arity.ts": `
        export function formatValue(v: string) { return v.trim(); }
        export function formatValue(v: string, n: number) { return v.repeat(n); }
      `,
        });
        const { exports } = parseRepo(repo);
        const ids = exports.exports["."]["formatValue"].sort();
        expect(ids).toEqual(["src/arity.ts::formatValue#1", "src/arity.ts::formatValue#2"]);
        expect(exports.ambiguousNames["."]).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("emits distinct sig8-suffixed nodeIds for same-arity different-type exports", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export { decode } from './types';\n`,
            "src/types.ts": `
        export function decode(input: string, mode: string) { return input; }
        export function decode(input: number, mode: string) { return String(input); }
      `,
        });
        const { exports } = parseRepo(repo);
        const ids = exports.exports["."]["decode"].sort();
        expect(ids.length).toBe(2);
        expect(ids[0]).toMatch(/^src\/types\.ts::decode#2#[0-9a-f]{8}$/);
        expect(ids[1]).toMatch(/^src\/types\.ts::decode#2#[0-9a-f]{8}$/);
        expect(ids[0]).not.toBe(ids[1]);
        deleteFakeRepo(repo);
    });
    it("excludes star re-export conflicts per the JS module spec (name absent, not guessed)", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export * from './a';\nexport * from './b';\n`,
            "src/a.ts": `export function clash() { return 1; }\nexport function onlyA() { return 2; }\n`,
            "src/b.ts": `export function clash() { return 3; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["clash"]).toBeUndefined();
        expect(exports.exports["."]["onlyA"]).toEqual(["src/a.ts::onlyA"]);
        expect(exports.ambiguousNames["."]).toEqual(["clash"]);
        deleteFakeRepo(repo);
    });
    it("resolves star re-exports like named ones", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export * from './barrel';\n`,
            "src/barrel.ts": `export * from './a';\n`,
            "src/a.ts": `export function alpha() { return 1; }\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["alpha"]).toEqual(["src/a.ts::alpha"]);
        deleteFakeRepo(repo);
    });
    it("maps named default exports and omits anonymous ones", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `
        export { default as named } from './named';
        export { default as anon } from './anon';
      `,
            "src/named.ts": `export default function loader() { return 1; }\n`,
            "src/anon.ts": `export default () => 2;\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["named"]).toEqual(["src/named.ts::loader"]);
        expect(exports.exports["."]["anon"]).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("omits exports that have no node representation (consts, types, interfaces)", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export * from './mixed';\n`,
            "src/mixed.ts": `
        export const config = { a: 1 };
        export type Maybe = string | null;
        export interface Opts { a: number }
        export function run(o: Opts) { return o.a; }
      `,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["run"]).toEqual(["src/mixed.ts::run"]);
        expect(exports.exports["."]["config"]).toBeUndefined();
        expect(exports.exports["."]["Maybe"]).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("survives re-export cycles without hanging and omits the undefined name", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export { gone } from './a';\n`,
            "src/a.ts": `export { gone } from './b';\n`,
            "src/b.ts": `export { gone } from './a';\n`,
        });
        const { exports } = parseRepo(repo);
        const gone = exports ? exports.exports["."]?.["gone"] : undefined;
        expect(gone).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("maps exported classes and exported const arrow functions to their nodes", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export * from './things';\n`,
            "src/things.ts": `
        export class Widget { render() { return 1; } }
        export const handler = () => 2;
      `,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["Widget"]).toEqual(["src/things.ts::Widget"]);
        expect(exports.exports["."]["handler"]).toEqual(["src/things.ts::handler"]);
        deleteFakeRepo(repo);
    });
    it("never references a nodeId that is absent from the nodes array", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export * from './a';\nexport { beta } from './b';\n`,
            "src/a.ts": `export function alpha() { return 1; }\n`,
            "src/b.ts": `export function beta() { return 2; }\n`,
        });
        const result = parseRepo(repo);
        const nodeIds = new Set(result.nodes.map((n) => n.id));
        for (const perPath of Object.values(result.exports.exports)) {
            for (const ids of Object.values(perPath)) {
                for (const id of ids)
                    expect(nodeIds.has(id)).toBe(true);
            }
        }
        deleteFakeRepo(repo);
    });
    it("resolves one condition per subpath: import beats require and types", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({
                name: "fakepkg",
                exports: {
                    ".": { import: "./src/index.ts", require: "./src/legacy.ts", types: "./src/index.d.ts" },
                    "./legacy": { require: "./src/legacy.ts" },
                    "./types-only": { types: "./src/index.d.ts" },
                },
            }),
            "src/index.ts": `export { alpha } from './a';\n`,
            "src/a.ts": `export function alpha() { return 1; }\n`,
            "src/legacy.ts": `export function alpha() { return 2; }\n`,
            "src/index.d.ts": `export declare function alpha(): number;\n`,
        });
        const { exports } = parseRepo(repo);
        expect(exports.exports["."]["alpha"]).toEqual(["src/a.ts::alpha"]);
        expect(exports.exports["./legacy"]["alpha"]).toEqual(["src/legacy.ts::alpha"]);
        expect(exports.exports["./types-only"]).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("skips unparseable files and still builds the map from valid ones", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export { alpha } from './a';\n`,
            "src/a.ts": `export function alpha() { return 1; }\n`,
            "src/broken.ts": `export function broken( {\n`,
        });
        const result = parseRepo(repo);
        expect(result.exports).toBeDefined();
        expect(result.exports.exports["."]["alpha"]).toEqual(["src/a.ts::alpha"]);
        expect(result.exports.exports["."]["broken"]).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("call-site narrowing picks within an exported overload group (map ids = edge targets)", () => {
        const repo = createFakeRepo({
            "package.json": JSON.stringify({ name: "fakepkg", main: "./src/index.ts" }),
            "src/index.ts": `export { formatValue } from './overloads';\n`,
            "src/overloads.ts": `
        export function formatValue(v: string) { return v.trim(); }
        export function formatValue(v: string, n: number) { return v.repeat(n); }
      `,
            "src/caller.ts": `
        import { formatValue } from './index';
        export function useOne() { return formatValue("x"); }
        export function useTwo() { return formatValue("x", 3); }
      `,
        });
        const parsed = parseRepo(repo);
        const lookup = buildLookupMaps(parsed.nodes);
        detectImportEdges(lookup, repo);
        const callResult = detectCallEdges(parsed.nodes, lookup);
        const { exports } = parsed;
        const group = exports.exports["."]["formatValue"];
        expect(group.length).toBe(2);
        const targets = callResult.edges
            .filter((e) => e.type === "CALLS" && e.from === "src/caller.ts::useOne")
            .map((e) => e.to);
        expect(targets.length).toBe(1);
        expect(group).toContain(targets[0]);
        const targetsTwo = callResult.edges
            .filter((e) => e.type === "CALLS" && e.from === "src/caller.ts::useTwo")
            .map((e) => e.to);
        expect(targetsTwo.length).toBe(1);
        expect(group).toContain(targetsTwo[0]);
        expect(targets[0]).not.toBe(targetsTwo[0]);
        // every narrowed target is a real node the map points at — no phantom ids
        const nodeIds = new Set(parsed.nodes.map((n) => n.id));
        for (const t of [...targets, ...targetsTwo])
            expect(nodeIds.has(t)).toBe(true);
        deleteFakeRepo(repo);
    });
});

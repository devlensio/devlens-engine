import fs from "fs";
import path from "path";
import os from "os";
import { Project } from "ts-morph";
import { extractModuleScopeCalls } from "./extractors/moduleScope.js";
import { parseRepo } from "./index.js";
// ─── Helpers ──────────────────────────────────────────────────────────────────
function parse(source) {
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile("main.ts", source);
    return extractModuleScopeCalls(file);
}
function createFakeRepo(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-module-scope-test-"));
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
// ─── Scope rule ───────────────────────────────────────────────────────────────
describe("extractModuleScopeCalls — scope rule", () => {
    it("collects a call in a top-level variable initializer", () => {
        const data = parse(`
      import { startAll } from "./lib/startAll";
      const cleanup = startAll();
    `);
        expect(data.calls).toEqual(["startAll"]);
        expect(data.callSites).toEqual([{ name: "startAll", argCount: 0, argTypes: [] }]);
    });
    it("collects calls inside a top-level if block", () => {
        const data = parse(`
      if (process.env.NODE_ENV === "production") {
        startAll();
      }
    `);
        expect(data.calls).toEqual(["startAll"]);
    });
    it("collects exported top-level initializers", () => {
        const data = parse(`export const app = createApp();`);
        expect(data.calls).toEqual(["createApp"]);
    });
    it("does NOT collect calls inside a function body", () => {
        const data = parse(`
      function boot() {
        startAll();
      }
    `);
        expect(data.calls).toEqual([]);
    });
    it("does NOT collect calls inside an arrow-function initializer", () => {
        const data = parse(`const boot = () => startAll();`);
        expect(data.calls).toEqual([]);
    });
    it("does NOT collect calls inside a class method", () => {
        const data = parse(`
      class Boot {
        run() { startAll(); }
      }
    `);
        expect(data.calls).toEqual([]);
    });
    it("does NOT collect calls inside a class field initializer", () => {
        const data = parse(`
      class Boot {
        cleanup = startAll();
      }
    `);
        expect(data.calls).toEqual([]);
    });
    it("does NOT collect calls inside a class static block", () => {
        const data = parse(`
      class Boot {
        static { startAll(); }
      }
    `);
        expect(data.calls).toEqual([]);
    });
    it("does NOT collect an IIFE body (the IIFE is a function scope)", () => {
        const data = parse(`
      (async () => { startAll(); })();
    `);
        expect(data.calls).toEqual([]);
    });
    it("does NOT collect dynamic import()", () => {
        const data = parse(`const mod = await import("./lib/startAll");`);
        expect(data.calls).toEqual([]);
    });
    it("returns empty data for a file with only declarations", () => {
        const data = parse(`export function a() {} export class B {}`);
        expect(data.calls).toEqual([]);
        expect(data.callSites).toEqual([]);
    });
});
// ─── Builtin noise (same rule as function bodies) ─────────────────────────────
describe("extractModuleScopeCalls — builtin filtering", () => {
    it("drops console.* and Math.* at module scope", () => {
        const data = parse(`
      console.log("booting");
      const n = Math.min(1, 2);
      startAll();
    `);
        expect(data.calls).toEqual(["startAll"]);
    });
    it("drops builtin member calls but keeps user calls with the same shape", () => {
        const data = parse(`
      Object.keys({});
      JSON.stringify({});
      app.listen(3000);
    `);
        expect(data.calls).toEqual(["app.listen"]);
    });
    it("keeps use* names in hookCalls but not in calls (hook rule)", () => {
        const data = parse(`
      const theme = useTheme();
      startAll();
    `);
        expect(data.calls).toEqual(["startAll"]);
        expect(data.hookCalls).toEqual(["useTheme"]);
    });
    it("captures fetch at module scope as an api call", () => {
        const data = parse(`const cfg = fetch("/config");`);
        expect(data.apiCalls).toEqual(['fetch("/config")']);
    });
});
// ─── parseRepo wiring ─────────────────────────────────────────────────────────
describe("parseRepo — module-scope metadata on FILE nodes", () => {
    it("attaches calls/callSites to the FILE node", () => {
        const repo = createFakeRepo({
            "lib/startAll.ts": `export function startAll() { return () => {}; }`,
            "main.ts": `
        import { startAll } from "./lib/startAll";
        const cleanup = startAll();
        process.on("SIGTERM", cleanup);
      `,
        });
        const { nodes } = parseRepo(repo);
        const file = nodes.find((n) => n.id === "file::main.ts");
        expect(file.type).toBe("FILE");
        expect(file.metadata.calls).toEqual(["startAll", "process.on"]);
        expect(file.metadata.callSites).toEqual([
            { name: "startAll", argCount: 0, argTypes: [] },
            { name: "process.on", argCount: 2, argTypes: ["string", "unknown"] },
        ]);
        deleteFakeRepo(repo);
    });
    it("does not attach module-scope keys to files with no top-level calls", () => {
        const repo = createFakeRepo({
            "lib/startAll.ts": `export function startAll() { return 1; }`,
        });
        const { nodes } = parseRepo(repo);
        const file = nodes.find((n) => n.id === "file::lib/startAll.ts");
        expect(file.metadata.calls).toBeUndefined();
        expect(file.metadata.callSites).toBeUndefined();
        deleteFakeRepo(repo);
    });
    it("does not attach module-scope facts to TEST file nodes", () => {
        const repo = createFakeRepo({
            "main.test.ts": `
        import { startAll } from "./lib/startAll";
        const cleanup = startAll();
      `,
        });
        const { nodes } = parseRepo(repo);
        const file = nodes.find((n) => n.id === "file::main.test.ts");
        expect(file.type).toBe("TEST");
        expect(file.metadata.calls).toBeUndefined();
        deleteFakeRepo(repo);
    });
});

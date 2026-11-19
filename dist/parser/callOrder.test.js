import fs from "fs";
import path from "path";
import os from "os";
import { parseRepo } from "./index.js";
// callOrder/v1 conformance, TypeScript/JavaScript. docs/CALL_ORDER.md §6.
function createFakeRepo(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-callorder-ts-"));
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
function nodeOf(nodes, name) {
    const found = nodes.find((n) => n.name === name);
    if (!found)
        throw new Error(`node not found: ${name}`);
    return found;
}
function sitesOf(nodes, name) {
    return nodeOf(nodes, name).metadata.callSites ?? [];
}
function orderOf(nodes, nodeName, callName) {
    return sitesOf(nodes, nodeName).find((s) => s.name === callName)?.order;
}
function parseOne(source, fileName = "main.ts") {
    const repo = createFakeRepo({ [fileName]: source });
    const result = parseRepo(repo);
    deleteFakeRepo(repo);
    return result.nodes;
}
function parseTsx(source) {
    return parseOne(source, "main.tsx");
}
describe("callOrder — ordering basics", () => {
    it("numbers sequential calls in source order", () => {
        const nodes = parseOne(`
      function a() {}
      function b() {}
      function run() { a(); b(); a(); }
    `);
        expect(sitesOf(nodes, "run").map((s) => [s.name, s.order])).toEqual([
            ["a", 1], ["b", 2], ["a", 3],
        ]);
    });
    it("keeps one record per occurrence instead of collapsing identical shapes", () => {
        const nodes = parseOne(`
      function f() {}
      function run() { f(); f(); f(); }
    `);
        const sites = sitesOf(nodes, "run");
        expect(sites).toHaveLength(3);
        expect(sites.map((s) => s.order)).toEqual([1, 2, 3]);
    });
    it("keeps same-name calls with different arity apart", () => {
        const nodes = parseOne(`
      function f(a?: number, b?: number) {}
      function run() { f(1); f(1, 2); }
    `);
        expect(sitesOf(nodes, "run").map((s) => [s.argCount, s.order])).toEqual([[1, 1], [2, 2]]);
    });
    it("links a nested call to its enclosing call", () => {
        const nodes = parseOne(`
      function foo(x: any) {}
      function bar() { return 1; }
      function run() { foo(bar()); }
    `);
        const sites = sitesOf(nodes, "run");
        const foo = sites.find((s) => s.name === "foo");
        const bar = sites.find((s) => s.name === "bar");
        expect(foo.order).toBe(1);
        expect(bar.order).toBe(2);
        expect(bar.nested).toBe(foo.order);
    });
    it("chains nested through three levels", () => {
        const nodes = parseOne(`
      function a(x: any) {}
      function b(x: any) {}
      function c() { return 1; }
      function run() { a(b(c())); }
    `);
        const sites = sitesOf(nodes, "run");
        expect(sites.map((s) => s.name)).toEqual(["a", "b", "c"]);
        expect(sites.map((s) => s.order)).toEqual([1, 2, 3]);
        expect(sites[1].nested).toBe(1);
        expect(sites[2].nested).toBe(2);
    });
    it("distinguishes two calls on one line by column", () => {
        const nodes = parseOne(`
      function f() {}
      function run() { f(); f(); }
    `);
        const sites = sitesOf(nodes, "run");
        expect(sites).toHaveLength(2);
        expect(sites[0].line).toBe(sites[1].line);
        expect(sites[0].col).toBeLessThan(sites[1].col);
    });
    it("orders multi-line arguments by source position", () => {
        const nodes = parseOne(`
      function outer(x: any) {}
      function first() { return 1; }
      function second() { return 2; }
      function run() {
        outer(
          first(),
          second()
        );
      }
    `);
        expect(sitesOf(nodes, "run").map((s) => [s.name, s.order])).toEqual([
            ["outer", 1], ["first", 2], ["second", 3],
        ]);
    });
    it("records calls in branches and loops without reordering them", () => {
        const nodes = parseOne(`
      function a() {}
      function b() {}
      function c() {}
      function run(flag: boolean) {
        if (flag) { a(); } else { b(); }
        for (let i = 0; i < 3; i++) { c(); }
      }
    `);
        expect(sitesOf(nodes, "run").map((s) => [s.name, s.order])).toEqual([
            ["a", 1], ["b", 2], ["c", 3],
        ]);
    });
    it("returns an empty list for a node with no calls", () => {
        const nodes = parseOne(`function run() { return 1; }`);
        expect(sitesOf(nodes, "run")).toEqual([]);
    });
    it("records a self-recursive call", () => {
        const nodes = parseOne(`function run() { run(); }`);
        expect(sitesOf(nodes, "run").map((s) => [s.name, s.order])).toEqual([["run", 1]]);
    });
    it("records a call in a default parameter as inline", () => {
        const nodes = parseOne(`
      function g() { return 1; }
      function run(x = g()) { return x; }
    `);
        const sites = sitesOf(nodes, "run");
        expect(sites.map((s) => [s.name, s.scope])).toEqual([["g", "inline"]]);
    });
    it("does not record the IIFE wrapper but records its body", () => {
        const nodes = parseOne(`
      function inner() {}
      function run() { (function () { inner(); })(); }
    `);
        expect(sitesOf(nodes, "run").map((s) => s.name)).toEqual(["inner"]);
    });
    it("records an optional-chain call", () => {
        const nodes = parseOne(`
      function run(obj: any) { obj?.save(); }
    `);
        expect(sitesOf(nodes, "run").map((s) => s.name)).toEqual(["obj?.save"]);
    });
    it("does not let builtins consume an ordinal", () => {
        const nodes = parseOne(`
      function a() {}
      function run() { console.log("x"); a(); }
    `);
        expect(sitesOf(nodes, "run").map((s) => [s.name, s.order])).toEqual([["a", 1]]);
    });
});
describe("callOrder — hooks", () => {
    it("records hooks in the flow but keeps them out of metadata.calls", () => {
        const nodes = parseTsx(`
      import { useState } from "react";
      function useCustom() { return 1; }
      function doWork() {}
      function Panel() {
        const [v] = useState(0);
        doWork();
        const c = useCustom();
        return <div>{v}</div>;
      }
    `);
        const panel = nodeOf(nodes, "Panel");
        const sites = panel.metadata.callSites;
        expect(sites.map((s) => [s.name, s.kind, s.order])).toEqual([
            ["useState", "hook", 1],
            ["doWork", "call", 2],
            ["useCustom", "hook", 3],
        ]);
        expect(panel.metadata.hooks).toEqual(["useState", "useCustom"]);
        expect(panel.metadata.uses).toEqual(["doWork"]);
    });
});
describe("callOrder — execution regions", () => {
    const source = `
    import { useEffect } from "react";
    declare function computeTotal(v: any): number;
    declare function fetchRows(): void;
    declare function apiPost(v: any): void;
    declare function save(v: any): void;
    declare function formatMoney(v: any): string;

    function Table({ items }: { items: number[] }) {
      const total = computeTotal(items);
      useEffect(() => { fetchRows(); }, []);
      function handleSave() { apiPost(total); }
      return <button onClick={() => save(total)}>{formatMoney(total)}</button>;
    }
  `;
    it("tags render-body calls inline", () => {
        const nodes = parseTsx(source);
        const site = sitesOf(nodes, "Table").find((s) => s.name === "computeTotal");
        expect(site.scope).toBe("inline");
        expect(site.order).toBe(1);
    });
    it("tags a JSX handler call as a handler and never as render order", () => {
        const nodes = parseTsx(source);
        const site = sitesOf(nodes, "Table").find((s) => s.name === "save");
        expect(site.scope).toBe("handler");
        expect(site.defer).toBe("event");
    });
    it("tags a useEffect callback call as postRender", () => {
        const nodes = parseTsx(source);
        const site = sitesOf(nodes, "Table").find((s) => s.name === "fetchRows");
        expect(site.scope).toBe("callback");
        expect(site.defer).toBe("postRender");
    });
    it("tags a call inside an inner function as nested", () => {
        const nodes = parseTsx(source);
        const site = sitesOf(nodes, "Table").find((s) => s.name === "apiPost");
        expect(site.scope).toBe("nested");
    });
    it("tags a call in JSX children (not an attribute) as inline", () => {
        const nodes = parseTsx(source);
        const site = sitesOf(nodes, "Table").find((s) => s.name === "formatMoney");
        expect(site.scope).toBe("inline");
    });
    it("keeps one monotone sequence across all regions", () => {
        const nodes = parseTsx(source);
        const orders = sitesOf(nodes, "Table").map((s) => s.order);
        expect(orders).toEqual([...orders].sort((a, b) => a - b));
        expect(new Set(orders).size).toBe(orders.length);
    });
    it("tags module-scope calls on the FILE node", () => {
        const nodes = parseOne(`
      import { startAll } from "./start";
      const running = startAll();
    `);
        const file = nodes.find((n) => n.id === "file::main.ts");
        const sites = file.metadata.callSites;
        expect(sites[0].scope).toBe("module");
        expect(sites[0].order).toBe(1);
    });
    it("tags an iteration callback as a repeated callback", () => {
        const nodes = parseOne(`
      function save(x: number) {}
      function run(items: number[]) { items.map((x) => save(x)); }
    `);
        const site = sitesOf(nodes, "run").find((s) => s.name === "save");
        expect(site.scope).toBe("callback");
        expect(site.repeat).toBe(true);
        expect(site.defer).toBeUndefined();
    });
});
describe("callOrder — async and concurrency markers", () => {
    it("marks an awaited call and keeps the following order", () => {
        const nodes = parseOne(`
      declare function fetchUser(): Promise<number>;
      declare function saveUser(v: number): void;
      async function load() { const u = await fetchUser(); saveUser(u); }
    `);
        const sites = sitesOf(nodes, "load");
        expect(sites[0]).toMatchObject({ name: "fetchUser", order: 1, awaited: true });
        expect(sites[1]).toMatchObject({ name: "saveUser", order: 2 });
        expect(sites[1].awaited).toBeUndefined();
    });
    it("marks a timer callback", () => {
        const nodes = parseOne(`
      declare function logLater(): void;
      function run() { setTimeout(() => logLater(), 0); }
    `);
        expect(sitesOf(nodes, "run")).toEqual([
            expect.objectContaining({ name: "logLater", scope: "callback", defer: "timer" }),
        ]);
    });
    it("marks a promise continuation", () => {
        const nodes = parseOne(`
      declare function after(): void;
      declare const p: Promise<number>;
      function run() { p.then(() => after()); }
    `);
        expect(sitesOf(nodes, "run").find((s) => s.name === "after")).toEqual(expect.objectContaining({ name: "after", scope: "callback", defer: "promise" }));
    });
    it("marks a microtask callback", () => {
        const nodes = parseOne(`
      declare function after(): void;
      function run() { queueMicrotask(() => after()); }
    `);
        expect(sitesOf(nodes, "run").find((s) => s.name === "after")).toEqual(expect.objectContaining({ name: "after", scope: "callback", defer: "microtask" }));
    });
    it("marks an event listener callback", () => {
        const nodes = parseOne(`
      declare function onClick(): void;
      declare const el: any;
      function run() { el.addEventListener("click", () => onClick()); }
    `);
        expect(sitesOf(nodes, "run").find((s) => s.name === "onClick")).toEqual(expect.objectContaining({ name: "onClick", scope: "callback", defer: "event" }));
    });
    it("marks Promise.all members as concurrent", () => {
        const nodes = parseOne(`
      declare function a(): Promise<number>;
      declare function b(): Promise<number>;
      async function run() { await Promise.all([a(), b()]); }
    `);
        const sites = sitesOf(nodes, "run");
        expect(sites.map((s) => [s.name, s.order, s.conc])).toEqual([
            ["a", 1, true], ["b", 2, true],
        ]);
    });
    it("does not claim detachment for an unrecognised callback helper", () => {
        const nodes = parseOne(`
      declare function after(): void;
      declare const sched: any;
      function run() { sched.runLater(() => after()); }
    `);
        const site = sitesOf(nodes, "run").find((s) => s.name === "after");
        expect(site.scope).toBe("callback");
        expect(site.defer).toBeUndefined();
    });
    it("marks branch and loop sites", () => {
        const nodes = parseOne(`
      declare function a(): void;
      declare function b(): void;
      function run(flag: boolean) {
        if (flag) a();
        while (flag) b();
      }
    `);
        const sites = sitesOf(nodes, "run");
        expect(sites.find((s) => s.name === "a").maybe).toBe(true);
        expect(sites.find((s) => s.name === "b").repeat).toBe(true);
    });
    it("does not mark a call in an if-condition as conditional", () => {
        const nodes = parseOne(`
      declare function a(): boolean;
      declare function b(): void;
      function run() { if (a()) b(); }
    `);
        const sites = sitesOf(nodes, "run");
        expect(sites.find((s) => s.name === "a").maybe).toBeUndefined();
        expect(sites.find((s) => s.name === "b").maybe).toBe(true);
    });
    it("marks a call inside finally as onReturn", () => {
        const nodes = parseOne(`
      declare function cleanup(): void;
      function run() { try { work(); } finally { cleanup(); } }
      declare function work(): void;
    `);
        expect(sitesOf(nodes, "run").find((s) => s.name === "cleanup")).toEqual(expect.objectContaining({ name: "cleanup", defer: "onReturn" }));
    });
});
describe("callOrder — invariants", () => {
    const source = `
    declare function alpha(x?: any): void;
    declare function beta(): number;
    declare function gamma(): void;
    function run(items: number[], flag: boolean) {
      alpha(beta());
      if (flag) { gamma(); }
      for (const i of items) alpha(i);
    }
  `;
    it("keeps orders contiguous, unique and monotone by position", () => {
        const nodes = parseOne(source);
        const sites = sitesOf(nodes, "run");
        expect(sites.map((s) => s.order)).toEqual([1, 2, 3, 4]);
        for (let i = 1; i < sites.length; i++) {
            const prev = sites[i - 1];
            const cur = sites[i];
            expect(cur.order).toBeGreaterThan(prev.order);
            expect(cur.line > prev.line || (cur.line === prev.line && cur.col > prev.col)).toBe(true);
        }
    });
    it("only points nested at an existing lower order", () => {
        const nodes = parseOne(source);
        const sites = sitesOf(nodes, "run");
        const orders = new Set(sites.map((s) => s.order));
        for (const site of sites) {
            if (site.nested === undefined)
                continue;
            expect(orders.has(site.nested)).toBe(true);
            expect(site.nested).toBeLessThan(site.order);
        }
    });
    it("keeps metadata.calls identical as a set", () => {
        const nodes = parseOne(source);
        expect(nodeOf(nodes, "run").metadata.calls).toEqual(["alpha", "beta", "gamma"]);
    });
    it("gives every site a line, a column and a scope", () => {
        const nodes = parseOne(source);
        for (const site of sitesOf(nodes, "run")) {
            expect(typeof site.line).toBe("number");
            expect(typeof site.col).toBe("number");
            expect(site.scope).toBeDefined();
            expect(site.kind).toBe("call");
        }
    });
});

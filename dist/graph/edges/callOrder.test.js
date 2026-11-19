import fs from "fs";
import path from "path";
import os from "os";
import { parseRepo } from "../../parser/index.js";
import { buildLookupMaps } from "../buildLookup.js";
import { detectImportEdges } from "./importEdges.js";
import { detectCallEdges } from "./callEdges.js";
import { detectPropEdges } from "./propEdges.js";
import { detectHookEdges } from "./hookEdges.js";
import { buildThirdPartyNodes } from "../thirdPartyLibs.js";
// callOrder/v1 edge projection. docs/CALL_ORDER.md §3.2.
function createFakeRepo(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-callorder-edge-"));
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
function detectCalls(repoPath, extraNodes = []) {
    const { nodes } = parseRepo(repoPath);
    const all = [...nodes, ...extraNodes];
    const lookup = buildLookupMaps(all);
    detectImportEdges(lookup, repoPath);
    const result = detectCallEdges(all, lookup);
    return { nodes, edges: result.edges };
}
function edgeOf(edges, from, to, type = "CALLS") {
    const found = edges.find((e) => e.from === from && e.to === to && e.type === type);
    if (!found)
        throw new Error(`edge not found: ${from} -> ${to} (${type})`);
    return found;
}
function nodeOf(nodes, name) {
    const found = nodes.find((n) => n.name === name);
    if (!found)
        throw new Error(`node not found: ${name}`);
    return found;
}
describe("callOrder edges — CALLS", () => {
    it("keeps the first position and every repeated position on the node, not the edge", () => {
        const repo = createFakeRepo({
            "main.ts": `
        function a() {}
        function b() {}
        function run() { a(); b(); a(); }
      `,
        });
        const { nodes, edges } = detectCalls(repo);
        const run = nodeOf(nodes, "run");
        const a = nodeOf(nodes, "a");
        const b = nodeOf(nodes, "b");
        const rc = (run.metadata.resolvedCalls ?? []);
        expect(rc.find((r) => r.nodeId === a.id)).toMatchObject({ firstOrder: 1, orders: [1, 3] });
        expect(rc.find((r) => r.nodeId === b.id)).toMatchObject({ firstOrder: 2 });
        expect(rc.find((r) => r.nodeId === b.id)?.orders).toBeUndefined();
        // The edge is structure only.
        expect(edgeOf(edges, run.id, a.id).metadata).not.toHaveProperty("firstCallOrder");
        deleteFakeRepo(repo);
    });
    it("still emits exactly one edge per target", () => {
        const repo = createFakeRepo({
            "main.ts": `
        function a() {}
        function run() { a(); a(); a(); }
      `,
        });
        const { edges } = detectCalls(repo);
        expect(edges.filter((e) => e.type === "CALLS")).toHaveLength(1);
        deleteFakeRepo(repo);
    });
    it("mirrors the position into resolvedCalls with the call-site line", () => {
        const repo = createFakeRepo({
            "main.ts": `
        function a() {}
        function run() {
          a();
        }
      `,
        });
        const { nodes } = detectCalls(repo);
        const run = nodeOf(nodes, "run");
        expect(run.metadata.resolvedCalls).toEqual([
            expect.objectContaining({ name: "a", firstOrder: 1, line: 4 }),
        ]);
        deleteFakeRepo(repo);
    });
    it("numbers third-party calls in the same sequence", () => {
        const repo = createFakeRepo({
            "main.ts": `
        import axios from "axios";
        declare function local(): void;
        function run() { local(); axios.get("/x"); }
      `,
        });
        const extra = buildThirdPartyNodes(repo, ["axios"]);
        const { nodes, edges } = detectCalls(repo, extra);
        const run = nodeOf(nodes, "run");
        const thirdParty = edges.find((e) => e.from === run.id && e.to.endsWith("axios::get"));
        expect(thirdParty).toBeDefined();
        expect(thirdParty?.metadata).not.toHaveProperty("firstCallOrder");
        const rc = (run.metadata.resolvedCalls ?? []);
        expect(rc.find((r) => r.nodeId === thirdParty.to)?.firstOrder).toBe(2);
        deleteFakeRepo(repo);
    });
    it("leaves structure-only callers without an order", () => {
        const nodes = [
            {
                id: "f.ts::a",
                name: "a",
                type: "FUNCTION",
                filePath: "f.ts",
                startLine: 1,
                endLine: 1,
                metadata: {},
            },
            {
                id: "f.ts::run",
                name: "run",
                type: "FUNCTION",
                filePath: "f.ts",
                startLine: 2,
                endLine: 2,
                metadata: { calls: ["a"] },
            },
        ];
        const lookup = buildLookupMaps(nodes);
        const { edges } = detectCallEdges(nodes, lookup);
        expect(edges).toHaveLength(1);
        expect(edges[0].metadata?.firstCallOrder).toBeUndefined();
    });
});
describe("callOrder edges — hooks and components", () => {
    it("numbers hook CALLS edges", () => {
        const repo = createFakeRepo({
            "main.tsx": `
        import { useState } from "react";
        function useTheme() { return "dark"; }
        function Panel() {
          const [v] = useState(0);
          const t = useTheme();
          return <div>{v}{t}</div>;
        }
      `,
        });
        const { nodes } = parseRepo(repo);
        const edges = detectHookEdges(nodes, buildLookupMaps(nodes));
        const panel = nodeOf(nodes, "Panel");
        const theme = nodeOf(nodes, "useTheme");
        const hookEdge = edgeOf(edges, panel.id, theme.id);
        expect(hookEdge.metadata).toMatchObject({ isHookCall: true });
        // The ordinal lives on the caller's callSites, never on the edge.
        expect(hookEdge.metadata).not.toHaveProperty("firstCallOrder");
        const site = panel.metadata.callSites.find((c) => c.name === "useTheme");
        expect(site.order).toBe(2);
        deleteFakeRepo(repo);
    });
    it("numbers USES edges from components", () => {
        const repo = createFakeRepo({
            "main.tsx": `
        declare function formatName(v: string): string;
        function Card({ name }: { name: string }) {
          return <span>{formatName(name)}</span>;
        }
      `,
        });
        const { nodes, edges } = detectCalls(repo);
        const card = nodeOf(nodes, "Card");
        const formatName = nodes.find((n) => n.name === "formatName");
        if (formatName) {
            const uses = edgeOf(edges, card.id, formatName.id, "USES");
            expect(uses.metadata).not.toHaveProperty("firstCallOrder");
            expect(uses.metadata).not.toHaveProperty("callOrder");
            const rc = (card.metadata.resolvedCalls ?? []);
            expect(rc.find((r) => r.nodeId === formatName.id)?.firstOrder).toBe(1);
        }
        else {
            expect(card.metadata.uses).toEqual(["formatName"]);
        }
        deleteFakeRepo(repo);
    });
    it("numbers PROP_PASS render order, including repeats", () => {
        const repo = createFakeRepo({
            "main.tsx": `
        function Item({ v }: { v: number }) { return <li>{v}</li>; }
        function List() { return <ul><Item v={1} /><Item v={2} /></ul>; }
      `,
        });
        const { nodes } = parseRepo(repo);
        const edges = detectPropEdges(nodes, buildLookupMaps(nodes), repo);
        const list = nodeOf(nodes, "List");
        const item = nodeOf(nodes, "Item");
        const edge = edgeOf(edges, list.id, item.id, "PROP_PASS");
        expect(edge.metadata).toMatchObject({ renderCount: 2 });
        deleteFakeRepo(repo);
    });
    // Guard: ordering is node metadata only. If this fails, someone re-added the
    // denormalised edge mirror that the cloud had to strip at ingest.
    it("writes no ordering keys into any edge metadata", () => {
        const repo = createFakeRepo({
            "main.tsx": `
        function Item({ v }: { v: number }) { return <li>{v}</li>; }
        function List() { return <ul><Item v={1} /><Item v={2} /></ul>; }
        declare function formatName(v: string): string;
        function Page({ name }: { name: string }) {
          return <span>{formatName(name)}<List /></span>;
        }
      `,
        });
        const { nodes, edges } = detectCalls(repo);
        const FORBIDDEN = ["firstCallOrder", "callOrder", "firstRenderOrder", "renderOrders"];
        for (const edge of edges) {
            for (const key of FORBIDDEN) {
                expect(edge.metadata ?? {}).not.toHaveProperty(key);
            }
        }
        // ...while the ordinal is still available on the caller.
        const page = nodeOf(nodes, "Page");
        const rc = (page.metadata.resolvedCalls ?? []);
        expect(rc.find((r) => r.name === "formatName")?.firstOrder).toBe(1);
        deleteFakeRepo(repo);
    });
});

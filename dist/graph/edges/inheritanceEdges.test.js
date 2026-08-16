import fs from "fs";
import path from "path";
import os from "os";
import { parseRepo } from "../../parser/index.js";
import { buildLookupMaps } from "../buildLookup.js";
import { detectInheritanceEdges } from "./inheritanceEdges.js";
// ─── Helpers ─────────────────────────────────────────────────────────────────
function createFakeRepo(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-inh-test-"));
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
function detect(repoPath) {
    const { nodes } = parseRepo(repoPath);
    return detectInheritanceEdges(nodes, buildLookupMaps(nodes));
}
// ─── Tests ───────────────────────────────────────────────────────────────────
describe("detectInheritanceEdges", () => {
    // 29. Same-file class → class EXTENDS
    it("emits EXTENDS for a same-file class-to-class inheritance", () => {
        const repo = createFakeRepo({
            "src/inh.ts": `
        export class Base {}
        export class Child extends Base {}
      `,
        });
        const edges = detect(repo);
        expect(edges).toContainEqual(expect.objectContaining({ from: "src/inh.ts::Child", to: "src/inh.ts::Base", type: "EXTENDS" }));
        expect(edges.filter((e) => e.type === "EXTENDS")).toHaveLength(1);
        deleteFakeRepo(repo);
    });
    // 30. Cross-file EXTENDS
    it("emits EXTENDS across files via name lookup", () => {
        const repo = createFakeRepo({
            "src/base.ts": `export class Base {}`,
            "src/child.ts": `
        import { Base } from "./base";
        export class Child extends Base {}
      `,
        });
        const edges = detect(repo);
        expect(edges).toContainEqual(expect.objectContaining({ from: "src/child.ts::Child", to: "src/base.ts::Base", type: "EXTENDS" }));
        deleteFakeRepo(repo);
    });
    // 31. Third-party extends → no edge (never dangling)
    it("does not emit EXTENDS for third-party bases", () => {
        const repo = createFakeRepo({
            "src/react.tsx": `
        import React from "react";
        export class Dashboard extends React.Component<{ title: string }, {}> {
          render() { return <div />; }
        }
      `,
        });
        const edges = detect(repo);
        expect(edges.filter((e) => e.type === "EXTENDS")).toHaveLength(0);
        deleteFakeRepo(repo);
    });
    // 32. Generic local base → generics stripped, EXTENDS emitted
    it("strips generics from extends before resolving", () => {
        const repo = createFakeRepo({
            "src/gen.ts": `
        export class Base<T> {}
        export class Child extends Base<string> {}
      `,
        });
        const edges = detect(repo);
        expect(edges).toContainEqual(expect.objectContaining({ from: "src/gen.ts::Child", to: "src/gen.ts::Base", type: "EXTENDS" }));
        expect(edges[0].metadata).toEqual({ extendsType: "Base<string>" }); // raw preserved
        deleteFakeRepo(repo);
    });
    // 33+34. implements → only when target is a local CLASS
    it("emits IMPLEMENTS only for local class targets, ignores interfaces", () => {
        const repo = createFakeRepo({
            "src/impl.ts": `
        interface Contract { run(): void; }
        export class BaseClass { run() {} }
        export class Worker implements Contract, BaseClass {}
      `,
        });
        const edges = detect(repo);
        const implementsEdges = edges.filter((e) => e.type === "IMPLEMENTS");
        expect(implementsEdges).toHaveLength(1); // only BaseClass — Contract has no node
        expect(implementsEdges[0]).toEqual(expect.objectContaining({ from: "src/impl.ts::Worker", to: "src/impl.ts::BaseClass" }));
        deleteFakeRepo(repo);
    });
    it("emits no IMPLEMENTS edge when every target is an interface", () => {
        const repo = createFakeRepo({
            "src/iface.ts": `
        interface A { a(): void; }
        interface B { b(): void; }
        export class OnlyIfaces implements A, B {}
      `,
        });
        const edges = detect(repo);
        expect(edges.filter((e) => e.type === "IMPLEMENTS")).toHaveLength(0);
        deleteFakeRepo(repo);
    });
    // 35. Dedup
    it("dedupes repeated implements of the same class", () => {
        const repo = createFakeRepo({
            "src/dup.ts": `
        export class Base {}
        export class Dup implements Base, Base {}
      `,
        });
        const edges = detect(repo);
        const implementsEdges = edges.filter((e) => e.type === "IMPLEMENTS");
        expect(implementsEdges).toHaveLength(1);
        deleteFakeRepo(repo);
    });
    // Dotted / unresolvable names → skipped
    it("skips dotted and unresolvable base names", () => {
        const repo = createFakeRepo({
            "src/dotted.ts": `
        export class Local {}
        export class A extends SomeMissing {}
        export class B extends ns.Local {}
      `,
        });
        const edges = detect(repo);
        expect(edges.filter((e) => e.type === "EXTENDS")).toHaveLength(0);
        deleteFakeRepo(repo);
    });
    // Classes without heritage produce nothing
    it("emits nothing for standalone classes", () => {
        const repo = createFakeRepo({
            "src/plain.ts": `export class Standalone { run() {} }`,
        });
        expect(detect(repo)).toHaveLength(0);
        deleteFakeRepo(repo);
    });
});

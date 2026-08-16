import fs from "fs";
import path from "path";
import os from "os";
import { parseRepo } from "./index.js";
// ─── Helpers (mirror index.test.ts) ─────────────────────────────────────────
function createFakeRepo(files) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-classes-test-"));
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
function nodesOf(repoPath, type) {
    return parseRepo(repoPath).nodes.filter((n) => n.type === type);
}
// ─── Tests ───────────────────────────────────────────────────────────────────
describe("class extraction", () => {
    // 1. Plain class, no methods → CLASS node only
    it("emits a CLASS node for a plain class with no methods", () => {
        const repo = createFakeRepo({
            "src/empty.ts": `export class Marker {}`,
        });
        const cls = nodesOf(repo, "CLASS").find((n) => n.name === "Marker");
        expect(cls).toBeDefined();
        expect(cls?.metadata.methodNames).toEqual([]);
        expect(cls?.metadata.extendsType).toBeUndefined();
        expect(cls?.metadata.implementsTypes).toEqual([]);
        deleteFakeRepo(repo);
    });
    // 2. Constructor-only class → Class.constructor METHOD
    it("emits a constructor as a METHOD node", () => {
        const repo = createFakeRepo({
            "src/svc.ts": `
        export class Service {
          constructor(private api: string) {}
        }
      `,
        });
        const ctor = nodesOf(repo, "METHOD").find((n) => n.name === "Service.constructor");
        expect(ctor).toBeDefined();
        expect(ctor?.metadata.isConstructor).toBe(true);
        expect(ctor?.metadata.className).toBe("Service");
        const cls = nodesOf(repo, "CLASS").find((n) => n.name === "Service");
        expect(cls?.metadata.constructorParams).toEqual(["api"]);
        deleteFakeRepo(repo);
    });
    // 3. Private methods (private foo, #bar) → isPrivate
    it("flags private and #-private methods", () => {
        const repo = createFakeRepo({
            "src/priv.ts": `
        export class Secrets {
          private hidden() { return 1; }
          #trulyHidden() { return 2; }
          visible() { return this.hidden() + this.#trulyHidden(); }
        }
      `,
        });
        const methods = nodesOf(repo, "METHOD");
        const hidden = methods.find((n) => n.name === "Secrets.hidden");
        const truly = methods.find((n) => n.name === "Secrets.trulyHidden");
        const visible = methods.find((n) => n.name === "Secrets.visible");
        expect(hidden?.metadata.isPrivate).toBe(true);
        expect(truly?.metadata.isPrivate).toBe(true);
        expect(visible?.metadata.isPrivate).toBe(false);
        // #-name is stripped for the node name, and this.#trulyHidden() rewrites
        // to the stripped name
        expect(visible?.metadata.calls).toContain("Secrets.hidden");
        expect(visible?.metadata.calls).toContain("Secrets.trulyHidden");
        deleteFakeRepo(repo);
    });
    // 4. Static methods → isStatic
    it("flags static methods", () => {
        const repo = createFakeRepo({
            "src/static.ts": `
        export class MathUtils {
          static add(a: number, b: number) { return a + b; }
          instance() { return MathUtils.add(1, 2); }
        }
      `,
        });
        const methods = nodesOf(repo, "METHOD");
        expect(methods.find((n) => n.name === "MathUtils.add")?.metadata.isStatic).toBe(true);
        expect(methods.find((n) => n.name === "MathUtils.instance")?.metadata.isStatic).toBe(false);
        // Static self-reference stays as the dotted class name → resolvable later
        expect(methods.find((n) => n.name === "MathUtils.instance")?.metadata.calls).toContain("MathUtils.add");
        deleteFakeRepo(repo);
    });
    // 5. Abstract class + abstract method
    it("flags abstract classes and abstract methods", () => {
        const repo = createFakeRepo({
            "src/abs.ts": `
        export abstract class Shape {
          abstract area(): number;
          label() { return "shape"; }
        }
      `,
        });
        const cls = nodesOf(repo, "CLASS").find((n) => n.name === "Shape");
        expect(cls?.metadata.isAbstract).toBe(true);
        const methods = nodesOf(repo, "METHOD");
        expect(methods.find((n) => n.name === "Shape.area")?.metadata.isAbstract).toBe(true);
        expect(methods.find((n) => n.name === "Shape.label")?.metadata.isAbstract).toBe(false);
        deleteFakeRepo(repo);
    });
    // 6. Getter/setter → isAccessor
    it("emits getters and setters as METHOD nodes with isAccessor", () => {
        const repo = createFakeRepo({
            "src/acc.ts": `
        export class Temperature {
          private celsius = 0;
          get fahrenheit() { return this.celsius * 9 / 5 + 32; }
          set fahrenheit(v: number) { this.celsius = (v - 32) * 5 / 9; }
        }
      `,
        });
        const methods = nodesOf(repo, "METHOD");
        const getter = methods.find((n) => n.name === "Temperature.fahrenheit" && n.metadata.isAccessor === "get");
        const setter = methods.find((n) => n.name === "Temperature.fahrenheit" && n.metadata.isAccessor === "set");
        expect(getter).toBeDefined();
        expect(setter).toBeDefined();
        deleteFakeRepo(repo);
    });
    // 7. Generic class → typeParams
    it("captures type parameters on generic classes", () => {
        const repo = createFakeRepo({
            "src/gen.ts": `export class Box<T> { value?: T; }`,
        });
        const cls = nodesOf(repo, "CLASS").find((n) => n.name === "Box");
        expect(cls?.metadata.typeParams).toEqual(["T"]);
        deleteFakeRepo(repo);
    });
    // 8. Decorated class (NestJS-style)
    it("captures class decorators", () => {
        const repo = createFakeRepo({
            "src/dec.ts": `
        function Injectable() { return (t: any) => t; }
        function Controller(p: string) { return (t: any) => t; }
        @Controller("cats")
        @Injectable()
        export class CatsService {}
      `,
        });
        const cls = nodesOf(repo, "CLASS").find((n) => n.name === "CatsService");
        expect(cls?.metadata.decorators).toContain("Injectable");
        expect(cls?.metadata.decorators).toContain("Controller");
        deleteFakeRepo(repo);
    });
    // 9. React class component → CLASS (not COMPONENT) + propsType/stateType
    it("emits React class components as CLASS nodes with props/state types", () => {
        const repo = createFakeRepo({
            "src/Dashboard.tsx": `
        import React from "react";
        interface DashboardProps { title: string; }
        interface DashboardState { open: boolean; }
        export class Dashboard extends React.Component<DashboardProps, DashboardState> {
          render() { return <div>{this.props.title}</div>; }
        }
      `,
        });
        const result = parseRepo(repo);
        const cls = result.nodes.find((n) => n.name === "Dashboard");
        expect(cls).toBeDefined();
        expect(cls?.type).toBe("CLASS"); // NOT COMPONENT — one node per declaration
        expect(cls?.metadata.isReactComponent).toBe(true);
        expect(cls?.metadata.propsType).toBe("DashboardProps");
        expect(cls?.metadata.stateType).toBe("DashboardState");
        expect(result.nodes.some((n) => n.type === "COMPONENT" && n.name === "Dashboard")).toBe(false);
        const render = result.nodes.find((n) => n.name === "Dashboard.render");
        expect(render?.metadata.isReactLifecycle).toBe(true);
        deleteFakeRepo(repo);
    });
    // 10. Multiple implements → implementsTypes
    it("captures multiple implements clauses", () => {
        const repo = createFakeRepo({
            "src/multi.ts": `
        interface A {}
        interface B {}
        export class Combined implements A, B {}
      `,
        });
        const cls = nodesOf(repo, "CLASS").find((n) => n.name === "Combined");
        expect(cls?.metadata.implementsTypes).toEqual(["A", "B"]);
        deleteFakeRepo(repo);
    });
    // 11. extends local base → extendsType (raw text, generics kept)
    it("captures the raw extends expression", () => {
        const repo = createFakeRepo({
            "src/inh.ts": `
        export class Base {}
        export class Child extends Base {}
        export class GenericChild extends Base<string> {}
      `,
        });
        const child = nodesOf(repo, "CLASS").find((n) => n.name === "Child");
        expect(child?.metadata.extendsType).toBe("Base");
        const generic = nodesOf(repo, "CLASS").find((n) => n.name === "GenericChild");
        expect(generic?.metadata.extendsType).toBe("Base<string>");
        deleteFakeRepo(repo);
    });
    // 12. Class inside a test file → testCases metadata only, zero child nodes
    it("does not emit class/method nodes for test files", () => {
        const repo = createFakeRepo({
            "src/thing.test.ts": `
        export class TestHelper { run() { return 1; } }
        export function helper() { return new TestHelper().run(); }
      `,
        });
        const result = parseRepo(repo);
        expect(result.nodes.some((n) => n.type === "CLASS" || n.type === "METHOD")).toBe(false);
        const testFile = result.nodes.find((n) => n.type === "TEST");
        expect(testFile).toBeDefined();
        expect(testFile?.metadata.testCases).toContain("TestHelper");
        deleteFakeRepo(repo);
    });
    // 13. Class expression (const Foo = class {}) → skipped
    it("skips class expressions", () => {
        const repo = createFakeRepo({
            "src/expr.ts": `
        export const Foo = class {
          bar() { return 1; }
        };
      `,
        });
        const result = parseRepo(repo);
        expect(result.nodes.some((n) => n.type === "CLASS" && n.name === "Foo")).toBe(false);
        expect(result.nodes.some((n) => n.type === "METHOD" && n.name === "Foo.bar")).toBe(false);
        deleteFakeRepo(repo);
    });
    // 14-20. this-rewrite behavior
    it("rewrites this.method() calls to Class.method", () => {
        const repo = createFakeRepo({
            "src/rewrite.ts": `
        export class UserService {
          save() { return 1; }
          run() { return this.save(); }
        }
      `,
        });
        const run = nodesOf(repo, "METHOD").find((n) => n.name === "UserService.run");
        expect(run?.metadata.calls).toContain("UserService.save");
        expect(run?.metadata.calls).not.toContain("this.save");
        deleteFakeRepo(repo);
    });
    it("does not rewrite this.obj.bar() when obj is a property", () => {
        const repo = createFakeRepo({
            "src/prop.ts": `
        export class Adapter {
          private nested = { emit: () => 1 };
          go() { return this.nested.emit(); }
        }
      `,
        });
        const go = nodesOf(repo, "METHOD").find((n) => n.name === "Adapter.go");
        expect(go?.metadata.calls).toContain("this.nested.emit"); // untouched
        expect(go?.metadata.calls).not.toContain("Adapter.nested.emit");
        deleteFakeRepo(repo);
    });
    it("leaves super.method() calls untouched", () => {
        const repo = createFakeRepo({
            "src/super.ts": `
        export class Base { ping() { return 1; } }
        export class Child extends Base {
          call() { return super.ping(); }
        }
      `,
        });
        const call = nodesOf(repo, "METHOD").find((n) => n.name === "Child.call");
        expect(call?.metadata.calls).toContain("super.ping");
        expect(call?.metadata.calls).not.toContain("Child.ping");
        deleteFakeRepo(repo);
    });
    it("rewrites this.method.bind(this) member expressions cleanly", () => {
        const repo = createFakeRepo({
            "src/bind.ts": `
        export class Handler {
          work() { return 1; }
          setup() { return this.work.bind(this); }
        }
      `,
        });
        const setup = nodesOf(repo, "METHOD").find((n) => n.name === "Handler.setup");
        expect(setup?.metadata.calls).toContain("Handler.work.bind");
        deleteFakeRepo(repo);
    });
    it("rewrites this.foo() inside nested arrow functions", () => {
        const repo = createFakeRepo({
            "src/arrow.ts": `
        export class Runner {
          step() { return 1; }
          all() { return [1].map(() => this.step()); }
        }
      `,
        });
        const all = nodesOf(repo, "METHOD").find((n) => n.name === "Runner.all");
        expect(all?.metadata.calls).toContain("Runner.step");
        deleteFakeRepo(repo);
    });
    it("rewrites this.foo() inside nested regular functions (heuristic)", () => {
        const repo = createFakeRepo({
            "src/fn.ts": `
        export class Legacy {
          step() { return 1; }
          run() { return function () { return this.step(); }; }
        }
      `,
        });
        const run = nodesOf(repo, "METHOD").find((n) => n.name === "Legacy.run");
        expect(run?.metadata.calls).toContain("Legacy.step"); // documented heuristic
        deleteFakeRepo(repo);
    });
    it("rewrites this.bar() in static methods to Class.bar", () => {
        const repo = createFakeRepo({
            "src/stat.ts": `
        export class Registry {
          static lookup() { return 1; }
          static init() { return this.lookup(); }
        }
      `,
        });
        const init = nodesOf(repo, "METHOD").find((n) => n.name === "Registry.init");
        expect(init?.metadata.calls).toContain("Registry.lookup");
        deleteFakeRepo(repo);
    });
    // Stats
    it("reports classCount and methodCount in stats", () => {
        const repo = createFakeRepo({
            "src/stats.ts": `
        export class Alpha { one() {} two() {} }
        export class Beta { three() {} }
      `,
        });
        const stats = parseRepo(repo).stats;
        expect(stats.classCount).toBe(2);
        expect(stats.methodCount).toBe(3);
        deleteFakeRepo(repo);
    });
    // Node identity / wiring
    it("normalizes class and method ids to relative paths with parentFile", () => {
        const repo = createFakeRepo({
            "src/ids.ts": `export class Widget { paint() {} }`,
        });
        const result = parseRepo(repo);
        const cls = result.nodes.find((n) => n.name === "Widget");
        const method = result.nodes.find((n) => n.name === "Widget.paint");
        expect(cls?.id).toBe("src/ids.ts::Widget");
        expect(cls?.parentFile).toBe("file::src/ids.ts");
        expect(method?.id).toBe("src/ids.ts::Widget.paint");
        expect(method?.parentFile).toBe("file::src/ids.ts");
        expect(method?.filePath).toBe("src/ids.ts");
        const fileNode = result.nodes.find((n) => n.type === "FILE" && n.filePath === "src/ids.ts");
        expect(fileNode?.metadata.childNodeIds).toContain("src/ids.ts::Widget");
        expect(fileNode?.metadata.childNodeIds).toContain("src/ids.ts::Widget.paint");
        deleteFakeRepo(repo);
    });
});

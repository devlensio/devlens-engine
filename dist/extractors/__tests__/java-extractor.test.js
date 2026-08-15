// Java extractor — contract tests, run under `bun test` (same as JS/TS).
//
// Black-box: spawns `java -jar devlens_java_extractor.jar` against static
// fixture repos (extractors/java/tests/fixtures/) and asserts on the JSON
// contract. Each fixture+options combo runs ONCE (memoized) — JVM startup
// (~1s) is paid once per combo.
//
// Skipped automatically when the jar isn't built (node extractors/java/build.mjs)
// or no JVM is on PATH.
import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
const JAR = path.resolve(import.meta.dir, "../../../extractors/java/devlens_java_extractor.jar");
const FIXTURES = path.resolve(import.meta.dir, "../../../extractors/java/tests/fixtures");
const jarAvailable = fs.existsSync(JAR);
const javaOnPath = process.env.PATH?.split(":").some((dir) => fs.existsSync(path.join(dir, "java")));
// ─── Helpers ────────────────────────────────────────────────────────────
function runJava(fixture, options = {}) {
    const res = spawnSync("java", ["-jar", JAR], {
        input: JSON.stringify({ repoPath: path.join(FIXTURES, fixture), options }),
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
    });
    expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
    return JSON.parse(res.stdout);
}
const memo = new Map();
function analyze(fixture, options = {}) {
    const key = fixture + "|" + JSON.stringify(options);
    if (!memo.has(key))
        memo.set(key, runJava(fixture, options));
    return memo.get(key);
}
function nodesOf(d, pred) {
    return d.nodes.filter(pred);
}
function edgesOf(d, type) {
    return d.edges.filter((e) => e.type === type);
}
// ─── Suite ───────────────────────────────────────────────────────────────
describe.skipIf(!jarAvailable || !javaOnPath)("java extractor (contract + fixtures)", () => {
    test("fixtures dir is present", () => {
        expect(fs.existsSync(FIXTURES)).toBe(true);
    });
    // ── springboot fixture (the mini Spring Boot app) ───────────────────
    describe("springboot fixture", () => {
        const d = analyze("springboot");
        test("fingerprint: spring-boot/backend + [jpa, postgresql]", () => {
            expect(d.fingerprint.framework).toBe("spring-boot");
            expect(d.fingerprint.projectType).toBe("backend");
            expect(d.fingerprint.databases).toEqual(["jpa", "postgresql"]);
            expect(d.fingerprint.language).toBe("java");
            expect(d.fingerprint.rawDependencies["org.springframework.boot:spring-boot-starter-web"]).toBeDefined();
        });
        test("stats: 8 files, 43 nodes, 0 errors", () => {
            expect(d.stats.totalFiles).toBe(8);
            expect(d.stats.totalNodes).toBe(43);
            expect(d.stats.skippedFiles).toBe(0);
            expect(d.errors).toEqual([]);
        });
        test("node type census", () => {
            const byType = d.nodes.reduce((acc, n) => {
                acc[n.type] = (acc[n.type] ?? 0) + 1;
                return acc;
            }, {});
            expect(byType).toMatchObject({ FILE: 7, TEST: 1, CLASS: 5, INTERFACE: 2, METHOD: 24, ROUTE: 4 });
        });
        test("routes: class+method path composition, no double slashes", () => {
            expect(d.routes.map((r) => `${r.httpMethod} ${r.urlPath}`).sort()).toEqual([
                "DELETE /api/users/{id}",
                "GET /api/users",
                "GET /api/users/{id}",
                "POST /api/users",
            ].sort());
            for (const r of d.routes)
                expect(r.urlPath).not.toContain("//");
        });
        test("HANDLES: every route → its controller method, 0 broken", () => {
            const handles = edgesOf(d, "HANDLES");
            expect(handles).toHaveLength(4);
            const ids = new Set(d.nodes.map((n) => n.id));
            for (const h of handles)
                expect(ids.has(h.to), `handler exists: ${h.to}`).toBe(true);
            const byPath = new Map(handles.map((h) => [`${h.metadata.httpMethod} ${h.metadata.urlPath}`, h.to]));
            expect(byPath.get("GET /api/users")).toBe("src/main/java/com/example/demo/UserController.java::UserController.listUsers");
            expect(byPath.get("GET /api/users/{id}")).toBe("src/main/java/com/example/demo/UserController.java::UserController.getUser");
            expect(byPath.get("POST /api/users")).toBe("src/main/java/com/example/demo/UserController.java::UserController.createUser");
        });
        test("CALLS: controller → service (4) and service → repository (4)", () => {
            const calls = edgesOf(d, "CALLS");
            expect(calls).toHaveLength(9);
            const svc = "src/main/java/com/example/demo/UserService.java::UserService";
            expect(calls.some((e) => e.from.endsWith("UserController.listUsers") && e.to === svc + ".getAllUsers")).toBe(true);
            expect(calls.some((e) => e.from.endsWith("UserController.createUser") && e.to === svc + ".createUser")).toBe(true);
            // repo inherited methods (findAll/save/...) edge to the repo interface itself
            const repo = "src/main/java/com/example/demo/UserRepository.java::UserRepository";
            expect(calls.filter((e) => e.to === repo)).toHaveLength(4);
            // symbol-solver resolved call to the base class
            expect(calls.some((e) => e.to.endsWith("BaseService.logAction"))).toBe(true);
        });
        test("metadata.calls + resolvedCalls on method nodes", () => {
            const list = nodesOf(d, (n) => n.id.endsWith("UserController.listUsers"))[0];
            expect(list.metadata.calls).toContain("userService.getAllUsers");
            expect(list.metadata.resolvedCalls.length).toBeGreaterThan(0);
            expect(list.metadata.returnType).toBe("List");
            expect(list.rawCode).toContain("public");
            // param + method-level annotations on the {id} handler
            const get = nodesOf(d, (n) => n.id.endsWith("UserController.getUser"))[0];
            expect(get.metadata.params).toEqual(["Long id"]);
            expect(get.metadata.annotations).toEqual(["GetMapping"]);
        });
        test("EXTENDS UserService → BaseService; IMPLEMENTS User → Auditable", () => {
            const ext = edgesOf(d, "EXTENDS");
            expect(ext).toHaveLength(1);
            expect(ext[0]).toMatchObject({
                from: "src/main/java/com/example/demo/UserService.java::UserService",
                to: "src/main/java/com/example/demo/BaseService.java::BaseService",
            });
            const impl = edgesOf(d, "IMPLEMENTS");
            expect(impl).toHaveLength(1);
            expect(impl[0]).toMatchObject({
                from: "src/main/java/com/example/demo/model/User.java::User",
                to: "src/main/java/com/example/demo/Auditable.java::Auditable",
            });
        });
        test("JPA model: User isModel=jpa with fields[]", () => {
            const user = nodesOf(d, (n) => n.id.endsWith("model/User.java::User"))[0];
            expect(user.metadata.isModel).toBe(true);
            expect(user.metadata.modelType).toBe("jpa");
            const names = user.metadata.fields.map((f) => f.name);
            expect(names).toEqual(["id", "name", "email", "createdAt"]);
        });
        test("Spring Data repo: isRepository + linkedModel via generic arg", () => {
            const repo = nodesOf(d, (n) => n.id.endsWith("UserRepository.java::UserRepository"))[0];
            expect(repo.metadata.isRepository).toBe(true);
            expect(repo.metadata.linkedModel).toBe("src/main/java/com/example/demo/model/User.java::User");
        });
        test("R/W edges: service reads+writes User, repo reads User (consumer→store)", () => {
            const rw = d.edges
                .filter((e) => e.type === "READS_FROM" || e.type === "WRITES_TO")
                .map((e) => `${e.from.split("::").pop()} ${e.type} ${e.to.split("::").pop()}`)
                .sort();
            expect(rw).toEqual([
                "UserRepository READS_FROM User",
                "UserService READS_FROM User",
                "UserService WRITES_TO User",
            ].sort());
        });
        test("test file is a LEAF node with testCases; TESTS edge → production class", () => {
            const testNode = nodesOf(d, (n) => n.type === "TEST")[0];
            expect(testNode.id).toBe("file::src/test/java/com/example/demo/UserControllerTest.java");
            expect(testNode.metadata.testCases.sort()).toEqual(["shouldCreateAndFindUsers", "shouldDeleteUser"]);
            expect(nodesOf(d, (n) => n.id.startsWith("src/test/java/com/example/demo/UserControllerTest.java::"))).toHaveLength(0);
            const tests = edgesOf(d, "TESTS");
            expect(tests).toHaveLength(1);
            expect(tests[0].to).toBe("src/main/java/com/example/demo/model/User.java::User");
        });
        test("gating: empty options → ZERO third-party nodes", () => {
            expect(nodesOf(d, (n) => n.type === "THIRD_PARTY")).toHaveLength(0);
        });
        test("gating: allowed libs → [mvn] nodes + IMPORTS + gated EXTENDS", () => {
            const g = analyze("springboot", {
                includeThirdPartyLibs: ["org.springframework", "jakarta.persistence", "org.slf4j"],
            });
            const tp = nodesOf(g, (n) => n.type === "THIRD_PARTY").map((n) => n.id);
            expect(tp).toContain("[mvn]/org.springframework");
            expect(tp).toContain("[mvn]/jakarta.persistence::Entity");
            expect(edgesOf(g, "IMPORTS").filter((e) => e.to.startsWith("[mvn]")).length).toBeGreaterThan(0);
            expect(edgesOf(g, "EXTENDS").some((e) => e.to === "[mvn]/org.springframework::JpaRepository")).toBe(true);
        });
        test("determinism: two runs → byte-identical stdout", () => {
            const opts = { includeThirdPartyLibs: ["org.springframework"] };
            expect(JSON.stringify(runJava("springboot", opts))).toBe(JSON.stringify(runJava("springboot", opts)));
        });
    });
    // ── plain fixture (no framework: records, enums, inner classes) ─────
    describe("plain fixture (no framework)", () => {
        const d = analyze("plain");
        test("fingerprint: unknown/library, no routes", () => {
            expect(d.fingerprint.framework).toBe("unknown");
            expect(d.routes).toEqual([]);
            expect(d.fingerprint.databases).toEqual([]);
        });
        test("records parse: Shape CLASS kind=record, isSchema, component fields", () => {
            const shape = nodesOf(d, (n) => n.id.endsWith("Shape.java::Shape"))[0];
            expect(shape).toBeDefined();
            expect(shape.metadata.kind).toBe("record");
            expect(shape.metadata.isSchema).toBe(true);
            expect(shape.metadata.fields.map((f) => f.name)).toEqual(["width", "height"]);
            expect(nodesOf(d, (n) => n.id.endsWith("Shape.java::Shape.area"))).toHaveLength(1);
        });
        test("enum → ENUM node with method", () => {
            const role = nodesOf(d, (n) => n.id.endsWith("Role.java::Role"))[0];
            expect(role.type).toBe("ENUM");
            expect(role.metadata.kind).toBe("enum");
            expect(nodesOf(d, (n) => n.id.endsWith("Role.java::Role.canModerate"))).toHaveLength(1);
        });
        test("inner class → dotted id Outer.Inner; call resolves into it", () => {
            expect(nodesOf(d, (n) => n.id.endsWith("Outer.java::Outer.Inner"))).toHaveLength(1);
            expect(nodesOf(d, (n) => n.id.endsWith("Outer.java::Outer.Inner.doubleValue"))).toHaveLength(1);
            const calls = edgesOf(d, "CALLS");
            expect(calls.some((e) => e.to.endsWith("Outer.Inner.doubleValue"))).toBe(true);
        });
        test("interface default method call resolves within the interface", () => {
            const calls = edgesOf(d, "CALLS");
            expect(calls.some((e) => e.from.endsWith("Greeter.greetLoud") && e.to.endsWith("Greeter.greet"))).toBe(true);
        });
        test("IMPLEMENTS FriendlyGreeter → Greeter (no dangling targets)", () => {
            const impl = edgesOf(d, "IMPLEMENTS");
            expect(impl).toHaveLength(1);
            expect(impl[0]).toMatchObject({
                from: "src/main/java/com/example/plain/FriendlyGreeter.java::FriendlyGreeter",
                to: "src/main/java/com/example/plain/Greeter.java::Greeter",
            });
        });
        test("test file leaf with testCases; no TESTS edges without imports of prod types", () => {
            const testNode = nodesOf(d, (n) => n.type === "TEST")[0];
            expect(testNode.metadata.testCases.sort()).toEqual(["shouldDivide", "shouldRejectZero"]);
            expect(edgesOf(d, "TESTS")).toHaveLength(0); // MathUtilsTest imports only junit (not gated)
        });
        test("no third-party without gating; JDK imports skipped entirely", () => {
            expect(nodesOf(d, (n) => n.type === "THIRD_PARTY")).toHaveLength(0);
            const imports = edgesOf(d, "IMPORTS");
            expect(imports.filter((e) => e.to.includes("java/util"))).toHaveLength(0);
        });
        test("static method + throws metadata captured", () => {
            const m = nodesOf(d, (n) => n.id.endsWith("MathUtils.java::MathUtils.safeDivide"))[0];
            expect(m.metadata.throws).toContain("IllegalArgumentException");
            expect(m.metadata.isStatic).toBe(true);
        });
    });
    // ── gradle fixture (Gradle manifest path) ────────────────────────────
    describe("gradle fixture", () => {
        const d = analyze("gradle");
        test("fingerprint via build.gradle regex: spring-boot/backend", () => {
            expect(d.fingerprint.framework).toBe("spring-boot");
            expect(d.fingerprint.projectType).toBe("backend");
            expect(d.fingerprint.databases).toEqual(["jpa", "postgresql"]);
            expect(d.fingerprint.rawDependencies["org.springframework.boot:spring-boot-starter-web"]).toBe("3.3.0");
        });
        test("route + call chain", () => {
            expect(d.routes.map((r) => `${r.httpMethod} ${r.urlPath}`)).toEqual(["GET /greetings"]);
            const calls = edgesOf(d, "CALLS");
            expect(calls).toHaveLength(1);
            expect(calls[0]).toMatchObject({
                from: "src/main/java/com/example/gradle/GreetingController.java::GreetingController.greet",
                to: "src/main/java/com/example/gradle/GreetingService.java::GreetingService.message",
            });
        });
        test("@Service marker → isService", () => {
            const svc = nodesOf(d, (n) => n.id.endsWith("GreetingService.java::GreetingService"))[0];
            expect(svc.metadata.isService).toBe(true);
        });
    });
    // ── weird fixture (annotation edge cases) ────────────────────────────
    describe("weird fixture (annotation edge cases)", () => {
        const d = analyze("weird");
        test("verbs + paths from every annotation form", () => {
            expect(d.routes.map((r) => `${r.httpMethod} ${r.urlPath}`).sort()).toEqual([
                "ANY /api/legacy", // @RequestMapping with no method
                "DELETE /api/items/{id}", // RequestMethod.DELETE explicit
                "GET /api/first", // array value → first element
                "PATCH /api/items/{id}",
                "POST /api/login", // bare static-imported POST
            ].sort());
        });
        test("no double slashes in composed paths", () => {
            for (const r of d.routes)
                expect(r.urlPath).not.toContain("//");
        });
        test("HANDLES → 5 handlers, all exist", () => {
            const handles = edgesOf(d, "HANDLES");
            expect(handles).toHaveLength(5);
            const ids = new Set(d.nodes.map((n) => n.id));
            for (const h of handles)
                expect(ids.has(h.to)).toBe(true);
        });
        test("path params → isDynamic + params (braces stripped)", () => {
            const del = d.routes.find((r) => r.httpMethod === "DELETE");
            expect(del.isDynamic).toBe(true);
            expect(del.params).toEqual(["id"]);
        });
    });
    // ── robustness ───────────────────────────────────────────────────────
    describe("robustness", () => {
        test("empty repo → valid empty result, exit 0", () => {
            const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-java-empty-"));
            const res = spawnSync("java", ["-jar", JAR], {
                input: JSON.stringify({ repoPath: repo, options: {} }),
                encoding: "utf8",
            });
            expect(res.status).toBe(0);
            const d = JSON.parse(res.stdout);
            expect(d.nodes).toEqual([]);
            expect(d.stats.totalFiles).toBe(0);
            fs.rmSync(repo, { recursive: true, force: true });
        });
        test("runner guard: commandExists resolves java but not bogus names", async () => {
            const { commandExists } = await import("../index.js");
            expect(commandExists("java")).toBe(true);
            expect(commandExists("definitely-not-a-real-tool-xyz")).toBe(false);
            expect(commandExists(JAR)).toBe(true); // absolute path
            expect(commandExists("/no/such/file.jar")).toBe(false);
        });
    });
});

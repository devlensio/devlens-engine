// Go extractor — contract tests, run under `bun test` (same as JS/TS).
//
// Black-box: spawns the platform's static binary (extractors/go/bin/<platform>/)
// against static fixture repos (extractors/go/tests/fixtures/) and asserts on
// the JSON contract. Each fixture+options combo runs ONCE (memoized).
//
// Skipped automatically when the binary isn't built
// (node extractors/go/build.mjs — requires the Go toolchain).

import { describe, expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const platformDir =
  process.platform === "win32"
    ? "windows-amd64"
    : process.platform === "darwin"
      ? `darwin-${process.arch === "arm64" ? "arm64" : "amd64"}`
      : `linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
const EXE = process.platform === "win32" ? ".exe" : "";
const BINARY = path.resolve(
  import.meta.dir,
  `../../../extractors/go/bin/${platformDir}/devlens_go_extractor${EXE}`
);
const FIXTURES = path.resolve(import.meta.dir, "../../../extractors/go/tests/fixtures");

const binaryAvailable = fs.existsSync(BINARY);

// ─── Helpers ────────────────────────────────────────────────────────────

function runGo(fixture: string, options: Record<string, unknown> = {}) {
  const res = spawnSync(BINARY, [], {
    input: JSON.stringify({ repoPath: path.join(FIXTURES, fixture), options }),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
  return res.stdout;
}

const memo = new Map<string, string>();
function analyze(fixture: string, options: Record<string, unknown> = {}) {
  const key = fixture + "|" + JSON.stringify(options);
  if (!memo.has(key)) memo.set(key, runGo(fixture, options));
  return JSON.parse(memo.get(key)!);
}

function nodesOf(d: any, pred: (n: any) => boolean) {
  return d.nodes.filter(pred);
}
function edgesOf(d: any, type: string) {
  return d.edges.filter((e: any) => e.type === type);
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!binaryAvailable)("go extractor (contract + fixtures)", () => {
  test("fixtures dir is present", () => {
    expect(fs.existsSync(FIXTURES)).toBe(true);
  });

  // ── nethttpfix (stdlib-only net/http app) ────────────────────────────
  describe("nethttpfix fixture", () => {
    const d = analyze("nethttpfix");

    test("fingerprint: net-http/backend", () => {
      expect(d.fingerprint.language).toBe("go");
      expect(d.fingerprint.framework).toBe("net-http");
      expect(d.fingerprint.projectType).toBe("backend");
      expect(d.fingerprint.databases).toEqual([]);
    });

    test("stats: 4 files, 31 nodes, 0 errors", () => {
      expect(d.stats.totalFiles).toBe(4);
      expect(d.stats.totalNodes).toBe(31);
      expect(d.stats.skippedFiles).toBe(0);
      expect(d.errors).toEqual([]);
    });

    test("PACKAGE nodes for both packages", () => {
      const pkgs = nodesOf(d, (n) => n.type === "PACKAGE").map((n: any) => n.id).sort();
      expect(pkgs).toEqual([
        "pkg::github.com/example/nethttpfix",
        "pkg::github.com/example/nethttpfix/internal/users",
      ]);
    });

    test("6 routes — HandleFunc + Handle + closure + package-level + method value", () => {
      const routes = d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort();
      expect(routes).toEqual([
        "GET /",
        "GET /api",
        "GET /health",
        "GET /hello",
        "GET /users",
        "GET /users/",
      ]);
      const ids = d.routes.map((r: any) => r.nodeId).sort();
      for (const r of d.routes) {
        expect(d.nodes.some((n: any) => n.id === r.nodeId)).toBe(true);
      }
      expect(new Set(ids).size).toBe(ids.length);
    });

    test("HANDLES: 5 edges, targets exist, closure → enclosing func", () => {
      const handles = edgesOf(d, "HANDLES");
      expect(handles.length).toBe(5);
      for (const e of handles) {
        expect(d.nodes.some((n: any) => n.id === e.to), `target ${e.to} exists`).toBe(true);
      }
      const closure = handles.find((e: any) => e.metadata?.handlerKind === "closure");
      expect(closure?.to).toBe("main.go::NewServer");
    });

    test("IMPLEMENTS Store→Lister (go/types), EXTENDS User→Base", () => {
      const impl = edgesOf(d, "IMPLEMENTS");
      expect(impl).toHaveLength(1);
      expect(impl[0].from).toBe("internal/users/users.go::Store");
      expect(impl[0].to).toBe("internal/users/users.go::Lister");
      const ext = edgesOf(d, "EXTENDS");
      expect(ext).toHaveLength(1);
      expect(ext[0].from).toBe("internal/users/users.go::User");
      expect(ext[0].to).toBe("internal/users/users.go::Base");
    });

    test("TESTS: leaf TEST node → production symbols", () => {
      const tests = edgesOf(d, "TESTS");
      expect(tests).toHaveLength(2);
      const targets = tests.map((e: any) => e.to).sort();
      expect(targets).toEqual([
        "internal/users/users.go::NewStore",
        "internal/users/users.go::Store.Add",
      ]);
      const testFile = nodesOf(d, (n) => n.type === "TEST");
      expect(testFile).toHaveLength(1);
      expect(testFile[0].metadata.testCases.sort()).toEqual(["TestNewStore", "TestStore_Add"]);
    });

    test("CALLS: cross-package NewServer → users.NewStore", () => {
      const calls = edgesOf(d, "CALLS");
      expect(calls).toHaveLength(1);
      expect(calls[0].from).toBe("main.go::NewServer");
      expect(calls[0].to).toBe("internal/users/users.go::NewStore");
    });

    test("IMPORTS: main.go → users PACKAGE node", () => {
      const imports = edgesOf(d, "IMPORTS");
      expect(imports).toHaveLength(1);
      expect(imports[0].from).toBe("file::main.go");
      expect(imports[0].to).toBe("pkg::github.com/example/nethttpfix/internal/users");
    });

    test("ENUM node: Status with iota constants", () => {
      const enums = nodesOf(d, (n) => n.type === "ENUM");
      expect(enums).toHaveLength(1);
      expect(enums[0].id).toBe("handlers.go::Status");
      expect(enums[0].metadata.constants.sort()).toEqual(["Active", "Banned", "Inactive"]);
    });

    test("rawCode + codeHash on every code node", () => {
      for (const n of nodesOf(d, (n) => ["FUNCTION", "METHOD", "STRUCT", "INTERFACE"].includes(n.type))) {
        expect(typeof n.rawCode).toBe("string");
        expect(n.rawCode.length).toBeGreaterThan(0);
        expect(typeof n.codeHash).toBe("string");
        expect(n.codeHash).toHaveLength(16);
        expect(n.parentFile).toBe("file::" + n.filePath);
      }
    });

    test("zero third-party nodes without gating", () => {
      expect(nodesOf(d, (n) => n.type === "THIRD_PARTY")).toHaveLength(0);
    });
  });

  // ── ginfix (Gin + GORM app) ──────────────────────────────────────────
  describe("ginfix fixture", () => {
    const d = analyze("ginfix");

    test("fingerprint: gin/backend + gorm", () => {
      expect(d.fingerprint.language).toBe("go");
      expect(d.fingerprint.framework).toBe("gin");
      expect(d.fingerprint.projectType).toBe("backend");
      expect(d.fingerprint.databases).toEqual(["gorm"]);
      expect(d.fingerprint.rawDependencies["github.com/gin-gonic/gin"]).toBe("v1.10.0");
      expect(d.fingerprint.rawDependencies["gorm.io/gorm"]).toBe("v1.25.12");
    });

    test("stats: 5 files, 32 nodes, 0 errors", () => {
      expect(d.stats.totalFiles).toBe(5);
      expect(d.stats.totalNodes).toBe(32);
      expect(d.errors).toEqual([]);
    });

    test("11 routes — group prefixes composed, all verbs, closures + method value", () => {
      const routes = d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort();
      expect(routes).toEqual([
        "DELETE /api/users/{id}",
        "GET /api/users",
        "GET /api/users/{id}",
        "GET /api/v1/ping",
        "GET /app",
        "GET /health",
        "GET /info",
        "POST /api/users",
        "POST /auth/login",
        "POST /auth/logout",
        "PUT /api/users/{id}",
      ]);
      const dynamic = d.routes.filter((r: any) => r.isDynamic);
      expect(dynamic.map((r: any) => r.params).sort()).toEqual([["id"], ["id"], ["id"]]);
    });

    test("HANDLES: 11, closures → main, method value → AppHandler.HandleApp", () => {
      const handles = edgesOf(d, "HANDLES");
      expect(handles.length).toBe(11);
      for (const e of handles) {
        expect(d.nodes.some((n: any) => n.id === e.to), `target ${e.to} exists`).toBe(true);
      }
      const closures = handles.filter((e: any) => e.metadata?.handlerKind === "closure");
      expect(closures.length).toBe(2); // direct closure + var-closure (apiInfo)
      expect(closures.every((e: any) => e.to === "main.go::main")).toBe(true);
      const methodValue = handles.find((e: any) => e.metadata?.handlerKind === "method");
      expect(methodValue?.to).toBe("handlers.go::AppHandler.HandleApp");
    });

    test("GORM models: User (embed) + Order (tags) → isModel", () => {
      const models = nodesOf(d, (n) => n.metadata?.isModel === true)
        .map((n: any) => n.id)
        .sort();
      expect(models).toEqual(["models.go::Order", "models.go::User"]);
      for (const id of models) {
        const n = d.nodes.find((x: any) => x.id === id);
        expect(n.metadata.modelType).toBe("gorm");
      }
    });

    test("data layer: 3 READS_FROM + 3 WRITES_TO → User model", () => {
      const reads = edgesOf(d, "READS_FROM");
      const writes = edgesOf(d, "WRITES_TO");
      expect(reads).toHaveLength(3);
      expect(writes).toHaveLength(3);
      const methods = [...reads, ...writes].map((e: any) => e.metadata.method).sort();
      expect(methods).toEqual(["Create", "Delete", "Find", "First", "First", "Updates"]);
      for (const e of [...reads, ...writes]) {
        expect(e.to).toBe("models.go::User");
        expect(d.nodes.some((n: any) => n.id === e.from)).toBe(true);
      }
    });

    test("CALLS: main → auth.Middleware (cross-package)", () => {
      const calls = edgesOf(d, "CALLS");
      expect(calls).toHaveLength(1);
      expect(calls[0].to).toBe("internal/auth/middleware.go::Middleware");
    });

    test("third-party gating: empty options → ZERO [mod] nodes", () => {
      expect(nodesOf(d, (n) => n.type === "THIRD_PARTY")).toHaveLength(0);
    });

    describe("third-party gating (included libs)", () => {
      const g = analyze("ginfix", { includeThirdPartyLibs: ["github.com/gin-gonic/gin", "gorm.io/gorm"] });

      test("[mod] nodes + lazy members (incl. param-typed receivers) + IMPORTS edges", () => {
        const tps = nodesOf(g, (n) => n.type === "THIRD_PARTY").map((n: any) => n.id).sort();
        expect(tps).toEqual([
          "[mod]/github.com/gin-gonic/gin",
          "[mod]/github.com/gin-gonic/gin::Context.JSON",
          "[mod]/github.com/gin-gonic/gin::Context.Param",
          "[mod]/github.com/gin-gonic/gin::Context.ShouldBindJSON",
          "[mod]/github.com/gin-gonic/gin::Context.Status",
          "[mod]/github.com/gin-gonic/gin::Context.String",
          "[mod]/github.com/gin-gonic/gin::Default",
          "[mod]/gorm.io/gorm",
          "[mod]/gorm.io/gorm::Model",
        ]);
        // member edges from handler param types: c *gin.Context → Context.JSON etc.
        const memberCalls = edgesOf(g, "CALLS").filter((e: any) => e.to.includes("::Context."));
        expect(memberCalls.length).toBeGreaterThanOrEqual(5);
        const tpImports = edgesOf(g, "IMPORTS").filter((e: any) => e.to.startsWith("[mod]/"));
        expect(tpImports.length).toBe(5);
        expect(tpImports.every((e: any) => e.metadata.isThirdParty === true)).toBe(true);
      });

      test("external embed EXTENDS → gated [mod] member", () => {
        const ext = edgesOf(g, "EXTENDS");
        expect(ext.some((e: any) => e.to === "[mod]/gorm.io/gorm::Model")).toBe(true);
      });
    });
  });

  // ── plainfix (plain library: interfaces / embedding / iota) ──────────
  describe("plainfix fixture", () => {
    const d = analyze("plainfix");

    test("fingerprint: unknown/unknown (library)", () => {
      expect(d.fingerprint.language).toBe("go");
      expect(d.fingerprint.framework).toBe("unknown");
      expect(d.fingerprint.projectType).toBe("unknown");
    });

    test("stats: 2 files, 13 nodes, 0 errors", () => {
      expect(d.stats.totalFiles).toBe(2);
      expect(d.stats.totalNodes).toBe(13);
      expect(d.errors).toEqual([]);
    });

    test("IMPLEMENTS: Circle, Square, NamedCircle → Shape (method sets + promotion)", () => {
      const impl = edgesOf(d, "IMPLEMENTS").map((e: any) => [e.from, e.to]).sort();
      expect(impl).toEqual([
        ["shapes.go::Circle", "shapes.go::Shape"],
        ["shapes.go::NamedCircle", "shapes.go::Shape"],
        ["shapes.go::Square", "shapes.go::Shape"],
      ]);
    });

    test("EXTENDS: NamedCircle → Circle (embedding)", () => {
      const ext = edgesOf(d, "EXTENDS");
      expect(ext).toHaveLength(1);
      expect(ext[0].from).toBe("shapes.go::NamedCircle");
      expect(ext[0].to).toBe("shapes.go::Circle");
    });

    test("ENUM Color: Red/Green/Blue", () => {
      const enums = nodesOf(d, (n) => n.type === "ENUM");
      expect(enums).toHaveLength(1);
      expect(enums[0].id).toBe("shapes.go::Color");
      expect(enums[0].metadata.constants.sort()).toEqual(["Blue", "Green", "Red"]);
    });

    test("TESTS: TestCircle_Area → Circle.Area; unresolvable target → no edge", () => {
      const tests = edgesOf(d, "TESTS");
      expect(tests).toHaveLength(1);
      expect(tests[0].from).toBe("file::shapes_test.go");
      expect(tests[0].to).toBe("shapes.go::Circle.Area");
    });
  });

  // ── cross-fixture contract rules ──────────────────────────────────────
  describe("contract rules (all fixtures)", () => {
    test("test files are LEAF nodes — no code nodes from *_test.go", () => {
      for (const fixture of ["nethttpfix", "ginfix", "plainfix"]) {
        const d = analyze(fixture);
        const codeNodes = nodesOf(
          d,
          (n) => ["FUNCTION", "METHOD", "STRUCT", "INTERFACE", "ENUM"].includes(n.type)
        );
        const fromTests = codeNodes.filter((n: any) => n.filePath.endsWith("_test.go"));
        expect(fromTests, `${fixture}: no code nodes in test files`).toHaveLength(0);
      }
    });

    test("no duplicate edges (dedupe at assembly)", () => {
      for (const fixture of ["nethttpfix", "ginfix", "plainfix"]) {
        const d = analyze(fixture);
        const keys = d.edges.map((e: any) => `${e.from}|${e.type}|${e.to}`);
        expect(new Set(keys).size, `${fixture}: 0 duplicate edges`).toBe(keys.length);
      }
    });

    test("determinism: two runs → byte-identical stdout", () => {
      const a = runGo("nethttpfix");
      const b = runGo("nethttpfix");
      expect(a).toBe(b);
    });
  });

  // ── badfix (robustness) ───────────────────────────────────────────────
  describe("badfix fixture (syntax error)", () => {
    const d = analyze("badfix");

    test("non-fatal: errors[] entry, good file still analyzed, exit 0", () => {
      expect(d.errors.length).toBe(1);
      expect(d.errors[0].file).toBe("broken.go");
      expect(d.stats.skippedFiles).toBe(1);
      const good = nodesOf(d, (n) => n.id === "good.go::Good");
      expect(good).toHaveLength(1);
    });
  });
});

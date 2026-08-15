// Python extractor — contract tests, run under `bun test` (same as JS/TS).
//
// Black-box: spawns the venv python extractor against static fixture repos
// (extractors/python/tests/fixtures/) and asserts on the JSON contract.
// Each fixture+options combo runs ONCE (memoized) — the suite stays fast.
//
// Skipped automatically when the python venv isn't bootstrapped (postinstall
// creates it: node extractors/python/setup.mjs).

import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

const VENV_PYTHON = path.resolve(
  import.meta.dir, "../../../extractors/python/.venv/bin/python"
);
const FIXTURES = path.resolve(
  import.meta.dir, "../../../extractors/python/tests/fixtures"
);

const pythonAvailable = fs.existsSync(VENV_PYTHON);

// ─── Helpers ────────────────────────────────────────────────────────────

function runPython(fixture: string, options: Record<string, unknown> = {}) {
  const res = spawnSync(
    VENV_PYTHON, ["-m", "devlens_extractors_python"],
    {
      input: JSON.stringify({ repoPath: path.join(FIXTURES, fixture), options }),
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    }
  );
  expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
  return JSON.parse(res.stdout);
}

/** Run against an arbitrary absolute repo path (tmp dirs). */
function runPythonRepo(repoPath: string, options: Record<string, unknown> = {}) {
  const res = spawnSync(
    VENV_PYTHON, ["-m", "devlens_extractors_python"],
    {
      input: JSON.stringify({ repoPath, options }),
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    }
  );
  expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
  return JSON.parse(res.stdout);
}

const memo = new Map<string, ReturnType<typeof runPython>>();
function analyze(fixture: string, options: Record<string, unknown> = {}) {
  const key = fixture + "|" + JSON.stringify(options);
  if (!memo.has(key)) memo.set(key, runPython(fixture, options));
  return memo.get(key)!;
}

function nodesOf(d: any, pred: (n: any) => boolean) {
  return d.nodes.filter(pred);
}
function edgesOf(d: any, type: string) {
  return d.edges.filter((e: any) => e.type === type);
}

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!pythonAvailable)("python extractor (contract + fixtures)", () => {
  test("fixtures dir is present", () => {
    expect(fs.existsSync(FIXTURES)).toBe(true);
  });

  // ── smoke / contract ─────────────────────────────────────────────────
  describe("contract shape", () => {
    const emptyRepo = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-py-empty-"));
    const empty = runPythonRepo(emptyRepo);

    test("empty repo → valid empty result", () => {
      expect(Object.keys(empty).sort()).toEqual(
        ["edges", "errors", "fingerprint", "nodes", "routes", "stats"].sort()
      );
      expect(empty.nodes).toEqual([]);
      expect(empty.edges).toEqual([]);
      expect(empty.routes).toEqual([]);
      expect(empty.stats.totalFiles).toBe(0);
      expect(empty.stats.totalNodes).toBe(0);
    });

    test("fingerprint always carries the full key set", () => {
      expect(Object.keys(empty.fingerprint).sort()).toEqual(
        ["databases", "dataFetching", "framework", "language", "projectType",
         "rawDependencies", "router", "stateManagement"].sort()
      );
      expect(empty.fingerprint.language).toBe("python");
    });
  });

  // ── pyfixture (fastapi) ──────────────────────────────────────────────
  describe("pyfixture (fastapi)", () => {
    const d = analyze("pyfixture");

    test("fingerprint: fastapi/backend", () => {
      expect(d.fingerprint.framework).toBe("fastapi");
      expect(d.fingerprint.projectType).toBe("backend");
    });

    test("stats: 4 files, 11 nodes, 0 errors", () => {
      expect(d.stats.totalFiles).toBe(4);
      expect(d.stats.totalNodes).toBe(11);
      expect(d.stats.skippedFiles).toBe(0);
      expect(d.errors).toEqual([]);
    });

    test("route GET /users/{user_id} with HANDLES → get_user", () => {
      expect(d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`)).toEqual([
        "GET /users/{user_id}",
      ]);
      const handles = edgesOf(d, "HANDLES");
      expect(handles).toHaveLength(1);
      expect(handles[0].to).toBe("main.py::get_user");
      expect(handles[0].from).toContain("GET /users/{user_id}");
    });

    test("CALLS: get_user → User class (constructor call)", () => {
      const calls = edgesOf(d, "CALLS");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ from: "main.py::get_user", to: "models/user.py::User" });
    });

    test("metadata.calls captured on the caller", () => {
      const get_user = nodesOf(d, (n) => n.id === "main.py::get_user")[0];
      expect(get_user.metadata.calls).toContain("User");
      expect(get_user.metadata.params).toEqual(["user_id"]);
      expect(get_user.metadata.isAsync).toBe(false);
    });

    test("nested-scope rule: inner() is NOT a node and its calls stay out", () => {
      expect(nodesOf(d, (n) => n.id === "main.py::helper.inner")).toHaveLength(0);
      const helper = nodesOf(d, (n) => n.id === "main.py::helper")[0];
      expect(helper.metadata.calls).toEqual(["inner"]);   // inner() itself, not its body
    });

    test("test file is a LEAF node with testCases", () => {
      const testNode = nodesOf(d, (n) => n.type === "TEST")[0];
      expect(testNode.id).toBe("file::tests/test_user.py");
      expect(testNode.metadata.testCases).toEqual(["test_create"]);
      expect(nodesOf(d, (n) => n.id.startsWith("tests/test_user.py::"))).toHaveLength(0);
    });

    test("TESTS edge: test file → production User class", () => {
      const tests = edgesOf(d, "TESTS");
      expect(tests).toHaveLength(1);
      expect(tests[0]).toMatchObject({ from: "file::tests/test_user.py", to: "models/user.py::User" });
    });

    test("IMPORTS edges from FILE nodes + imports metadata", () => {
      const imports = edgesOf(d, "IMPORTS");
      expect(imports).toHaveLength(2);   // main→models.user, test_user→models.user
      // imports metadata lands on the file's child nodes
      const get_user = nodesOf(d, (n) => n.id === "main.py::get_user")[0];
      expect(get_user.metadata.imports).toContain("models/user.py");
    });

    test("rawCode present on code nodes", () => {
      const fn = nodesOf(d, (n) => n.id === "main.py::get_user")[0];
      expect(fn.rawCode).toContain("def get_user");
      expect(fn.codeHash).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  // ── djfixture (django) ───────────────────────────────────────────────
  describe("djfixture (django)", () => {
    const d = analyze("djfixture");

    test("fingerprint: django/backend via setup.py", () => {
      expect(d.fingerprint.framework).toBe("django");
      expect(d.fingerprint.projectType).toBe("backend");
    });

    test("routes composed through include(): 3 routes", () => {
      expect(d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort()).toEqual([
        "GET api/posts/<int:pk>/",
        "GET api/posts/",
        "GET users/<int:user_id>/",
      ].sort());
    });

    test("HANDLES → view functions, 0 broken", () => {
      const handles = edgesOf(d, "HANDLES");
      expect(handles).toHaveLength(3);
      const ids = new Set(d.nodes.map((n: any) => n.id));
      for (const h of handles) expect(ids.has(h.to)).toBe(true);
    });

    test("celery tasks marked isTask", () => {
      const tasks = nodesOf(d, (n) => n.metadata.isTask).map((n: any) => n.id);
      expect(tasks.sort()).toEqual(["app/tasks.py::daily_digest", "app/tasks.py::send_welcome_email"]);
    });
  });

  // ── flaskfix (flask) ─────────────────────────────────────────────────
  describe("flaskfix (flask)", () => {
    const d = analyze("flaskfix");

    test("fingerprint: flask/backend", () => {
      expect(d.fingerprint.framework).toBe("flask");
    });

    test("methods=[GET,POST] expands to 2 routes; @app.get works", () => {
      expect(d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort()).toEqual([
        "GET /health",
        "GET /users/<int:user_id>",
        "POST /users/<int:user_id>",
      ].sort());
    });

    test("HANDLES for all 3 routes", () => {
      expect(edgesOf(d, "HANDLES")).toHaveLength(3);
    });
  });

  // ── drfx (django rest framework) ─────────────────────────────────────
  describe("drfx (DRF routers)", () => {
    const d = analyze("drfx");

    test("ModelViewSet → 6 routes, ReadOnly → 2 routes (8 total)", () => {
      expect(d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort()).toEqual([
        "DELETE /api/users/{pk}/",
        "GET /api/posts/",
        "GET /api/posts/{pk}/",
        "GET /api/users/",
        "GET /api/users/{pk}/",
        "PATCH /api/users/{pk}/",
        "POST /api/users/",
        "PUT /api/users/{pk}/",
      ].sort());
    });

    test("HANDLES → viewset CLASSES (8 handlers, 2 unique targets)", () => {
      const targets = [...new Set(edgesOf(d, "HANDLES").map((e: any) => e.to))].sort();
      expect(targets).toEqual(["app/views.py::PostViewSet", "app/views.py::UserViewSet"]);
    });

    test("serializer Meta.model → linkedModel", () => {
      const ser = nodesOf(d, (n) => n.id === "app/serializers.py::UserSerializer")[0];
      expect(ser.metadata.linkedModel).toBe("User");
    });

    test("models detected when django is gated", () => {
      const g = analyze("drfx", { includeThirdPartyLibs: ["django", "djangorestframework"] });
      const models = nodesOf(g, (n) => n.metadata.isModel).map((n: any) => n.id).sort();
      expect(models).toEqual(["app/models.py::Post", "app/models.py::User"]);
    });
  });

  // ── ormfix (sqlalchemy + pydantic + fastapi) ─────────────────────────
  describe("ormfix (sqlalchemy data layer)", () => {
    test("no gating → no third-party nodes, no models (base chain unresolvable)", () => {
      const d = analyze("ormfix");
      expect(nodesOf(d, (n) => n.type === "THIRD_PARTY")).toHaveLength(0);
      expect(nodesOf(d, (n) => n.metadata.isModel)).toHaveLength(0);
      expect(edgesOf(d, "READS_FROM").concat(edgesOf(d, "WRITES_TO"))).toHaveLength(0);
    });

    const d = analyze("ormfix", { includeThirdPartyLibs: ["sqlalchemy", "pydantic"] });

    test("models: Base/User/Post → sqlalchemy", () => {
      const models = nodesOf(d, (n) => n.metadata.isModel).map((n: any) => ({
        id: n.id, type: n.metadata.modelType,
      })).sort((a: any, b: any) => a.id.localeCompare(b.id));
      expect(models).toEqual([
        { id: "models.py::Base", type: "sqlalchemy" },
        { id: "models.py::Post", type: "sqlalchemy" },
        { id: "models.py::User", type: "sqlalchemy" },
      ]);
    });

    test("R/W edges: consumer → store, exact direction", () => {
      const rw = d.edges
        .filter((e: any) => e.type === "READS_FROM" || e.type === "WRITES_TO")
        .map((e: any) => `${e.from} ${e.type} ${e.to}`)
        .sort();
      expect(rw).toEqual([
        "crud.py::create_user WRITES_TO models.py::User",
        "crud.py::get_user READS_FROM models.py::User",
        "crud.py::list_posts READS_FROM models.py::Post",
      ].sort());
    });

    test("pydantic schemas → isSchema", () => {
      expect(nodesOf(d, (n) => n.metadata.isSchema).map((n: any) => n.id).sort()).toEqual([
        "schemas.py::UserCreate", "schemas.py::UserOut",
      ]);
    });

    test("routes + call chain intact under gating", () => {
      expect(d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort()).toEqual([
        "GET /users/{user_id}", "POST /users",
      ].sort());
      const calls = edgesOf(d, "CALLS");
      // 5 local edges + 1 gated [pip] target (select → [pip]/sqlalchemy::select)
      expect(calls).toHaveLength(6);
      expect(calls.some((e: any) => e.to === "[pip]/sqlalchemy::select")).toBe(true);
    });
  });

  // ── third-party gating ───────────────────────────────────────────────
  describe("third-party gating", () => {
    test("empty options → ZERO third-party nodes", () => {
      const d = analyze("flaskfix");
      expect(nodesOf(d, (n) => n.type === "THIRD_PARTY")).toHaveLength(0);
    });

    test("includeThirdPartyLibs (engine spelling) → [pip] nodes + IMPORTS", () => {
      const d = analyze("flaskfix", { includeThirdPartyLibs: ["flask"] });
      const tp = nodesOf(d, (n) => n.type === "THIRD_PARTY").map((n: any) => n.id);
      expect(tp).toContain("[pip]/flask");
      // named from-import → edge to the MEMBER node
      const imports = edgesOf(d, "IMPORTS").filter((e: any) => e.to.startsWith("[pip]/flask"));
      expect(imports).toHaveLength(1);
      expect(imports[0].to).toBe("[pip]/flask::Flask");
    });

    test("includedThirdPartyLibs (docs spelling) also accepted", () => {
      const d = analyze("flaskfix", { includedThirdPartyLibs: ["flask"] });
      expect(nodesOf(d, (n) => n.type === "THIRD_PARTY").length).toBeGreaterThan(0);
    });
  });

  // ── robustness ───────────────────────────────────────────────────────
  describe("robustness", () => {
    test("syntax-error file → errors[] entry, other files still analyzed, exit 0", () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-py-broken-"));
      fs.writeFileSync(path.join(repo, "good.py"), "def ok():\n    return 1\n");
      fs.writeFileSync(path.join(repo, "broken.py"), "def nope(:\n    pass\n");
      const res = spawnSync(
        VENV_PYTHON, ["-m", "devlens_extractors_python"],
        { input: JSON.stringify({ repoPath: repo, options: {} }), encoding: "utf8" }
      );
      const d = JSON.parse(res.stdout);
      expect(res.status).toBe(0);
      expect(d.errors.length).toBe(1);
      expect(d.errors[0].file).toBe("broken.py");
      expect(d.stats.totalFiles).toBe(2);
      expect(d.stats.skippedFiles).toBe(1);   // parse failures count as skipped
      expect(nodesOf(d, (n) => n.id === "good.py::ok")).toHaveLength(1);
      fs.rmSync(repo, { recursive: true, force: true });
    });

    test("determinism: two runs → byte-identical stdout", () => {
      const opts = { includeThirdPartyLibs: ["sqlalchemy", "pydantic"] };
      const a = runPython("ormfix", opts);
      const b = runPython("ormfix", opts);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });
});

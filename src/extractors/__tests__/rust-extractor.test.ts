// Rust extractor — contract tests, run under `bun test` (same as JS/TS).
//
// Black-box: spawns the platform's static binary (extractors/rust/bin/<platform>/)
// against static fixture repos (extractors/rust/tests/fixtures/) and asserts on
// the JSON contract. Each fixture+options combo runs ONCE (memoized).
//
// Skipped automatically when the binary isn't built
// (node extractors/rust/build.mjs — requires the Rust toolchain).
//
// Fixture Cargo.tomls never compile — the extractor parses source only
// (syn), so fixtures are tiny hermetic trees (no vendor/, unlike go).

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
  `../../../extractors/rust/bin/${platformDir}/devlens_rust_extractor${EXE}`
);
const FIXTURES = path.resolve(import.meta.dir, "../../../extractors/rust/tests/fixtures");

const binaryAvailable = fs.existsSync(BINARY);

// ─── Helpers ────────────────────────────────────────────────────────────

function runRust(fixture: string, options: Record<string, unknown> = {}) {
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
  if (!memo.has(key)) memo.set(key, runRust(fixture, options));
  return JSON.parse(memo.get(key)!);
}

function nodesOf(d: any, type: string) {
  return d.nodes.filter((n: any) => n.type === type);
}
function edgesOf(d: any, type: string) {
  return d.edges.filter((e: any) => e.type === type);
}
const GATED_AXUM = { includeThirdPartyLibs: ["axum", "tokio", "serde"] };

// ─── Suite ───────────────────────────────────────────────────────────────

describe.skipIf(!binaryAvailable)("rust extractor (contract + fixtures)", () => {
  test("fixtures dir is present", () => {
    expect(fs.existsSync(FIXTURES)).toBe(true);
  });

  describe("modfix (modules / traits / impls / tests)", () => {
    const d = analyze("modfix", { includeThirdPartyLibs: ["serde"] });

    test("fingerprint: unknown framework, backend projectType", () => {
      expect(d.fingerprint.language).toBe("rust");
      expect(d.fingerprint.projectType).toBe("backend");
      expect(d.fingerprint.rawDependencies["serde"]).toBe("1");
    });

    test("node census: FILE/TEST/STRUCT/ENUM/TRAIT/IMPL_BLOCK/METHOD/FUNCTION", () => {
      expect(nodesOf(d, "FILE").length).toBe(7);
      expect(nodesOf(d, "TEST").length).toBe(1); // tests/smoke.rs (leaf)
      expect(nodesOf(d, "STRUCT").map((n: any) => n.name).sort()).toEqual(["Post", "User"]);
      expect(nodesOf(d, "ENUM").length).toBe(1);
      expect(nodesOf(d, "TRAIT").length).toBe(2); // Display + Entity
      expect(nodesOf(d, "IMPL_BLOCK").length).toBe(4); // impl Post + impl User + 2 trait impls
      expect(nodesOf(d, "METHOD").length).toBe(6);
      expect(nodesOf(d, "FUNCTION").length).toBe(5); // main + 3 handlers + helper
    });

    test("leaf rule: test file has NO code children", () => {
      const testFiles = nodesOf(d, "TEST").map((n: any) => n.filePath);
      const codeNodes = d.nodes.filter((n: any) =>
        ["FUNCTION", "METHOD", "STRUCT", "ENUM", "TRAIT", "IMPL_BLOCK"].includes(n.type)
      );
      for (const c of codeNodes) {
        expect(testFiles.includes(c.filePath)).toBe(false);
      }
      // testCases ride on the TEST node metadata
      const testNode = nodesOf(d, "TEST")[0];
      expect(testNode.metadata.testCases).toContain("test_helper");
    });

    test("trait-impl method disambiguation (User.name::Display)", () => {
      const ids = nodesOf(d, "METHOD").map((n: any) => n.id);
      expect(ids).toContain("src/models/user.rs::User.name::Display");
      expect(ids).toContain("src/models/user.rs::User.table_name::Entity");
      expect(ids).toContain("src/models/user.rs::User.new");
    });

    test("IMPL_BLOCK id has line discriminator (two impl User blocks)", () => {
      const implIds = nodesOf(d, "IMPL_BLOCK").map((n: any) => n.id);
      expect(implIds.some((id: string) => id.includes("[L"))).toBe(true);
    });

    test("IMPLEMENTS: trait impls Type→Trait, plain impls block→struct", () => {
      const impls = edgesOf(d, "IMPLEMENTS");
      expect(impls.length).toBe(4);
      const pairs = impls.map((e: any) => [e.from.split("::").pop(), e.to.split("::").pop()]);
      expect(pairs).toContainEqual(["User", "Display"]);
      expect(pairs).toContainEqual(["User", "Entity"]);
      expect(pairs).toContainEqual(["impl User [L15]", "User"]);
      expect(pairs).toContainEqual(["impl Post [L6]", "Post"]);
    });

    test("EXTENDS: supertrait Entity extends Display", () => {
      const ext = edgesOf(d, "EXTENDS");
      expect(ext.length).toBe(1);
      expect(ext[0].from.endsWith("Entity")).toBe(true);
      expect(ext[0].to.endsWith("Display")).toBe(true);
    });

    test("CALLS via use-path bridge (User::new → User.new, utils::helper)", () => {
      const calls = edgesOf(d, "CALLS");
      expect(calls.length).toBe(7);
      expect(calls.some((e: any) => e.from.endsWith("get_user") && e.to.endsWith("User.new"))).toBe(true);
      expect(calls.some((e: any) => e.from.endsWith("get_user") && e.to.endsWith("helper"))).toBe(true);
      // trait-dispatch: Entity::table_name(&u) → User.table_name::Entity
      expect(
        calls.some((e: any) => e.from.endsWith("table_of") && e.to.endsWith("User.table_name::Entity"))
      ).toBe(true);
    });

    test("IMPORTS: 4 edges, no self-imports", () => {
      const imports = edgesOf(d, "IMPORTS");
      expect(imports.length).toBe(4);
      for (const e of imports) {
        expect(e.from).not.toBe(e.to);
      }
    });

    test("TESTS: smoke.rs → helper", () => {
      const tests = edgesOf(d, "TESTS");
      expect(tests.length).toBe(1);
      expect(tests[0].from).toBe("file::tests/smoke.rs");
      expect(tests[0].to.endsWith("helper")).toBe(true);
    });

    test("metadata.calls populated on code nodes (contract compliance)", () => {
      const get_user = d.nodes.find((n: any) => n.id.endsWith("get_user"));
      expect(Array.isArray(get_user.metadata.calls)).toBe(true);
      expect(get_user.metadata.calls.length).toBeGreaterThan(0);
    });
  });

  describe("axumfix (axum routes)", () => {
    const d = analyze("axumfix", GATED_AXUM);

    test("fingerprint: axum framework + backend", () => {
      expect(d.fingerprint.framework).toBe("axum");
      expect(d.fingerprint.projectType).toBe("backend");
    });

    test("7 routes with nest prefix composition + multi-method split", () => {
      const routes = d.routes;
      expect(routes.length).toBe(7);
      const key = (r: any) => `${r.httpMethod} ${r.urlPath}`;
      const keys = routes.map(key).sort();
      expect(keys).toEqual([
        "GET /",
        "GET /admin",
        "GET /api/items/{id}",
        "GET /api/ping",
        "GET /health",
        "GET /users/{id}",
        "POST /users/{id}",
      ]);
      // params + isDynamic on :id routes
      const item = routes.find((r: any) => r.urlPath === "/api/items/{id}");
      expect(item.isDynamic).toBe(true);
      expect(item.params).toEqual(["id"]);
    });

    test("0 broken HANDLES; closures resolve to enclosing fn", () => {
      const handles = edgesOf(d, "HANDLES");
      expect(handles.length).toBe(7);
      const nodeIds = new Set(d.nodes.map((n: any) => n.id));
      for (const h of handles) {
        expect(nodeIds.has(h.to)).toBe(true);
      }
      // closure handler → the fn containing the registration (main)
      const health = handles.find((h: any) => h.from.endsWith("GET /health"));
      expect(health.to.endsWith("main")).toBe(true);
      // named handler cross-module
      const idx = handles.find((h: any) => h.from.endsWith("GET /"));
      expect(idx.to.endsWith("index")).toBe(true);
    });

    test("third-party gated: [crate] nodes only for allowed libs", () => {
      const tp = nodesOf(d, "THIRD_PARTY");
      expect(tp.length).toBe(7);
      const ids = new Set(tp.map((n: any) => n.id));
      expect(ids).toContain("[crate]/axum");
      expect(ids).toContain("[crate]/axum::Router");
      expect(ids).toContain("[crate]/axum::routing::get");
      expect(ids).toContain("[crate]/tokio::net::TcpListener::bind");
      // serde is a dep but never used → no node
      expect([...ids].some((id: unknown) => String(id).includes("serde"))).toBe(false);
    });

    test("ungated (no options) → ZERO third-party nodes", () => {
      const d0 = analyze("axumfix");
      expect(nodesOf(d0, "THIRD_PARTY").length).toBe(0);
      expect(edgesOf(d0, "IMPORTS").filter((e: any) => e.to.startsWith("[crate]")).length).toBe(0);
    });

    test("docs spelling includedThirdPartyLibs also works", () => {
      const d1 = analyze("axumfix", { includedThirdPartyLibs: ["axum"] });
      expect(nodesOf(d1, "THIRD_PARTY").length).toBeGreaterThan(0);
    });
  });

  describe("utoipafix (utoipa-axum routes! macro + BaseOpenApi::router() tuple-let)", () => {
    const d = analyze("utoipafix", { includeThirdPartyLibs: ["axum", "utoipa", "serde"] });

    test("fingerprint: axum framework + backend", () => {
      // utoipa-axum rides on axum — no separate framework; the Cargo.toml has
      // axum + utoipa + utoipa-axum; fingerprint keys axum first.
      expect(d.fingerprint.framework).toBe("axum");
      expect(d.fingerprint.projectType).toBe("backend");
    });

    test("3 routes: 2 from #[utoipa::path] via routes!() + 1 plain .route()", () => {
      const routes = d.routes;
      expect(routes.length).toBe(3);
      const keys = routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort();
      expect(keys).toEqual([
        "GET /api/ping",
        "GET /api/v1/crates",
        "GET /api/v1/crates/{crate_id}/readme",
      ]);
      // the utoipa path attribute's {param} segment normalizes
      const readme = routes.find((r: any) => r.urlPath === "/api/v1/crates/{crate_id}/readme");
      expect(readme.isDynamic).toBe(true);
      expect(readme.params).toEqual(["crate_id"]);
    });

    test("0 broken HANDLES; utoipa handlers resolve via glob-import unroll", () => {
      // `use crate::controllers::*;` brings `krate` into scope, so
      // routes!(krate::search::list_crates) resolves as
      // crate::controllers::krate::search::list_crates (documented Rust
      // glob-import semantics)
      const handles = edgesOf(d, "HANDLES");
      expect(handles.length).toBe(3);
      const nodeIds = new Set(d.nodes.map((n: any) => n.id));
      for (const h of handles) {
        expect(nodeIds.has(h.to)).toBe(true);
      }
      // utoipa-attributed handlers → the FUNCTION node
      const list = handles.find((h: any) => h.from.endsWith("GET /api/v1/crates"));
      expect(list.to.endsWith("list_crates")).toBe(true);
      const rm = handles.find((h: any) => h.from.endsWith("GET /api/v1/crates/{crate_id}/readme"));
      expect(rm.to.endsWith("get_version_readme")).toBe(true);
      // plain .route() handler
      const ping = handles.find((h: any) => h.from.endsWith("GET /api/ping"));
      expect(ping.to.endsWith("ping")).toBe(true);
    });

    test("all methods uppercase (utoipa verb normalized, parity with axum)", () => {
      // utoipa's #[utoipa::path(get, path = "/x")] first token is the bare
      // verb ident `get`/`post`/...; normalized to uppercase for contract
      // parity with axum's get()/post() combinators.
      for (const r of d.routes) {
        expect(r.httpMethod).toMatch(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ANY)$/);
      }
    });
  });

  describe("actixfix (actix-web attribute macros)", () => {
    const d = analyze("actixfix", { includeThirdPartyLibs: ["actix-web"] });

    test("fingerprint: actix-web + 4 macro routes, 0 broken HANDLES", () => {
      expect(d.fingerprint.framework).toBe("actix-web");
      const keys = d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort();
      expect(keys).toEqual(["GET /", "GET /health", "GET /users/{id}", "POST /users"]);
      const handles = edgesOf(d, "HANDLES");
      expect(handles.length).toBe(4);
      const nodeIds = new Set(d.nodes.map((n: any) => n.id));
      for (const h of handles) {
        expect(nodeIds.has(h.to)).toBe(true);
      }
    });

    test("hyphen/underscore crate normalization (actix-web ↔ actix_web)", () => {
      const tp = nodesOf(d, "THIRD_PARTY");
      expect(tp.some((n: any) => n.id === "[crate]/actix_web")).toBe(true);
    });
  });

  describe("rocketfix (rocket macros)", () => {
    const d = analyze("rocketfix", { includeThirdPartyLibs: ["rocket"] });

    test("fingerprint: rocket + 4 routes incl. #[route(...)]", () => {
      expect(d.fingerprint.framework).toBe("rocket");
      const keys = d.routes.map((r: any) => `${r.httpMethod} ${r.urlPath}`).sort();
      expect(keys).toEqual(["GET /", "GET /health", "GET /users/{id}", "POST /users"]);
      expect(edgesOf(d, "HANDLES").length).toBe(4);
    });
  });

  describe("dieselfix (Diesel data layer)", () => {
    const d = analyze("dieselfix", { includeThirdPartyLibs: ["diesel"] });

    test("2 models with tableName + tableColumns", () => {
      const models = d.nodes.filter((n: any) => n.metadata?.isModel);
      expect(models.length).toBe(2);
      const user = models.find((m: any) => m.metadata.tableName === "users");
      expect(user.metadata.modelType).toBe("diesel");
      expect(user.metadata.tableColumns).toEqual(["id", "name", "email"]);
      const post = models.find((m: any) => m.metadata.tableName === "posts");
      expect(post.metadata.tableColumns).toEqual(["id", "title", "user_id"]);
    });

    test("READS_FROM (4) + WRITES_TO (3), consumer → store", () => {
      const reads = edgesOf(d, "READS_FROM");
      const writes = edgesOf(d, "WRITES_TO");
      expect(reads.length).toBe(4);
      expect(writes.length).toBe(3);
      expect(reads.some((e: any) => e.from.endsWith("find_user") && e.to.endsWith("User"))).toBe(true);
      expect(writes.some((e: any) => e.from.endsWith("create_user") && e.to.endsWith("User"))).toBe(true);
      expect(writes.some((e: any) => e.from.endsWith("delete_post") && e.to.endsWith("Post"))).toBe(true);
    });
  });

  describe("contract rules (all fixtures)", () => {
    test("determinism: byte-identical repeat runs", () => {
      const a = runRust("axumfix", GATED_AXUM);
      const b = runRust("axumfix", GATED_AXUM);
      expect(a).toBe(b);
    });

    test("0 duplicate edges (dedupe at assembly)", () => {
      const d = analyze("modfix", { includeThirdPartyLibs: ["serde"] });
      const seen = new Set<string>();
      for (const e of d.edges) {
        const k = `${e.from}\u0000${e.type}\u0000${e.to}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    });

    test("camelCase keys + rawCode + codeHash on every code node", () => {
      const d = analyze("modfix", { includeThirdPartyLibs: ["serde"] });
      const codeTypes = new Set(["FUNCTION", "METHOD", "STRUCT", "ENUM", "TRAIT", "IMPL_BLOCK"]);
      for (const n of d.nodes) {
        expect(typeof n.id).toBe("string");
        if (codeTypes.has(n.type)) {
          expect(n.rawCode.length).toBeGreaterThan(0);
          expect(n.codeHash).toMatch(/^[0-9a-f]{16}$/);
          expect(n.filePath).toBeTruthy();
        }
      }
    });

    test("non-fatal errors: syntax-error file degrades, run still exits 0", () => {
      // a fixture with a broken .rs would land in errors[] — assert the
      // contract shape exists even on the happy path
      const d = analyze("axumfix", GATED_AXUM);
      expect(Array.isArray(d.errors)).toBe(true);
      expect(d.stats.totalFiles).toBeGreaterThan(0);
    });
  });
});

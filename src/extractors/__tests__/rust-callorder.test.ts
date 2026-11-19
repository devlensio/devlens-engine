import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

// Rust callOrder/v1 conformance. docs/CALL_ORDER.md §6.

const platformDir =
  process.platform === "win32"
    ? "windows-amd64"
    : process.platform === "darwin"
      ? `darwin-${process.arch === "arm64" ? "arm64" : "amd64"}`
      : `linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
const EXE = process.platform === "win32" ? ".exe" : "";
const BINARY = path.resolve(
  import.meta.dir,
  `../../../extractors/rust/bin/${platformDir}/devlens_rust_extractor${EXE}`,
);
const binaryAvailable = fs.existsSync(BINARY);

function analyze(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-callorder-rust-"));
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const res = spawnSync(BINARY, [], {
    input: JSON.stringify({ repoPath: dir, options: {} }),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
  return JSON.parse(res.stdout);
}

function fnOf(d: any, name: string) {
  const node = d.nodes.find((n: any) => n.name === name);
  if (!node) throw new Error(`node not found: ${name}`);
  return node;
}

function sitesOf(d: any, name: string): any[] {
  return fnOf(d, name).metadata.callSites ?? [];
}

function siteOf(d: any, name: string, callName: string) {
  return sitesOf(d, name).find((s) => s.name === callName);
}

const SOURCE = `
fn a() {}
fn b() {}
fn seq() {
    a();
    b();
    a();
}
fn caller() {
    seq();
}
fn branches(flag: bool) {
    if flag { a(); }
    for _ in 0..2 { b(); }
}
async fn async_work() {
    a().await;
    b();
}
struct E;
fn fallible() -> Result<(), E> {
    a()?;
    b();
    Ok(())
}
fn closures(items: Vec<u64>) {
    items.iter().map(|x| a());
    let f = || b();
    f();
}
fn noisy() {
    println!("hello");
    a();
}
`;

describe.skipIf(!binaryAvailable)("rust callOrder/v1", () => {
  const d = analyze({
    "Cargo.toml": `[package]\nname = "callorder"\nversion = "0.1.0"\n`,
    "src/lib.rs": SOURCE,
  });

  test("sequential calls keep one record per occurrence, in order", () => {
    expect(sitesOf(d, "seq").map((s) => [s.name, s.order])).toEqual([
      ["a", 1], ["b", 2], ["a", 3],
    ]);
  });

  test("metadata.calls stays the name-deduped set", () => {
    expect(fnOf(d, "seq").metadata.calls.sort()).toEqual(["a", "b"]);
  });

  test("every site carries kind, line, col and scope", () => {
    for (const site of sitesOf(d, "seq")) {
      expect(site.kind).toBe("call");
      expect(typeof site.line).toBe("number");
      expect(typeof site.col).toBe("number");
      expect(site.scope).toBe("inline");
    }
  });

  test("a plain cross-function call starts at one", () => {
    expect(siteOf(d, "caller", "seq")).toMatchObject({ order: 1, scope: "inline" });
  });

  test("branch call is maybe, loop call is repeat", () => {
    expect(siteOf(d, "branches", "a")).toMatchObject({ maybe: true });
    expect(siteOf(d, "branches", "b")).toMatchObject({ repeat: true });
  });

  test(".await marks the call as suspending the frame", () => {
    expect(siteOf(d, "async_work", "a")).toMatchObject({ awaited: true, order: 1 });
    expect(siteOf(d, "async_work", "b")).toMatchObject({ order: 2 });
  });

  test("? marks the call as able to abort the block", () => {
    expect(siteOf(d, "fallible", "a")).toMatchObject({ earlyExit: true, order: 1 });
    expect(siteOf(d, "fallible", "b")).toMatchObject({ order: 2 });
  });

  test("an iterator closure is a repeated callback", () => {
    expect(siteOf(d, "closures", "a")).toMatchObject({ scope: "callback", repeat: true });
  });

  test("a closure bound to a let is a nested region", () => {
    expect(siteOf(d, "closures", "b")).toMatchObject({ scope: "nested" });
  });

  test("a macro invocation is not a call site", () => {
    expect(sitesOf(d, "noisy").map((s) => s.name)).toEqual(["a"]);
  });

  test("orders are contiguous, unique and monotone inside a function", () => {
    const sites = sitesOf(d, "seq");
    expect(sites.map((s) => s.order)).toEqual([1, 2, 3]);
    for (let i = 1; i < sites.length; i++) {
      const prev = sites[i - 1];
      const cur = sites[i];
      expect(cur.line > prev.line || (cur.line === prev.line && cur.col > prev.col)).toBe(true);
    }
  });

  test("resolvedCalls matches the shared ResolvedCall shape", () => {
    const resolved = fnOf(d, "seq").metadata.resolvedCalls as any[];
    const allowed = ["name", "nodeId", "firstOrder", "line", "defer", "deferDetail",
                     "awaited", "conc", "repeat", "maybe", "orders"];

    expect(resolved.map((r) => r.name)).toEqual(["a", "b"]);
    for (const entry of resolved) {
      for (const key of Object.keys(entry)) expect(allowed).toContain(key);
      expect(entry.nodeId).toMatch(/::[ab]$/);
      expect(typeof entry.firstOrder).toBe("number");
      expect(typeof entry.line).toBe("number");
    }
    expect(resolved[0].firstOrder).toBe(1);
    expect(resolved[0].orders).toEqual([1, 3]);
    expect(resolved[1].orders).toBeUndefined();
  });

  test("every CALLS edge target is present in resolvedCalls", () => {
    for (const name of ["seq", "caller", "branches", "async_work", "fallible", "closures"]) {
      const node = fnOf(d, name);
      const rc = (node.metadata.resolvedCalls ?? []) as any[];
      const targets = new Set(rc.map((r) => r.nodeId));
      const edgeTargets = d.edges
        .filter((e: any) => e.type === "CALLS" && e.from === node.id)
        .map((e: any) => e.to);
      for (const target of edgeTargets) expect(targets.has(target)).toBe(true);
    }
  });
});

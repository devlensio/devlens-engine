// Go extractor — callOrder/v1 conformance (docs/CALL_ORDER.md §6).
//
// Black-box like go-extractor.test.ts: a throwaway Go module is written to a
// temp dir, the platform binary runs against it once, and every assertion reads
// the emitted node/edge metadata. Test titles carry the conformance item
// numbers from the frozen contract.
//
// Skipped automatically when the binary isn't built
// (node extractors/go/build.mjs — requires the Go toolchain).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
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
const binaryAvailable = fs.existsSync(BINARY);

// One function per conformance shape; line numbers in the assertions are
// derived from the records themselves, never hard-coded.
const FIXTURE = `package main

import "time"

type Store struct{}

func (s *Store) Save() {}

func a() {}
func b() {}
func c() {}
func f(n int) {}
func each(items []int, fn func(int)) {}
func sumAll(vals ...int) int { return 0 }
func outer(n int) {}
func mid(n int) int          { return n }
func inner() int             { return 0 }

// 1 — sequential
func seq() {
\t a()
\t b()
\t c()
}

// 2 — the same target twice
func dup() {
\t a()
\t b()
\t a()
}

// 3 — same name, different arity
func arity() {
\t f(1)
\t f(1, 2)
}

// 4 / 5 — nested and deeply nested calls
func nestedCall() {
\t outer(mid(inner()))
}

// 6 — no calls at all
func quiet() {}

// 8 / 28 — calls inside branches and loops
func blocks(n int) {
\t if n > 0 {
\t\t a()
\t } else {
\t\t b()
\t }
\t for i := 0; i < n; i++ {
\t\t c()
\t }
}

// 9 — two statements on one line
func oneLine() { a(); b() }

// 19 — closure in a variable initializer
func closureVar() {
\t h := func() { a() }
\t h()
}

// 20 — closure passed to a call
func callbackArg(items []int) {
\t each(items, func(x int) { b() })
}

// 20 + repeat — the callback is registered once per iteration
func loopCallback(items []int) {
\t for range items {
\t\t each(items, func(x int) { a() })
\t }
}

// a method call on a receiver
func methodCall(s *Store) {
\t s.Save()
}

// variadic spread
func spread(vals []int) int {
\t return sumAll(vals...)
}

// 29 — go f() is concurrent, defer f() runs at frame exit
func goDefer() {
\t go a()
\t defer b()
}

// maybe — the block behind a terminating guard
func guarded(err error) {
\t if err != nil {
\t\t return
\t }
\t a()
}

// defer:timer — time.AfterFunc callback
func timerCallback() {
\t time.AfterFunc(time.Second, func() { a() })
}

// defer:event — func value received from a channel
func chanCallback(cbCh chan func()) {
\t cb := <-cbCh
\t cb()
}

// 21 — module-scope call
var moduleValue = startModule()

func startModule() int { return 0 }

func main() {
\t a()
}
`;

interface CallSite {
  name: string;
  argCount: number;
  argTypes: string[];
  hasSpread?: boolean;
  order: number;
  line: number;
  col: number;
  nested?: number;
  scope: string;
  defer?: string;
  deferDetail?: string;
  conc?: boolean;
  repeat?: boolean;
  maybe?: boolean;
  earlyExit?: boolean;
}

describe.skipIf(!binaryAvailable)("go callOrder/v1 (docs/CALL_ORDER.md §6)", () => {
  let repoDir = "";
  let result: any = null;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-go-callorder-"));
    fs.writeFileSync(path.join(repoDir, "go.mod"), "module callorderfix\n\ngo 1.21\n");
    fs.writeFileSync(path.join(repoDir, "main.go"), FIXTURE);
    const res = spawnSync(BINARY, [], {
      input: JSON.stringify({ repoPath: repoDir, options: {} }),
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    });
    expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
    result = JSON.parse(res.stdout);
  });

  afterAll(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  function node(id: string) {
    const n = result.nodes.find((x: any) => x.id === id);
    expect(n, `${id} exists`).toBeDefined();
    return n;
  }
  function sites(id: string): CallSite[] {
    return node(id).metadata.callSites;
  }
  function names(id: string): string[] {
    return sites(id).map((s) => s.name);
  }
  function orders(id: string): number[] {
    return sites(id).map((s) => s.order);
  }

  test("1 — sequential a(); b(); c() → orders 1,2,3", () => {
    expect(names("main.go::seq")).toEqual(["a", "b", "c"]);
    expect(orders("main.go::seq")).toEqual([1, 2, 3]);
    for (const s of sites("main.go::seq")) expect(s.scope).toBe("inline");
  });

  test("2 — the same target twice keeps two records (orders 1,2,3)", () => {
    expect(names("main.go::dup")).toEqual(["a", "b", "a"]);
    expect(orders("main.go::dup")).toEqual([1, 2, 3]);
    // metadata.calls is still the name-deduped set
    expect(node("main.go::dup").metadata.calls).toEqual(["a", "b"]);
  });

  test("3 — same name, different arity → two records", () => {
    const s = sites("main.go::arity");
    expect(s.map((x) => [x.name, x.argCount])).toEqual([
      ["f", 1],
      ["f", 2],
    ]);
    expect(s.map((x) => x.order)).toEqual([1, 2]);
  });

  test("4 / 5 — nested and deep nesting: each .nested is the enclosing order", () => {
    const s = sites("main.go::nestedCall");
    expect(s.map((x) => x.name)).toEqual(["outer", "mid", "inner"]);
    expect(s.map((x) => x.order)).toEqual([1, 2, 3]);
    expect(s[0].nested).toBeUndefined();
    expect(s[1].nested).toBe(s[0].order);
    expect(s[2].nested).toBe(s[1].order);
  });

  test("6 — no calls → empty callSites", () => {
    expect(node("main.go::quiet").metadata.callSites).toEqual([]);
  });

  test("8 — calls inside if/for blocks stay in lexical order", () => {
    expect(names("main.go::blocks")).toEqual(["a", "b", "c"]);
    expect(orders("main.go::blocks")).toEqual([1, 2, 3]);
  });

  test("9 — two statements on one line → distinct col, orders 1,2", () => {
    const s = sites("main.go::oneLine");
    expect(s.map((x) => x.name)).toEqual(["a", "b"]);
    expect(s.map((x) => x.order)).toEqual([1, 2]);
    expect(s[0].line).toBe(s[1].line);
    expect(s[0].col).toBeLessThan(s[1].col);
  });

  test("19 — closure in a variable initializer → scope nested", () => {
    const s = sites("main.go::closureVar");
    expect(s.map((x) => x.name)).toEqual(["a", "h"]);
    expect(s[0].scope).toBe("nested");
    expect(s[0].nested).toBeUndefined(); // a closure is a frame boundary
    expect(s[1].scope).toBe("inline");
  });

  test("20 — closure passed to a call → scope callback; loops make it repeat", () => {
    const cb = sites("main.go::callbackArg");
    expect(cb.map((x) => x.name)).toEqual(["each", "b"]);
    expect(cb[0].scope).toBe("inline");
    expect(cb[1].scope).toBe("callback");
    expect(cb[1].nested).toBeUndefined();
    expect(cb[1].repeat).toBeUndefined();

    const loop = sites("main.go::loopCallback");
    expect(loop.map((x) => x.name)).toEqual(["each", "a"]);
    expect(loop[0].repeat).toBe(true); // range body
    expect(loop[1].scope).toBe("callback");
    expect(loop[1].repeat).toBe(true); // registered once per iteration
  });

  test("21 — module-scope call on a FILE node → scope module, own ordinal sequence", () => {
    const file = node("file::main.go");
    const mod = (file.metadata.callSites as CallSite[]).find((s) => s.name === "startModule");
    expect(mod).toBeDefined();
    expect(mod!.order).toBe(1);
    expect(mod!.scope).toBe("module");
    expect(file.metadata.calls).toEqual(["startModule"]);
    expect(file.metadata.resolvedCalls.find((r: any) => r.nodeId === "main.go::startModule")).toMatchObject({
      name: "startModule",
      nodeId: "main.go::startModule",
      firstOrder: 1,
      line: mod!.line,
    });
  });

  test("28 — if/else arms are maybe, a loop body is repeat", () => {
    const s = sites("main.go::blocks");
    const byName = Object.fromEntries(s.map((x) => [x.name, x]));
    expect(byName.a.maybe).toBe(true);
    expect(byName.b.maybe).toBe(true); // else arm
    expect(byName.a.repeat).toBeUndefined();
    expect(byName.c.repeat).toBe(true);
    expect(byName.c.maybe).toBeUndefined();
  });

  test("29 — go f() is conc and NOT deferred; defer f() is onReturn", () => {
    const s = sites("main.go::goDefer");
    expect(s.map((x) => x.name)).toEqual(["a", "b"]);
    expect(s[0].conc).toBe(true);
    expect(s[0].defer).toBeUndefined();
    expect(s[1].defer).toBe("onReturn");
    expect(s[1].deferDetail).toBe("defer");
    expect(s[1].conc).toBeUndefined();
  });

  test("35 — order is contiguous 1..N, unique, and monotone with (line, col)", () => {
    const scopes = new Set(["inline", "callback", "handler", "nested", "module"]);
    let checked = 0;
    for (const n of result.nodes) {
      const s = n.metadata?.callSites as CallSite[] | undefined;
      if (!Array.isArray(s) || s.length === 0) continue;
      checked++;
      expect(s.map((x) => x.order), `${n.id}: contiguous ordinals`).toEqual(
        s.map((_, i) => i + 1)
      );
      for (const rec of s) {
        expect(typeof rec.line, `${n.id}: line`).toBe("number");
        expect(rec.line).toBeGreaterThan(0);
        expect(typeof rec.col, `${n.id}: col`).toBe("number");
        expect(scopes.has(rec.scope), `${n.id}: scope ${rec.scope}`).toBe(true);
        if (rec.nested !== undefined) {
          const nested = rec.nested;
          expect(nested).toBeLessThan(rec.order);
          expect(s.map((x) => x.order)).toContain(nested);
        }
      }
      const byPos = [...s].sort((x, y) => x.line - y.line || x.col - y.col);
      expect(byPos.map((x) => x.order), `${n.id}: (line, col) monotone`).toEqual(
        byPos.map((_, i) => i + 1)
      );
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("36 — resolvedCalls.firstOrder is the first occurrence reaching that target", () => {
    const dupSites = sites("main.go::dup");
    const resolved = node("main.go::dup").metadata.resolvedCalls as any[];
    // de-duplicated by nodeId, one entry per target, shaped like ResolvedCall
    expect(resolved.map((r) => [r.name, r.nodeId])).toEqual([
      ["a", "main.go::a"],
      ["b", "main.go::b"],
    ]);
    const forA = resolved.find((r) => r.nodeId === "main.go::a")!;
    expect(forA.firstOrder).toBe(1);
    expect(forA.firstOrder).toBe(
      Math.min(...dupSites.filter((s) => s.name === "a").map((s) => s.order))
    );
    expect(forA.line).toBe(dupSites[0].line);
    // a() twice: the node carries every position; b() once: no orders key.
    expect(forA.orders).toEqual([1, 3]);
    expect(resolved.find((r) => r.nodeId === "main.go::b")!.orders).toBeUndefined();

    for (const n of result.nodes) {
      const s = n.metadata?.callSites as CallSite[] | undefined;
      const rc = n.metadata?.resolvedCalls as any[] | undefined;
      if (!Array.isArray(s) || !s.length || !Array.isArray(rc)) continue;
      for (const entry of rc) {
        expect(s.map((x) => x.order), `${n.id}: firstOrder is a real order`).toContain(
          entry.firstOrder
        );
      }
    }
  });

  test("method call on a receiver: selector name survives and the edge resolves", () => {
    const s = sites("main.go::methodCall");
    expect(s.map((x) => x.name)).toEqual(["s.Save"]);
    expect(s[0].scope).toBe("inline");
    const rc = node("main.go::methodCall").metadata.resolvedCalls.find(
      (r: any) => r.nodeId === "main.go::Store.Save"
    );
    expect(rc).toBeDefined();
    expect(rc.firstOrder).toBe(1);
    expect(rc.line).toBe(s[0].line);
    const edge = result.edges.find(
      (e: any) =>
        e.from === "main.go::methodCall" && e.to === "main.go::Store.Save" && e.type === "CALLS"
    );
    expect(edge).toBeDefined();
  });

  test("variadic spread keeps hasSpread and the source argCount", () => {
    const s = sites("main.go::spread");
    expect(s).toHaveLength(1);
    expect(s[0].name).toBe("sumAll");
    expect(s[0].argCount).toBe(1);
    expect(s[0].hasSpread).toBe(true);
    expect(s[0].argTypes).toEqual(["unknown"]);
    expect(s[0].order).toBe(1);
  });

  test("defer:timer — the time.AfterFunc callback, not the registration", () => {
    const s = sites("main.go::timerCallback");
    expect(s.map((x) => x.name)).toEqual(["time.AfterFunc", "a"]);
    expect(s[0].scope).toBe("inline");
    expect(s[0].defer).toBeUndefined();
    expect(s[1].scope).toBe("callback");
    expect(s[1].defer).toBe("timer");
    expect(s[1].deferDetail).toBe("time.AfterFunc");
  });

  test("defer:event — a func value received from a channel", () => {
    const s = sites("main.go::chanCallback");
    expect(s.map((x) => x.name)).toEqual(["cb"]);
    expect(s[0].defer).toBe("event");
    expect(s[0].deferDetail).toBe("<-cbCh");
  });

  test("maybe — the block behind an `if err != nil { return }` guard", () => {
    const s = sites("main.go::guarded");
    expect(s.map((x) => x.name)).toEqual(["a"]);
    expect(s[0].maybe).toBe(true);
  });

  test("metadata.calls stays the name-deduped set of callSites", () => {
    for (const n of result.nodes) {
      const s = n.metadata?.callSites as CallSite[] | undefined;
      if (!Array.isArray(s) || s.length === 0) continue;
      expect(n.metadata.calls, `${n.id}: calls`).toEqual(
        [...new Set(s.map((x) => x.name))].sort()
      );
    }
  });

  test("resolvedCalls matches the shared ResolvedCall shape", () => {
    const resolved = node("main.go::dup").metadata.resolvedCalls as any[];
    const allowed = ["name", "nodeId", "firstOrder", "line", "defer", "deferDetail",
                     "awaited", "conc", "repeat", "maybe", "orders"];
    for (const entry of resolved) {
      for (const key of Object.keys(entry)) expect(allowed).toContain(key);
      for (const required of ["name", "nodeId", "firstOrder", "line"]) {
        expect(entry[required]).toBeDefined();
      }
    }
  });
});

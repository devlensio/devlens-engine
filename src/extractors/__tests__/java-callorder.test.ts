import { describe, expect, setDefaultTimeout, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

// Java callOrder/v1 conformance. docs/CALL_ORDER.md §6.

const JAR = path.resolve(import.meta.dir, "../../../extractors/java/devlens_java_extractor.jar");
const jarAvailable = fs.existsSync(JAR);
const javaOnPath = process.env.PATH?.split(":").some((dir) => fs.existsSync(path.join(dir, "java")));

setDefaultTimeout(90_000);

function analyze(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-callorder-java-"));
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const res = spawnSync("java", ["-jar", JAR], {
    input: JSON.stringify({ repoPath: dir, options: {} }),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  fs.rmSync(dir, { recursive: true, force: true });
  expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
  return JSON.parse(res.stdout);
}

function methodOf(d: any, name: string) {
  const node = d.nodes.find((n: any) => n.name === name || n.name.endsWith("." + name));
  if (!node) throw new Error(`method node not found: ${name}`);
  return node;
}

function siteOf(d: any, method: string, callName: string) {
  const node = methodOf(d, method);
  return (node.metadata.callSites as any[]).find((s) => s.name === callName);
}

const SOURCE = `
package demo;

import java.util.concurrent.CompletableFuture;

public class Order {
    static void a() {}
    static void b() {}

    static void seq() {
        a();
        b();
        a();
    }

    static void caller() {
        seq();
    }

    static void branches(boolean flag) {
        if (flag) { a(); }
        for (int i = 0; i < 2; i++) { b(); }
    }

    static void asyncWork() {
        CompletableFuture.runAsync(() -> a());
        new Thread(() -> b()).start();
    }

    static void cleanup() {
        try { a(); } finally { b(); }
    }
}
`;

describe.skipIf(!jarAvailable || !javaOnPath)("java callOrder/v1", () => {
  const d = analyze({ "src/demo/Order.java": SOURCE });

  test("sequential calls are one record per occurrence, in order", () => {
    const sites = (methodOf(d, "seq").metadata.callSites as any[]).map((s) => [s.name, s.order]);
    expect(sites).toEqual([["a", 1], ["b", 2], ["a", 3]]);
  });

  test("metadata.calls stays the name-deduped set", () => {
    expect(methodOf(d, "seq").metadata.calls).toEqual(["a", "b"]);
  });

  test("every site carries kind, line, col and scope", () => {
    for (const site of methodOf(d, "seq").metadata.callSites as any[]) {
      expect(site.kind).toBe("call");
      expect(typeof site.line).toBe("number");
      expect(typeof site.col).toBe("number");
      expect(site.scope).toBe("inline");
    }
  });

  test("a plain call to another method is numbered from one", () => {
    expect(siteOf(d, "caller", "seq")).toMatchObject({ order: 1, scope: "inline" });
  });

  test("branch call is maybe, loop call is repeat", () => {
    expect(siteOf(d, "branches", "a")).toMatchObject({ maybe: true });
    expect(siteOf(d, "branches", "b")).toMatchObject({ repeat: true });
  });

  test("CompletableFuture callback is a promise continuation dispatched concurrently", () => {
    const site = siteOf(d, "asyncWork", "a");
    expect(site).toMatchObject({ scope: "callback", defer: "promise", conc: true });
  });

  test("a lambda passed to new Thread is concurrent without defer", () => {
    const site = siteOf(d, "asyncWork", "b");
    expect(site).toMatchObject({ scope: "callback", conc: true });
    expect(site.defer).toBeUndefined();
  });

  test("a call in finally runs at return", () => {
    expect(siteOf(d, "cleanup", "b")).toMatchObject({ defer: "onReturn" });
  });

  test("orders are contiguous, unique and monotone inside a method", () => {
    const sites = methodOf(d, "seq").metadata.callSites as any[];
    expect(sites.map((s) => s.order)).toEqual([1, 2, 3]);
    for (let i = 1; i < sites.length; i++) {
      const prev = sites[i - 1];
      const cur = sites[i];
      expect(cur.line > prev.line || (cur.line === prev.line && cur.col > prev.col)).toBe(true);
    }
  });

  test("resolvedCalls matches the shared ResolvedCall shape", () => {
    const resolved = methodOf(d, "seq").metadata.resolvedCalls as any[];
    const allowed = ["name", "nodeId", "firstOrder", "line", "defer", "deferDetail",
                     "awaited", "conc", "repeat", "maybe", "orders"];

    // name is the DECLARATION node name, which for Java methods is dotted
    expect(resolved.map((r) => r.name)).toEqual(["Order.a", "Order.b"]);
    for (const entry of resolved) {
      for (const key of Object.keys(entry)) expect(allowed).toContain(key);
      expect(entry.nodeId).toMatch(/::Order\.[ab]$/);
      expect(typeof entry.firstOrder).toBe("number");
      expect(typeof entry.line).toBe("number");
    }
    // a() twice: firstOrder is the minimum and orders keeps both positions.
    expect(resolved[0].firstOrder).toBe(1);
    expect(resolved[0].orders).toEqual([1, 3]);
    expect(resolved[1].orders).toBeUndefined();
  });

  test("every CALLS edge target is present in resolvedCalls", () => {
    for (const caller of ["seq", "caller", "branches", "asyncWork", "cleanup"]) {
      const node = methodOf(d, caller);
      const rc = (node.metadata.resolvedCalls ?? []) as any[];
      const targets = new Set(rc.map((r) => r.nodeId));
      const edgeTargets = d.edges
        .filter((e: any) => e.type === "CALLS" && e.from === node.id)
        .map((e: any) => e.to);
      for (const target of edgeTargets) expect(targets.has(target)).toBe(true);
    }
  });
});

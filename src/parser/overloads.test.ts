import fs from "fs";
import os from "os";
import path from "path";
import { parseRepo } from "./index.js";

function createFakeRepo(files: Record<string, string>): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-overloads-test-"));
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return tmpDir;
}

function deleteFakeRepo(repoPath: string): void {
  fs.rmSync(repoPath, { recursive: true, force: true });
}

describe("overload disambiguation (same-name function-likes in one file)", () => {
  it("keeps the clean unsuffixed id when the name is unique in the file", () => {
    const repo = createFakeRepo({
      "src/unique.ts": `
        export function formatValue(v: string) { return v.trim(); }
      `,
    });
    const { nodes } = parseRepo(repo);
    const fn = nodes.find((n) => n.name === "formatValue");
    expect(fn?.id).toBe("src/unique.ts::formatValue");
    expect(fn?.metadata.isOverloadSignature).toBeUndefined();
    deleteFakeRepo(repo);
  });

  it("suffixes each same-name function with its OWN arity (no ordinals)", () => {
    const repo = createFakeRepo({
      "src/arity.ts": `
        export function formatValue(v: string) { return v.trim(); }
        export function formatValue(v: string, n: number) { return v.repeat(n); }
        export function formatValue(v: string, n: number, flag: boolean) { return v; }
      `,
    });
    const { nodes } = parseRepo(repo);
    const ids = nodes.filter((n) => n.name === "formatValue").map((n) => n.id).sort();
    expect(ids).toEqual([
      "src/arity.ts::formatValue#1",
      "src/arity.ts::formatValue#2",
      "src/arity.ts::formatValue#3",
    ]);
    deleteFakeRepo(repo);
  });

  it("suffixes same-arity different-type overloads with an arity+signature hash", () => {
    const repo = createFakeRepo({
      "src/types.ts": `
        export function decode(input: string, mode: string) { return input; }
        export function decode(input: number, mode: string) { return String(input); }
      `,
    });
    const { nodes } = parseRepo(repo);
    const fns = nodes.filter((n) => n.name === "decode");
    expect(fns.length).toBe(2);
    const ids = fns.map((n) => n.id).sort();
    // both share arity 2, differ only by types → distinct sig hashes
    expect(ids[0]).toMatch(/^src\/types\.ts::decode#2#[0-9a-f]{8}$/);
    expect(ids[1]).toMatch(/^src\/types\.ts::decode#2#[0-9a-f]{8}$/);
    expect(ids[0]).not.toBe(ids[1]);
    // deterministic: same signature → same hash across runs
    expect(ids).toEqual(
      [...ids].sort(),
    );
    deleteFakeRepo(repo);
  });

  it("collapses an overload signature into a signature-identical implementation", () => {
    const repo = createFakeRepo({
      "src/collapse.ts": `
        export function greet(name: string): string;
        export function greet(name: string) { return "hi " + name; }
      `,
    });
    const { nodes } = parseRepo(repo);
    const greets = nodes.filter((n) => n.name === "greet");
    expect(greets.length).toBe(1);
    expect(greets[0].id).toBe("src/collapse.ts::greet");
    expect(greets[0].rawCode).toContain("return");
    deleteFakeRepo(repo);
  });

  it("keeps an overload signature separate when the implementation has different params", () => {
    const repo = createFakeRepo({
      "src/keepboth.ts": `
        export function parse(input: string): string;
        export function parse(input: string | number) { return String(input); }
      `,
    });
    const { nodes } = parseRepo(repo);
    const parses = nodes.filter((n) => n.name === "parse");
    expect(parses.length).toBe(2);
    // one of them is the bare signature
    const sig = parses.find((n) => n.metadata.isOverloadSignature === true);
    const impl = parses.find((n) => n.metadata.isOverloadSignature === undefined);
    expect(sig).toBeDefined();
    expect(impl).toBeDefined();
    // distinct ids, both arity 1 with different type shapes → hash suffixes
    expect(sig!.id).not.toBe(impl!.id);
    expect(sig!.id).toMatch(/^src\/keepboth\.ts::parse#1#[0-9a-f]{8}$/);
    deleteFakeRepo(repo);
  });

  it("suffixes class method overloads with dotted names, not cross-class names", () => {
    const repo = createFakeRepo({
      "src/logger.ts": `
        export class Logger {
          log(msg: string) { console.log(msg); }
          log(msg: string, level: number) { console.log(level, msg); }
        }
        export class Auditor {
          log(entry: string) { console.log(entry); }
        }
      `,
    });
    const { nodes } = parseRepo(repo);
    const logMethods = nodes.filter((n) => n.type === "METHOD" && n.name.endsWith(".log"));
    const ids = logMethods.map((n) => n.id).sort();
    expect(ids).toEqual([
      "src/logger.ts::Auditor.log",       // unique within its class → no suffix
      "src/logger.ts::Logger.log#1",
      "src/logger.ts::Logger.log#2",
    ]);
    deleteFakeRepo(repo);
  });

  it("never changes ids of different-name or different-file nodes", () => {
    const repo = createFakeRepo({
      "src/a.ts": `
        export function helper() { return 1; }
      `,
      "src/b.ts": `
        export function helper() { return 2; }
      `,
    });
    const { nodes } = parseRepo(repo);
    const helpers = nodes.filter((n) => n.name === "helper").map((n) => n.id).sort();
    expect(helpers).toEqual(["src/a.ts::helper", "src/b.ts::helper"]);
    deleteFakeRepo(repo);
  });

  it("captures callSites with argCount, argTypes and hasSpread", () => {
    const repo = createFakeRepo({
      "src/caller.ts": `
        export function run() {
          formatValue("abc");
          formatValue("abc", 3);
          logAll("a", "b", ...rest);
        }
      `,
    });
    const { nodes } = parseRepo(repo);
    const run = nodes.find((n) => n.name === "run");
    const sites = run?.metadata.callSites as any[];
    expect(sites).toBeDefined();
    const byName = new Map(sites.map((s) => [`${s.name}/${s.argCount}`, s]));
    expect(byName.get("formatValue/1")?.argTypes).toEqual(["string"]);
    expect(byName.get("formatValue/2")?.argTypes).toEqual(["string", "number"]);
    expect(byName.get("logAll/3")?.hasSpread).toBe(true);
    // legacy calls list stays in sync
    expect(run?.metadata.calls).toContain("formatValue");
    deleteFakeRepo(repo);
  });

  it("does not treat same-name functions in different files as overloads (per-file scope)", () => {
    const repo = createFakeRepo({
      "src/x.ts": `
        export function handle(a: string) { return a; }
      `,
      "src/y.ts": `
        export function handle(a: string, b: string) { return a + b; }
      `,
    });
    const { nodes } = parseRepo(repo);
    const handlers = nodes.filter((n) => n.name === "handle");
    expect(handlers.map((n) => n.id).sort()).toEqual([
      "src/x.ts::handle",
      "src/y.ts::handle",
    ]);
    deleteFakeRepo(repo);
  });
});

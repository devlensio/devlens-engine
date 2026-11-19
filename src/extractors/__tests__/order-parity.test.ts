import { describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { parseRepo } from "../../parser/index.js";

// Cross-language parity for callOrder/v1 (docs/CALL_ORDER.md §6.38). The same
// program shape must yield the same ordinal sequence in all five extractors.
// Language-neutral subset only: sequential, repeated target, nested, branch, loop.

const EXTRACTORS = path.resolve(import.meta.dir, "../../../extractors");
const platformDir =
  process.platform === "win32"
    ? "windows-amd64"
    : process.platform === "darwin"
      ? `darwin-${process.arch === "arm64" ? "arm64" : "amd64"}`
      : `linux-${process.arch === "arm64" ? "arm64" : "amd64"}`;
const EXE = process.platform === "win32" ? ".exe" : "";

const GO_BIN = path.join(EXTRACTORS, `go/bin/${platformDir}/devlens_go_extractor${EXE}`);
const RUST_BIN = path.join(EXTRACTORS, `rust/bin/${platformDir}/devlens_rust_extractor${EXE}`);
const JAVA_JAR = path.join(EXTRACTORS, "java/devlens_java_extractor.jar");
const PY_BIN = path.join(EXTRACTORS, "python/.venv/bin/python");
const javaOnPath = process.env.PATH?.split(":").some((dir) => fs.existsSync(path.join(dir, "java")));

function withRepo(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-parity-"));
  for (const [filePath, content] of Object.entries(files)) {
    const full = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  try {
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function runExtractor(command: string, args: string[], dir: string) {
  const res = spawnSync(command, args, {
    cwd: dir,
    input: JSON.stringify({ repoPath: dir, options: {} }),
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  expect(res.status, `exit 0 (stderr: ${res.stderr})`).toBe(0);
  return JSON.parse(res.stdout);
}

function sequenceOf(d: any, fnName: string) {
  const node = d.nodes.find((n: any) => n.name === fnName || n.name.endsWith("." + fnName));
  if (!node) throw new Error(`node not found: ${fnName}`);
  return (node.metadata.callSites as any[]).map((s) => [s.name, s.order]);
}

function tsSequence(dir: string, fnName: string) {
  const { nodes } = parseRepo(dir);
  const node = nodes.find((n) => n.name === fnName);
  if (!node) throw new Error(`node not found: ${fnName}`);
  return (node.metadata.callSites as any[]).map((s) => [s.name, s.order]);
}

const TS_SOURCE = `
function first(x?: any) {}
function second() { return 1; }
export function run(flag: boolean) {
  first();
  second();
  first();
  if (flag) { first(); }
  for (let i = 0; i < 2; i++) { second(); }
}
export function nested() { first(second()); }
`;

const PY_SOURCE = `
def first(x=None): pass
def second(): return 1
def run(flag):
    first()
    second()
    first()
    if flag:
        first()
    for i in [1, 2]:
        second()
def nested():
    first(second())
`;

const GO_SOURCE = `package main

func first(x ...int) {}
func second() int { return 1 }

func run(flag bool) {
	first()
	second()
	first()
	if flag {
		first()
	}
	for i := 0; i < 2; i++ {
		second()
	}
}

func nested() {
	first(second())
}
`;

const JAVA_SOURCE = `
package demo;

public class Main {
    static void first(int... x) {}
    static int second() { return 1; }

    static void run(boolean flag) {
        first();
        second();
        first();
        if (flag) { first(); }
        for (int i = 0; i < 2; i++) { second(); }
    }

    static void nested() {
        first(second());
    }
}
`;

const RUST_SOURCE = `
pub fn first(x: u64) {}
pub fn second() -> u64 { 1 }

pub fn run(flag: bool) {
    first(0);
    second();
    first(0);
    if flag { first(0); }
    for _ in 0..2 { second(); }
}

pub fn nested() {
    first(second());
}
`;

const EXPECTED_RUN: Array<[string, number]> = [
  ["first", 1],
  ["second", 2],
  ["first", 3],
  ["first", 4],
  ["second", 5],
];
const EXPECTED_NESTED: Array<[string, number]> = [
  ["first", 1],
  ["second", 2],
];

describe("callOrder cross-language parity", () => {
  test("typescript", () => {
    withRepo({ "main.ts": TS_SOURCE }, (dir) => {
      expect(tsSequence(dir, "run")).toEqual(EXPECTED_RUN);
      expect(tsSequence(dir, "nested")).toEqual(EXPECTED_NESTED);
    });
  });

  test.skipIf(!fs.existsSync(PY_BIN))("python", () => {
    withRepo({ "main.py": PY_SOURCE }, (dir) => {
      const d = runExtractor(PY_BIN, ["-m", "devlens_extractors_python"], dir);
      expect(sequenceOf(d, "run")).toEqual(EXPECTED_RUN);
      expect(sequenceOf(d, "nested")).toEqual(EXPECTED_NESTED);
    });
  });

  test.skipIf(!fs.existsSync(GO_BIN))("go", () => {
    withRepo({ "go.mod": "module parity\n\ngo 1.21\n", "main.go": GO_SOURCE }, (dir) => {
      const d = runExtractor(GO_BIN, [], dir);
      expect(sequenceOf(d, "run")).toEqual(EXPECTED_RUN);
      expect(sequenceOf(d, "nested")).toEqual(EXPECTED_NESTED);
    });
  });

  test.skipIf(!fs.existsSync(JAVA_JAR) || !javaOnPath)("java", () => {
    withRepo({ "src/demo/Main.java": JAVA_SOURCE }, (dir) => {
      const d = runExtractor("java", ["-jar", JAVA_JAR], dir);
      expect(sequenceOf(d, "run")).toEqual(EXPECTED_RUN);
      expect(sequenceOf(d, "nested")).toEqual(EXPECTED_NESTED);
    });
  });

  test.skipIf(!fs.existsSync(RUST_BIN))("rust", () => {
    withRepo(
      { "Cargo.toml": `[package]\nname = "parity"\nversion = "0.1.0"\n`, "src/lib.rs": RUST_SOURCE },
      (dir) => {
        const d = runExtractor(RUST_BIN, [], dir);
        expect(sequenceOf(d, "run")).toEqual(EXPECTED_RUN);
        expect(sequenceOf(d, "nested")).toEqual(EXPECTED_NESTED);
      },
    );
  });
});
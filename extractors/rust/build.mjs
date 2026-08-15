#!/usr/bin/env node
// DevLens Rust extractor — cross-compiled static binaries (Node script, so it
// runs on Windows too; never bash).
//
// The Rust extractor ships as per-platform static binaries inside the
// devlensio tarball (files whitelist). Node is guaranteed on every machine
// that installs an npm package; the Rust toolchain is a build-time dep (same
// class as JDK for java / Go toolchain for go).
//
// Cross-compile matrix (all sudo-free — the dep tree is 100% pure Rust):
//   linux-amd64/arm64 → musl targets linked by rust-lld: true static
//                       binaries (no glibc), zero runtime deps — matches
//                       Go's CGO_ENABLED=0 claim
//   windows-amd64      → x86_64-pc-windows-gnu via cargo-zigbuild: zig
//                       bundles the mingw-w64 import libs (rust-lld alone
//                       can't see kernel32.lib etc. without a system mingw)
//   darwin-amd64/arm64 → cargo-zigbuild: zig is the Mach-O linker, no macOS
//                       SDK needed for pure-Rust crates
//
// Prereqs on the publishing machine: rustup (stable + targets added),
// cargo-zigbuild, and a zig binary (found via env ZIG, ~/zig/zig-*/,
// or PATH).
//
// Usage: node build.mjs   (idempotent — run from this directory)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));

// [platform dir, cargo target triple, build kind]
const TARGETS = [
  ["linux-amd64", "x86_64-unknown-linux-musl", "rust-lld"],
  ["linux-arm64", "aarch64-unknown-linux-musl", "rust-lld"],
  ["windows-amd64", "x86_64-pc-windows-gnu", "zig"],
  ["darwin-amd64", "x86_64-apple-darwin", "zig"],
  ["darwin-arm64", "aarch64-apple-darwin", "zig"],
];

const cargo =
  process.env.CARGO ||
  (existsSync(join(homedir(), ".cargo", "bin", "cargo"))
    ? join(homedir(), ".cargo", "bin", "cargo")
    : "cargo");

function findZig() {
  if (process.env.ZIG && existsSync(process.env.ZIG)) return process.env.ZIG;
  const zigDir = join(homedir(), "zig");
  if (existsSync(zigDir)) {
    for (const entry of readdirSync(zigDir).sort().reverse()) {
      const cand = join(zigDir, entry, "zig");
      if (existsSync(cand)) return cand;
    }
  }
  return "zig"; // fall back to PATH
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

const zig = findZig();
for (const [platformDir, triple, kind] of TARGETS) {
  const outDir = join(HERE, "bin", platformDir);
  mkdirSync(outDir, { recursive: true });
  const exe = platformDir.startsWith("windows") ? "devlens_rust_extractor.exe" : "devlens_rust_extractor";
  console.log(`==> building ${platformDir} (${triple}, ${kind})`);
  const env = { ...process.env };
  let args;
  if (kind === "rust-lld") {
    // plain cargo build: rust-lld is the linker for pure-Rust musl targets
    env.RUSTFLAGS = "-C linker=rust-lld";
    args = ["build", "--target", triple, "--release"];
  } else {
    // zigbuild: zig must be on PATH (it spawns `zig`)
    env.PATH = `${dirname(zig)}${process.platform === "win32" ? ";" : ":"}${env.PATH}`;
    args = ["zigbuild", "--target", triple, "--release"];
  }
  run(cargo, args, { cwd: HERE, env });
  copyFileSync(join(HERE, "target", triple, "release", exe), join(outDir, exe));
}
console.log("==> Done: extractors/rust/bin/<platform>/devlens_rust_extractor[.exe]");

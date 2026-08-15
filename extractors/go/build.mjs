#!/usr/bin/env node
// DevLens Go extractor — cross-compiled static binaries (Node script, so it
// runs on Windows too; never bash).
//
// The Go extractor ships as per-platform static binaries inside the devlensio
// tarball (files whitelist). This builds all targets with CGO_ENABLED=0 (pure
// static). Node is guaranteed on every machine that installs an npm package;
// the Go toolchain is a build-time dep (same class as JDK for java's build.mjs).
//
// Usage: node build.mjs   (idempotent — run from this directory)

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Target matrix — the platforms the registry resolves per process.platform.
const TARGETS = [
  ["linux", "amd64"],
  ["linux", "arm64"],
  ["darwin", "amd64"],
  ["darwin", "arm64"],
  ["windows", "amd64"],
];

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

const go = process.env.GO || "go";
for (const [goos, goarch] of TARGETS) {
  const outDir = join(HERE, "bin", `${goos}-${goarch}`);
  mkdirSync(outDir, { recursive: true });
  const exe = goos === "windows" ? "devlens_go_extractor.exe" : "devlens_go_extractor";
  console.log(`==> building ${goos}/${goarch}`);
  run(go, ["build", "-o", join(outDir, exe), "."], {
    cwd: HERE,
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: "0" },
  });
}
console.log("==> Done: extractors/go/bin/<goos>-<goarch>/devlens_go_extractor[.exe]");

#!/usr/bin/env node
// DevLens Python extractor — venv bootstrap (cross-platform: Linux/macOS/Windows).
//
// Runs on `npm install` (postinstall) on the INSTALLING machine: a venv is
// machine-specific (absolute paths, platform binaries) so it can never live
// in the npm tarball — it must be created here. Node is guaranteed present
// (it's an npm package), so this works everywhere bash isn't.
//
// Idempotent + non-fatal:
//   - python3 missing          → warn, exit 0 (Python analysis unavailable)
//   - .venv already present    → skip
//   - otherwise                → create venv + editable-install the package

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const VENV_PYTHON = join(HERE, ".venv", IS_WIN ? "Scripts/python.exe" : "bin/python");

function which(cmd) {
  const r = spawnSync(IS_WIN ? "where" : "which", [cmd], { stdio: "pipe" });
  return r.status === 0;
}

// python3 on Windows is usually `python` (the Store alias is python3 too,
// but `python` is the safe bet on CI images).
const pythonCmd = which("python3") ? "python3" : which("python") ? "python" : null;

if (!pythonCmd) {
  console.error("devlens: python3 not found — Python extraction unavailable (install Python 3.11+)");
  process.exit(0);
}

if (existsSync(VENV_PYTHON)) {
  console.error("devlens: python extractor venv already present — skipping");
  process.exit(0);
}

console.error(`devlens: creating python extractor venv at ${join(HERE, ".venv")}`);
mkdirSync(join(HERE, ".venv"), { recursive: true });
let r = spawnSync(pythonCmd, ["-m", "venv", ".venv"], { cwd: HERE, stdio: "inherit" });
if (r.status !== 0) {
  console.error("devlens: `python -m venv` failed — Python extraction unavailable");
  process.exit(0);   // non-fatal: don't break npm install
}
r = spawnSync(VENV_PYTHON, ["-m", "pip", "install", "--quiet", "-e", "."], { cwd: HERE, stdio: "inherit" });
if (r.status !== 0) {
  console.error("devlens: pip install failed — Python extraction unavailable");
  process.exit(0);
}
console.error("devlens: python extractor ready");

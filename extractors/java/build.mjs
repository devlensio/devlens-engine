#!/usr/bin/env node
// DevLens Java extractor — fat-jar build (cross-platform: Linux/macOS/Windows).
//
// Node is guaranteed on every machine that installs an npm package, so this
// replaces the bash build.sh: downloads JavaParser + Gson from Maven Central,
// compiles src/, and merges EVERYTHING into one self-contained jar so the
// engine can run `java -jar devlens_java_extractor.jar` with no classpath.
//
// Usage: node build.mjs   (idempotent — run from this directory)

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSIONS = {
  "javaparser-core.jar": "com/github/javaparser/javaparser-core/3.28.2/javaparser-core-3.28.2.jar",
  "javaparser-symbol-solver-core.jar": "com/github/javaparser/javaparser-symbol-solver-core/3.28.2/javaparser-symbol-solver-core-3.28.2.jar",
  "gson.jar": "com/google/code/gson/gson/2.14.0/gson-2.14.0.jar",
  "javassist.jar": "org/javassist/javassist/3.32.0-GA/javassist-3.32.0-GA.jar",
  "guava.jar": "com/google/guava/guava/33.6.0-jre/guava-33.6.0-jre.jar",
  "checker-qual.jar": "org/checkerframework/checker-qual/4.2.2/checker-qual-4.2.2.jar",
};
const MAVEN = "https://repo1.maven.org/maven2/";

const libDir = join(HERE, "lib");
const classesDir = join(HERE, "classes");
mkdirSync(libDir, { recursive: true });
mkdirSync(classesDir, { recursive: true });

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

// ── 1. fetch dependencies (cache on disk; idempotent) ────────────────
console.log("==> Fetching dependencies (Maven Central)");
for (const [jar, path] of Object.entries(VERSIONS)) {
  const dest = join(libDir, jar);
  if (existsSync(dest) && readFileSync(dest).length > 0) {
    console.log(`  cached ${jar}`);
    continue;
  }
  console.log(`  downloading ${jar}`);
  const res = await fetch(MAVEN + path);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${MAVEN + path}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// ── 2. compile ───────────────────────────────────────────────────────
console.log("==> Compiling");
const sources = [];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collect(p);
    else if (entry.name.endsWith(".java")) sources.push(p);
  }
}
collect(join(HERE, "src"));
run(process.env.JAVAC || "javac",
  ["--release", "17", "-cp", join(libDir, "*"), "-d", classesDir, ...sources]);

// ── 3. assemble fat jar ──────────────────────────────────────────────
console.log("==> Assembling fat jar");
const fatDir = join(HERE, "fat");
rmSync(fatDir, { recursive: true, force: true });
mkdirSync(fatDir, { recursive: true });
for (const jar of readdirSync(libDir).filter((f) => f.endsWith(".jar"))) {
  run("jar", ["xf", join(libDir, jar)], { cwd: fatDir });
}
// strip other jars' META-INF signatures + multi-release leftovers are fine
for (const sig of [".SF", ".DSA", ".RSA"]) {
  for (const f of readdirSync(join(fatDir, "META-INF"))) {
    if (f.endsWith(sig)) rmSync(join(fatDir, "META-INF", f));
  }
}
for (const entry of readdirSync(classesDir)) {
  run(process.platform === "win32" ? "xcopy" : "cp",
    process.platform === "win32"
      ? [join(classesDir, entry), join(fatDir, entry), "/E", "/Y"]
      : ["-r", join(classesDir, entry), fatDir],
    process.platform === "win32" ? { shell: true } : {});
}
run("jar", ["cfe", join(HERE, "devlens_java_extractor.jar"),
  "devlens.extractor.Main", "-C", fatDir, "."]);
rmSync(fatDir, { recursive: true, force: true });

const size = (readFileSync(join(HERE, "devlens_java_extractor.jar")).length / 1e6).toFixed(1);
console.log(`==> Done: ${size}M devlens_java_extractor.jar`);

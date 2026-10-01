// Back-compat + tolerance tests for the config system (plan issue 15, M1).
//
// Each scenario runs in a SUBPROCESS with HOME pointed at a throwaway dir:
// CONFIG_FILE is resolved from os.homedir() at module load, so isolation only
// works in a fresh process. This also guarantees these tests can never touch
// the developer's real ~/.devlens/config.json.
//
// Run: bun test src/config/backcompat.test.ts
import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", ".."); // engine repo root

interface Scenario {
  home: string;
  result: Record<string, unknown>;
  stderr: string;
}

function runScenario(name: string, files: Record<string, string>, script: string): Scenario {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `devlens-cfg-${name}-`));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  // strip ambient LLM env so fixtures are hermetic
  for (const k of Object.keys(env)) {
    if (k.startsWith("DEVLENS_LLM") || k.startsWith("DEVLENS_EMBED") || k.startsWith("DEVLENS_BATCH")) {
      delete env[k];
    }
  }
  const r = spawnSync("bun", ["-e", script], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  const out = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  let result: Record<string, unknown>;
  try {
    result = JSON.parse(out);
  } catch {
    result = { parseError: r.stdout, status: r.status, stderr: r.stderr };
  }
  return { home, result, stderr: r.stderr ?? "" };
}

const CONFIG_REL = ".devlens/config.json";

const PROBE = `
  const m = await import("./src/config/index.js");
  const out = {};
  try {
    const c = m.resolveConfig(undefined, { validate: false });
    out.tolerant = { provider: c.summarization.provider, providerName: c.summarization.providerName ?? null, model: c.summarization.model, hasKey: !!c.summarization.apiKey };
  } catch (e) { out.tolerantErr = e instanceof Error ? e.message : String(e); }
  try {
    m.resolveConfig();
    out.validating = "ok";
  } catch (e) { out.validatingErr = e instanceof Error ? e.message : String(e); }
  out.configured = m.hasSummarizationConfigured();
  console.log(JSON.stringify(out));
`;

describe("fresh install (no config file)", () => {
  const s = runScenario("fresh", {}, PROBE);
  test("tolerant read resolves defaults without error", () => {
    expect(s.result.tolerantErr).toBeUndefined();
    expect(s.result.tolerant).toMatchObject({ provider: "anthropic", hasKey: false });
  });
  test("validating read fails with the actionable missing-key message", () => {
    expect(String(s.result.validatingErr)).toContain("summarization.apiKey is required");
    expect(String(s.result.validatingErr)).toContain("devlens init");
  });
  test("hasSummarizationConfigured() = false", () => {
    expect(s.result.configured).toBe(false);
  });
});

describe("incomplete config (provider, no key)", () => {
  const s = runScenario(
    "incomplete",
    { [CONFIG_REL]: JSON.stringify({ summarization: { provider: "openai", providerName: "deepseek", model: "deepseek-chat" } }) },
    PROBE,
  );
  test("tolerant read works (init/config/analyze can run)", () => {
    expect(s.result.tolerantErr).toBeUndefined();
    expect(s.result.tolerant).toMatchObject({ provider: "openai", providerName: "deepseek", hasKey: false });
  });
  test("only the validating path throws", () => {
    expect(String(s.result.validatingErr)).toContain("apiKey is required");
    expect(s.result.configured).toBe(false);
  });
});

describe("valid config (current multi-provider v2)", () => {
  const s = runScenario(
    "valid",
    {
      [CONFIG_REL]: JSON.stringify({
        summarization: {
          active: "openai:deepseek",
          providers: {
            "openai:deepseek": { provider: "openai", providerName: "deepseek", model: "deepseek-chat", apiKey: "sk-x", batchSize: 25 },
          },
        },
      }),
    },
    PROBE,
  );
  test("both paths resolve; configured = true", () => {
    expect(s.result.tolerantErr).toBeUndefined();
    expect(s.result.validating).toBe("ok");
    expect(s.result.configured).toBe(true);
    expect(s.result.tolerant).toMatchObject({ provider: "openai", providerName: "deepseek", hasKey: true });
  });
});

describe("broken config JSON", () => {
  const s = runScenario("broken", { [CONFIG_REL]: "{ not json" }, PROBE);
  test("tolerant read STILL reports the invalid-JSON error (never silent)", () => {
    expect(String(s.result.tolerantErr)).toContain("invalid JSON");
    expect(String(s.result.validatingErr)).toContain("invalid JSON");
    expect(s.result.configured).toBe(false);
  });
});

describe("old v1 flat config (pre multi-provider)", () => {
  const flat = JSON.stringify({ summarization: { provider: "openai", providerName: "mybrand", model: "m1", apiKey: "sk-old", batchSize: 30 } });
  const s = runScenario("flat", { [CONFIG_REL]: flat }, PROBE);
  test("loads fine on both paths", () => {
    expect(s.result.tolerantErr).toBeUndefined();
    expect(s.result.validating).toBe("ok");
    expect(s.result.configured).toBe(true);
  });
  test("migrates the file to multi-provider format (active + providers)", () => {
    const raw = JSON.parse(fs.readFileSync(path.join(s.home, CONFIG_REL), "utf8"));
    expect(raw.summarization.active).toBe("openai:mybrand");
    expect(raw.summarization.providers["openai:mybrand"].apiKey).toBe("sk-old");
  });
});

describe("v1 config with a BRAND in provider (deepseek)", () => {
  const s = runScenario(
    "brand",
    { [CONFIG_REL]: JSON.stringify({ summarization: { provider: "deepseek", model: "m1", apiKey: "sk-b" } }) },
    PROBE,
  );
  test("migrates brand → protocol + providerName without error", () => {
    expect(s.result.tolerantErr).toBeUndefined();
    expect(s.result.tolerant).toMatchObject({ provider: "openai", providerName: "deepseek", hasKey: true });
    expect(s.result.validating).toBe("ok");
  });
});

describe("legacy OLLAMA config (provider removed)", () => {
  const s = runScenario(
    "ollama",
    { [CONFIG_REL]: JSON.stringify({ summarization: { provider: "ollama", model: "qwen2.5-coder:3b", baseUrl: "http://localhost:11434/v1" } }) },
    PROBE,
  );
  test("tolerant read loads (old configs must keep working)", () => {
    expect(s.result.tolerantErr).toBeUndefined();
    expect(s.result.tolerant).toMatchObject({ provider: "openai", providerName: "ollama", hasKey: false });
  });
  test("validating read gives the 'no longer supported' migration message", () => {
    expect(String(s.result.validatingErr)).toContain("Ollama is no longer supported");
    expect(s.result.configured).toBe(false);
  });
  test("stderr carries the not-in-catalog warning (once)", () => {
    expect(s.stderr).toContain("not in the provider catalog");
  });
});

describe("config with an embedding block but no embedding key", () => {
  const s = runScenario(
    "embedding",
    {
      [CONFIG_REL]: JSON.stringify({
        summarization: { provider: "openai", providerName: "deepseek", model: "m", apiKey: "sk-ok" },
        embedding: { provider: "openai", model: "text-embedding-3-small" },
      }),
    },
    PROBE,
  );
  test("validating read no longer demands an embedding key (issue 14)", () => {
    expect(s.result.validating).toBe("ok");
    expect(s.result.tolerantErr).toBeUndefined();
    expect(s.result.configured).toBe(true);
  });
});

describe("provider catalog", () => {
  test("ollama is gone from the shipped catalog", () => {
    const s = runScenario("catalog", {}, `
      const { loadCatalog } = await import("./src/config/providers/catalog.js");
      const names = loadCatalog().map(p => p.name);
      console.log(JSON.stringify({ names }));
    `);
    const names = (s.result.names ?? []) as string[];
    expect(names).not.toContain("ollama");
    expect(names).toContain("deepseek");
    expect(names).toContain("anthropic");
  });
});

describe("env-var key counts as configured", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "devlens-cfg-env-"));
  fs.mkdirSync(path.join(home, ".devlens"), { recursive: true });
  const r = spawnSync(
    "bun",
    ["-e", `const m = await import("./src/config/index.js"); console.log(JSON.stringify({ configured: m.hasSummarizationConfigured(), hasKey: !!m.resolveConfig(undefined,{validate:false}).summarization.apiKey }));`],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, HOME: home, DEVLENS_LLM_KEY: "sk-from-env" },
    },
  );
  test("DEVLENS_LLM_KEY enables hasSummarizationConfigured()", () => {
    const out = JSON.parse((r.stdout ?? "").trim().split("\n").pop() ?? "{}");
    expect(out).toEqual({ configured: true, hasKey: true });
  });
});

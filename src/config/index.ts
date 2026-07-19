import { type DevLensConfig, OLLAMA_DEFAULTS, ANTHROPIC_DEFAULTS, type ProviderConfigEntry, type MultiProviderStorage, makeProviderKey } from "./types.js";
import { loadFileConfig, readRawConfigFile } from "./providers/file.js";
import { applyRequestHeaders } from "./providers/request.js";
import { atomicWrite } from "./writer.js";
import { CONFIG_FILE } from "./providers/paths.js";
import fs from "fs";

//  Ollama Detection 
//
// Pings Ollama's default endpoint at server startup.
// Used by resolveConfig() to choose which defaults to fall back to:
//   - Ollama running  → OLLAMA_DEFAULTS (free, private, zero API cost)
//   - Ollama absent   → ANTHROPIC_DEFAULTS (user must set apiKey)
//
// Uses a short timeout — we don't want server startup to hang for 30 seconds
// if Ollama is not installed. 2 seconds is enough for a local HTTP ping.
//
// Called ONCE at startup and the result is cached — see `cachedDefaults` below.

const OLLAMA_PING_URL    = "http://localhost:11434";
const OLLAMA_PING_TIMEOUT_MS = 2000;

export async function detectOllama(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(
      () => controller.abort(),
      OLLAMA_PING_TIMEOUT_MS
    );

    const res = await fetch(OLLAMA_PING_URL, {
      signal: controller.signal,
      method: "GET",
    });

    clearTimeout(timeout);
    return res.ok;
  } catch {
    // Ollama not running, not installed, or timed out — all treated the same
    return false;
  }
}

//  Startup Initialization 
//
// detectOllama() is called once when the server starts (in server/index.ts).
// The result is stored here so resolveConfig() doesn't ping Ollama on
// every single request — that would be slow and noisy.
//
// initConfig() must be called before any request is handled.
// Until it is called, resolveConfig() falls back to ANTHROPIC_DEFAULTS safely.

let cachedDefaults: DevLensConfig = ANTHROPIC_DEFAULTS;
let initialized = false;

export async function initConfig(): Promise<void> {
  if (initialized) return;

  const ollamaRunning = await detectOllama();

  if (ollamaRunning) {
    cachedDefaults = OLLAMA_DEFAULTS;
    console.log("⚡ Ollama detected — using local LLM defaults");
    console.log(`   Summarization: ${OLLAMA_DEFAULTS.summarization.model}`);
    console.log(`   Embedding:     ${OLLAMA_DEFAULTS.embedding.model}`);
  } else {
    cachedDefaults = ANTHROPIC_DEFAULTS;
    console.log("☁️  Ollama not detected — using Anthropic defaults");
    console.log("   Add an apiKey to ~/.devlens/config.json to enable summarization");
    console.log(`   Or set ${(await import("./providers/file.js")).ENV.LLM_KEY}=your-key`);
  }

  initialized = true;
}

// This function reads config.json fresh on every call —
// so if the user edits settings in the UI, the next job picks up the change
// without requiring a server restart.

export function resolveConfig(req?: Request): DevLensConfig {
  // Step 1 — load file config merged with detected defaults + env vars
  const fileConfig = loadFileConfig(cachedDefaults);

 
  if (!req) return fileConfig;

  
  // In local mode, ignore headers even if present
  if (fileConfig.deploymentMode !== "cloud") return fileConfig;

  // Step 4 — apply header overrides for cloud users
  return applyRequestHeaders(fileConfig, req);
}

// Re-export everything consumers might need from one place
// so they only need to import from "config" not "config/types" etc.
export type { DevLensConfig } from "./types.js";
export type { SafeConfig }     from "./writer.js";
export { maskConfig, writeConfig, atomicWrite } from "./writer.js";
export { CONFIG_FILE, CONFIG_DIR, ENV } from "./providers/file.js";
export { sanitizeHeaders, CONFIG_HEADERS } from "./types.js";
export { OLLAMA_DEFAULTS, ANTHROPIC_DEFAULTS } from "./types.js";
export type { ProviderConfigEntry, MultiProviderStorage } from "./types.js";
export { makeProviderKey, parseProviderKey } from "./types.js";

// ── Multi-provider helpers ────────────────────────────────────────────────

export interface AllProvidersResult {
  active: string;
  providers: ProviderConfigEntry[];
}

/** Read the raw multi-provider storage from config.json (no defaults applied). */
function readProviderStorage(): MultiProviderStorage | null {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    const s = raw?.summarization;
    // Detect multi-provider format
    if (s && typeof s === "object" && s.providers && typeof s.providers === "object" && typeof s.active === "string") {
      return s as MultiProviderStorage;
    }
    return null;
  } catch {
    return null;
  }
}

/** Return ALL configured providers (from disk) — for the frontend settings UI. */
export function resolveAllProviders(): AllProvidersResult {
  const storage = readProviderStorage();
  if (storage) {
    return {
      active: storage.active,
      providers: Object.values(storage.providers),
    };
  }
  // Fallback: use the resolved active config to synthesise one entry
  const config = loadFileConfig(ANTHROPIC_DEFAULTS);
  const key = makeProviderKey(config.summarization.provider, config.summarization.providerName ?? config.summarization.provider);
  return {
    active: key,
    providers: [{
      provider:     config.summarization.provider,
      providerName: config.summarization.providerName ?? config.summarization.provider,
      model:        config.summarization.model,
      apiKey:       config.summarization.apiKey,
      baseUrl:      config.summarization.baseUrl,
      batchSize:    config.summarization.batchSize,
    }],
  };
}

/** Switch the active provider by composite key. */
export function setActiveProvider(key: string): void {
  const storage = readProviderStorage();
  if (!storage) throw new Error("No multi-provider config found. Save a provider first.");
  if (!storage.providers[key]) throw new Error(`Provider "${key}" not found in config.`);
  storage.active = key;
  if (!fs.existsSync(CONFIG_FILE)) throw new Error("Config file missing.");
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  raw.summarization = storage;
  atomicWrite(CONFIG_FILE, JSON.stringify(raw, null, 2));
}

/** Remove a provider entry by composite key. Cannot remove the active provider. */
export function removeProvider(key: string): void {
  const storage = readProviderStorage();
  if (!storage) throw new Error("No multi-provider config found.");
  if (!storage.providers[key]) throw new Error(`Provider "${key}" not found.`);
  if (storage.active === key) throw new Error(`Cannot remove the active provider. Switch to another provider first.`);
  delete storage.providers[key];
  if (!fs.existsSync(CONFIG_FILE)) throw new Error("Config file missing.");
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
  raw.summarization = storage;
  atomicWrite(CONFIG_FILE, JSON.stringify(raw, null, 2));
}
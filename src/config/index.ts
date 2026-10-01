import { type DevLensConfig, ANTHROPIC_DEFAULTS, type ProviderConfigEntry, type MultiProviderStorage, makeProviderKey } from "./types.js";
import { loadFileConfig, readRawConfigFile } from "./providers/file.js";
import { applyRequestHeaders } from "./providers/request.js";
import { atomicWrite } from "./writer.js";
import { CONFIG_FILE } from "./providers/paths.js";
import { findProvider } from "./providers/catalog.js";
import fs from "fs";

//  Startup Initialization
//
// Historically this pinged a local Ollama endpoint to pick defaults and logged
// the result with console.log — noise, and a real hazard for the MCP stdio
// transport (stdout is the JSON-RPC channel). Ollama support has been removed;
// initConfig() is now a quiet, idempotent shim kept for call-site
// compatibility (OSS `devlens serve` + MCP servers await it at startup).

let cachedDefaults: DevLensConfig = ANTHROPIC_DEFAULTS;
let initialized = false;

export async function initConfig(): Promise<void> {
  if (initialized) return;
  initialized = true;
}

// This function reads config.json fresh on every call —
// so if the user edits settings in the UI, the next job picks up the change
// without requiring a server restart.
//
// opts.validate === false → tolerant read: an incomplete summarization config
// (missing API key etc.) resolves fine and is only reported when summarization
// actually runs. Used by display paths (devlens config/doctor/init) and by
// structure-only analysis (GitHub issue #10).

export function resolveConfig(req?: Request, opts?: { validate?: boolean }): DevLensConfig {
  // Step 1 — load file config merged with detected defaults + env vars
  const fileConfig = loadFileConfig(cachedDefaults, opts);

 
  if (!req) return fileConfig;

  
  // In local mode, ignore headers even if present
  if (fileConfig.deploymentMode !== "cloud") return fileConfig;

  // Step 4 — apply header overrides for cloud users
  return applyRequestHeaders(fileConfig, req);
}

// True when summarization can actually run with the current config: the active
// provider either needs no key, or has one (file or env). Never throws on an
// incomplete config — callers use it to auto-skip summarization instead of
// failing analysis (GitHub issue #10). Returns false when config.json is
// unreadable: summarization must not run, but analysis may still proceed.

export function hasSummarizationConfigured(req?: Request): boolean {
  try {
    const config = resolveConfig(req, { validate: false });
    const providerName = config.summarization.providerName ?? config.summarization.provider;
    if (providerName === "ollama") return false; // removed provider
    const entry = findProvider(providerName);
    const needsKey = entry?.requiresKey ?? true;
    return !needsKey || !!config.summarization.apiKey;
  } catch {
    return false;
  }
}

// Re-export everything consumers might need from one place
// so they only need to import from "config" not "config/types" etc.
export type { DevLensConfig } from "./types.js";
export type { SafeConfig }     from "./writer.js";
export { maskConfig, writeConfig, atomicWrite } from "./writer.js";
export { CONFIG_FILE, CONFIG_DIR, ENV } from "./providers/file.js";
export { sanitizeHeaders, CONFIG_HEADERS } from "./types.js";
export { ANTHROPIC_DEFAULTS } from "./types.js";
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
  // (tolerant read — a missing key must not break the settings UI)
  const config = loadFileConfig(ANTHROPIC_DEFAULTS, { validate: false });
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
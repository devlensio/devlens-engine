import fs from "fs";
import { CONFIG_DIR, CONFIG_FILE } from "./paths.js";
import {
  type DevLensConfig,
  type Neo4jConfig,
  type MultiProviderStorage,
  type ProviderConfigEntry,
  ANTHROPIC_DEFAULTS,
  makeProviderKey,
} from "../types.js";
import { findProvider } from "./catalog.js";

export { CONFIG_DIR, CONFIG_FILE } from "./paths.js";

// ─── Constants ────────────────────────────────────────────────────────────────
//
// For Docker users who prefer env vars over config files.
// A Docker user running Ollama in the same network would set:
//   DEVLENS_LLM_PROVIDER=ollama
//   DEVLENS_LLM_BASE_URL=http://ollama:11434
//
// Priority: config file wins over env vars.
// Env vars only fill fields that the config file left empty.

export const ENV = {
  // Summarization
  LLM_PROVIDER: "DEVLENS_LLM_PROVIDER",    //here DEVLENS_LLM_PROVIDER is the actual env variable
  LLM_PROVIDER_NAME: "DEVLENS_LLM_PROVIDER_NAME",
  LLM_MODEL: "DEVLENS_LLM_MODEL",
  LLM_KEY: "DEVLENS_LLM_KEY",
  LLM_BASE_URL: "DEVLENS_LLM_BASE_URL",
  BATCH_SIZE: "DEVLENS_BATCH_SIZE",

  // Embedding
  EMBED_PROVIDER: "DEVLENS_EMBED_PROVIDER",
  EMBED_MODEL: "DEVLENS_EMBED_MODEL",
  EMBED_KEY: "DEVLENS_EMBED_KEY",
  EMBED_BASE_URL: "DEVLENS_EMBED_BASE_URL",

  // Neo4j
  NEO4J_URL: "DEVLENS_NEO4J_URL",
  NEO4J_USER: "DEVLENS_NEO4J_USER",
  NEO4J_PASSWORD: "DEVLENS_NEO4J_PASSWORD",
  NEO4J_STORECODE: "NEO4J_STORE_CODE"
} as const;

//  Types 
//
// DeepPartial allows users to only specify what they want to override.
// Every field at every level is optional in config.json.

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

type PartialConfig = DeepPartial<DevLensConfig>;

//  Deep Merge 
//
// Merges user's partial config on top of defaults.
// Does NOT mutate either argument — returns a new object.
//
// Example:
//   base:    { summarization: { provider: "anthropic", model: "haiku", batchSize: 50 } }
//   partial: { summarization: { apiKey: "sk-ant-..." } }
//   result:  { summarization: { provider: "anthropic", model: "haiku",
//                               batchSize: 50, apiKey: "sk-ant-..." } }

function deepMerge(base: DevLensConfig, partial: PartialConfig): DevLensConfig {
  return {
    deploymentMode: partial.deploymentMode ?? base.deploymentMode,

    summarization: {
      ...base.summarization,
      ...partial.summarization,
    },

    embedding: {
      ...base.embedding,
      ...partial.embedding,
    },

    // Neo4j: if user provides any neo4j fields, merge on top of base.
    // If user provides nothing, keep base (which may be undefined).
    neo4j: partial.neo4j
      ? { ...(base.neo4j ?? {} as Neo4jConfig), ...partial.neo4j }
      : base.neo4j,
  };
}

// ─── v1→v2 Provider Migration ──────────────────────────────────────────────
// Old configs stored brand strings ("openrouter", "ollama", etc.) in
// `provider`. In v2, provider is the wire protocol and the brand goes in
// `providerName`.  This maps old values via the catalog and persists the fix.

function migrateProviderConfig(config: DevLensConfig): DevLensConfig {
  const p = config.summarization.provider;
  if (p === "openai" || p === "anthropic") return config;

  const entry = findProvider(p);
  if (!entry) throw new Error(
    `DevLens: "${p}" is not a valid provider protocol. Wire protocol must be "openai" or "anthropic". ` +
    `Fix: set "provider" to "openai" and "providerName" to "${p}" in ~/.devlens/config.json`
  );

  const migrated = { ...config, summarization: { ...config.summarization, provider: entry.protocol, providerName: entry.name } };

  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    raw.summarization = { ...raw.summarization, provider: entry.protocol };
    if (!raw.summarization.providerName) raw.summarization.providerName = entry.name;
    const tmp = CONFIG_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
    fs.renameSync(tmp, CONFIG_FILE);
  } catch { /* non-fatal — will re-migrate next load */ }

  return migrated;
}

const VALID_LLM_PROTOCOLS = new Set(["openai", "anthropic"]);
const VALID_EMBED_PROTOCOLS = new Set(["openai", "anthropic", "openrouter", "gemini", "ollama"]);

function sanitizeProviderEnv(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (VALID_LLM_PROTOCOLS.has(raw)) return raw;
  // It's a junk/placeholder value — skip it so the default stays in place.
  return undefined;
}

function sanitizeEmbedProviderEnv(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (VALID_EMBED_PROTOCOLS.has(raw)) return raw;
  return undefined;
}

function sanitizeApiKeyEnv(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Reject dot-notation field references: "embedding.apiKey", "summarization.key", etc.
  if (/^[a-z]+\.[a-zA-Z]/.test(raw)) return undefined;
  return raw;
}

function sanitizeBaseUrlEnv(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  // Not a URL — likely a placeholder like "embedding.baseUrl"
  return undefined;
}

function sanitizeModelEnv(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Reject dot-notation references like "summarization.model"
  if (/^[a-z]+\.[a-zA-Z]/.test(raw)) return undefined;
  return raw;
}

//  Env Var Application
//
// Applies environment variables onto an already-merged config.
// Only fills fields that are still empty after the file merge.
// Config file always wins — env vars never override explicit file values.
//
// This runs AFTER deepMerge so the priority is:
//   config file > env vars > defaults

function applyEnvVars(config: DevLensConfig): DevLensConfig {
  const s = config.summarization;
  const e = config.embedding;
  return {
    ...config,
    summarization: {
      ...s,
      // Only inject env var if config file didn't already set this field
      provider: s.provider !== ANTHROPIC_DEFAULTS.summarization.provider
        ? s.provider
        : sanitizeProviderEnv(process.env[ENV.LLM_PROVIDER]) as typeof s.provider ?? s.provider,
      providerName: s.providerName ?? sanitizeModelEnv(process.env[ENV.LLM_PROVIDER_NAME]),
      model: s.model ?? sanitizeModelEnv(process.env[ENV.LLM_MODEL]),
      apiKey: s.apiKey ?? sanitizeApiKeyEnv(process.env[ENV.LLM_KEY]),
      baseUrl: s.baseUrl ?? sanitizeBaseUrlEnv(process.env[ENV.LLM_BASE_URL]),
      batchSize: s.batchSize ?? (parseInt(process.env[ENV.BATCH_SIZE] ?? "", 10) ?? s.batchSize),
    },

    embedding: {
      ...e,
      provider: e.provider !== ANTHROPIC_DEFAULTS.embedding.provider
        ? e.provider
        : sanitizeEmbedProviderEnv(process.env[ENV.EMBED_PROVIDER]) as typeof e.provider ?? e.provider,
      model: e.model ?? sanitizeModelEnv(process.env[ENV.EMBED_MODEL]),
      apiKey: e.apiKey ?? sanitizeApiKeyEnv(process.env[ENV.EMBED_KEY]),
      baseUrl: e.baseUrl ?? sanitizeBaseUrlEnv(process.env[ENV.EMBED_BASE_URL]),
    },

    // Neo4j: only build from env vars if config file didn't set it
    // AND all three required env vars are present
    neo4j: config.neo4j ?? buildNeo4jFromEnv(),
  };
}

// Builds a Neo4jConfig purely from env vars.
// Returns undefined if any of the three required vars is missing —
// we never create a partial Neo4j config.
function buildNeo4jFromEnv(): Neo4jConfig | undefined {
  const url = process.env[ENV.NEO4J_URL];
  const username = process.env[ENV.NEO4J_USER];
  const password = process.env[ENV.NEO4J_PASSWORD];
  const storeRawCode = process.env[ENV.NEO4J_STORECODE] == "true";

  if (!url || !username || !password) return undefined;

  return { url, username, password, storeRawCode };
}

//  Validation 
//
// Only validates what cannot have a sensible default.
// Key requirement is resolved from the catalog's `requiresKey` per provider.
// If a providerName isn't in the catalog (custom), we default to requiring a key.
//
// Error messages are actionable — they tell the user exactly how to fix the problem.

const EMBEDDING_PROVIDERS_NEEDING_KEY = new Set([
  "anthropic",
  "openai",
  "openrouter",
  "gemini",
]);

function validate(config: DevLensConfig): void {
  const { summarization, embedding } = config;

  // Summarization apiKey — resolved from catalog
  const entry = findProvider(summarization.providerName ?? "");
  const needsKey = entry?.requiresKey ?? true;  // unknown/custom → require key
  if (needsKey && !summarization.apiKey) {
    throw new Error(
      `DevLens config error: summarization.apiKey is required for "${summarization.providerName ?? summarization.provider}".\n` +
      `  Fix option 1 — add to ${CONFIG_FILE}:\n` +
      `    { "summarization": { "apiKey": "your-key-here" } }\n` +
      `  Fix option 2 — set environment variable:\n` +
      `    ${ENV.LLM_KEY}=your-key-here \n` +
      `Fix option 3 - Skip Summarization`
    );
  }

  // Embedding apiKey — only validate if the user explicitly configured embedding.
  // If the user only set summarization, embedding may still be at default (openai
  // with no key) which is fine — embedding is only needed for vector search (cloud).
  const rawFile = readFileConfig();
  const userSetEmbedding = !!rawFile.embedding?.provider;
  if (
    userSetEmbedding &&
    EMBEDDING_PROVIDERS_NEEDING_KEY.has(embedding.provider) &&
    !embedding.apiKey
  ) {
    throw new Error(
      `DevLens config error: embedding.apiKey is required when provider is "${embedding.provider}".\n` +
      `  Fix option 1 — add to ${CONFIG_FILE}:\n` +
      `    { "embedding": { "apiKey": "your-key-here" } }\n` +
      `  Fix option 2 — set environment variable:\n` +
      `    ${ENV.EMBED_KEY}=your-key-here`
    );
  }

  // Neo4j — if any field is provided, all three must be present
  if (config.neo4j) {
    const { url, username, password } = config.neo4j;
    if (!url || !username || !password) {
      throw new Error(
        `DevLens config error: neo4j config is incomplete.\n` +
        `  All three fields are required: url, username, password.\n` +
        `  Fix option 1 — update ${CONFIG_FILE}:\n` +
        `    { "neo4j": { "url": "bolt://localhost:7687", "username": "neo4j", "password": "..." } }\n` +
        `  Fix option 2 — set environment variables:\n` +
        `    ${ENV.NEO4J_URL}=bolt://localhost:7687\n` +
        `    ${ENV.NEO4J_USER}=neo4j\n` +
        `    ${ENV.NEO4J_PASSWORD}=your-password`
      );
    }
  }

  // Ollama baseUrl format
  if (summarization.providerName === "ollama") {
    const base = summarization.baseUrl ?? "http://localhost:11434/v1";
    if (!base.startsWith("http://") && !base.startsWith("https://")) {
      throw new Error(
        `DevLens config error: summarization.baseUrl must start with http:// or https://.\n` +
        `  Got: "${base}"`
      );
    }
  }
}

//  readFileConfig
//
// Reads ~/.devlens/config.json and returns a PartialConfig.
// Returns empty object if file doesn't exist — first run, caller uses defaults.
// Throws a clear parse error if file exists but contains invalid JSON.

function readFileConfig(): PartialConfig {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {}; // first run — no config file yet
  }

  const raw = fs.readFileSync(CONFIG_FILE, "utf-8");

  try {
    return JSON.parse(raw) as PartialConfig;
  } catch {
    throw new Error(
      `DevLens config error: ${CONFIG_FILE} contains invalid JSON.\n` +
      `  Fix the syntax and restart DevLens.\n` +
      `  Tip: use a JSON validator at https://jsonlint.com`
    );
  }
}

/** Public — reads the raw config.json as a plain object. Used by multi-provider helpers. */
export function readRawConfigFile(): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Multi-provider detection ──────────────────────────────────────────────

/** Returns true if the raw summarization block is in multi-provider format. */
function isMultiProviderFormat(s: unknown): s is MultiProviderStorage {
  if (!s || typeof s !== "object") return false;
  const obj = s as Record<string, unknown>;
  return (
    typeof obj.active === "string" &&
    obj.providers !== undefined &&
    typeof obj.providers === "object" &&
    !Array.isArray(obj.providers)
  );
}

/** Extract the active provider from multi-provider storage, returning a flat summarization partial. */
function extractActiveProvider(storage: MultiProviderStorage): PartialConfig["summarization"] {
  const entry = storage.providers[storage.active];
  if (!entry) {
    // Fallback: pick the first available provider
    const first = Object.values(storage.providers)[0];
    if (!first) throw new Error("Multi-provider config has no provider entries.");
    // Fix the active key to match what exists
    storage.active = Object.keys(storage.providers)[0];
    return {
      provider: first.provider as any,
      providerName: first.providerName,
      model: first.model,
      apiKey: first.apiKey,
      baseUrl: first.baseUrl,
      batchSize: first.batchSize,
    };
  }
  return {
    provider: entry.provider as any,
    providerName: entry.providerName,
    model: entry.model,
    apiKey: entry.apiKey,
    baseUrl: entry.baseUrl,
    batchSize: entry.batchSize,
  };
}

//  loadFileConfig 
//
// Public entry point — called by resolveConfig() in config/index.ts.
//
// Takes the active defaults (chosen by detectOllama() in index.ts):
//   - OLLAMA_DEFAULTS    if Ollama is running at startup
//   - ANTHROPIC_DEFAULTS if Ollama is not detected
//
// Steps:
//   1. Read ~/.devlens/config.json  (partial — only what user set)
//   2. Deep merge onto provided defaults
//   3. Apply env vars for any still-missing fields
//   4. Validate — throw clear errors for anything missing or invalid
//   5. Return fully resolved DevLensConfig — never partial, never undefined fields

export function loadFileConfig(
  defaults: DevLensConfig = ANTHROPIC_DEFAULTS
): DevLensConfig {
  let partial = readFileConfig();

  // ── Multi-provider detection & migration ─────────────────────────────────
  if (partial.summarization) {
    const sum = partial.summarization as Record<string, unknown>;

    if (isMultiProviderFormat(sum)) {
      // New multi-provider format — extract the active entry
      const activeFlat = extractActiveProvider(sum);
      partial = {
        ...partial,
        summarization: activeFlat,
      };
    } else if (typeof sum.provider === "string" && !sum.providers) {
      // Old flat format — migrate to multi-provider automatically
      const protocol = sum.provider as string;
      const providerName = (sum.providerName as string) ?? protocol;
      const key = makeProviderKey(protocol, providerName);
      const newStorage: MultiProviderStorage = {
        active: key,
        providers: {
          [key]: {
            provider:     protocol as ProviderConfigEntry["provider"],
            providerName: providerName,
            model:        (sum.model as string) ?? "",
            apiKey:       sum.apiKey as string | undefined,
            baseUrl:      sum.baseUrl as string | undefined,
            batchSize:    (sum.batchSize as number) ?? 50,
          },
        },
      };

      // Write the migrated format back atomically
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      raw.summarization = newStorage;
      const tmp = CONFIG_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
      fs.renameSync(tmp, CONFIG_FILE);
      // Proceed with the active entry as the flat summarization
      partial = {
        ...partial,
        summarization: {
          provider: protocol as any,
          providerName: providerName,
          model: (sum.model as string) ?? "",
          apiKey: sum.apiKey as string | undefined,
          baseUrl: sum.baseUrl as string | undefined,
          batchSize: (sum.batchSize as number) ?? 50,
        },
      };
    }
  }

  const merged = deepMerge(defaults, partial);
  const migrated = migrateProviderConfig(merged);
  const withEnv = applyEnvVars(migrated);

  validate(withEnv);

  return withEnv;
}
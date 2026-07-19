

export type LLMProvider = "openai" | "anthropic";   // wire protocol, NOT a brand

export type EmbeddingProvider =
  | "openai"       // text-embedding-3-small / text-embedding-3-large
  | "anthropic"    // voyage-3 via Anthropic API
  | "openrouter"   // passes through to various embedding models
  | "gemini"       // text-embedding-004
  | "ollama";      // nomic-embed-text — best local embedding model



export type DeploymentMode = "local" | "cloud";



export interface SummarizationConfig {
  provider:  LLMProvider;   // wire protocol: "openai" | "anthropic"
  providerName?: string;    // brand/identity e.g. "deepseek", "my-lmalite"
  model:     string;
  apiKey?:   string;
  baseUrl?:  string;        // resolved: config.json > catalog > SDK default
  batchSize: number;        // How many nodes to summarize per checkpoint batch before saving progress.
}

// ── Multi-provider storage types ───────────────────────────────────────────

/** A single provider entry stored in the multi-provider map on disk. */
export interface ProviderConfigEntry {
  provider:     LLMProvider;
  providerName: string;
  model:        string;
  apiKey?:      string;
  baseUrl?:     string;
  batchSize:    number;
}

/** Storage shape for `summarization` inside config.json (v2 multi-provider). */
export interface MultiProviderStorage {
  active:    string;                                  // composite key, e.g. "openai:deepseek"
  providers: Record<string, ProviderConfigEntry>;     // keyed by composite key
}

/** Derive the composite key from a protocol + providerName pair. */
export function makeProviderKey(protocol: string, providerName: string): string {
  return `${protocol}:${providerName}`;
}

/** Parse a composite key back into its parts. */
export function parseProviderKey(key: string): { protocol: string; providerName: string } {
  const idx = key.indexOf(":");
  if (idx === -1) throw new Error(`Invalid provider key: "${key}"`);
  return { protocol: key.slice(0, idx), providerName: key.slice(idx + 1) };
}

export interface EmbeddingConfig {
  provider:  EmbeddingProvider;
  model:     string;
  apiKey?:   string;    //cloud provider only
  baseUrl?:  string;    // Ollama only
}

// Neo4j is fully optional.
// Absent = file-only mode (no vectors, no graph traversal queries).
// Present = full mode (vectors stored, Step 10/11 query features unlocked).
export interface Neo4jConfig {
  url:      string;  
  username: string;
  password: string;
  storeRawCode: boolean;
}

// Top-Level Config
export interface DevLensConfig {
  deploymentMode: DeploymentMode;
  summarization:  SummarizationConfig;
  embedding:      EmbeddingConfig;
  neo4j?:         Neo4jConfig;  // absent = file-only mode, no vectors
}


// Note: apiKey is intentionally absent from all defaults.
// If a user reaches the defaults with no key configured anywhere,
// the system fails clearly at the LLM call — never silently sends an empty key.

export const OLLAMA_DEFAULTS: DevLensConfig = {
  deploymentMode: "local",

  summarization: {
    provider:  "openai",
    providerName: "ollama",
    model:     "qwen2.5-coder:3b",  // code-aware, 3B params, runs on ~2GB RAM
    baseUrl:   "http://localhost:11434/v1",
    batchSize: 50,
  },

  embedding: {
    provider: "ollama",
    model:    "nomic-embed-text",   // best local embedding model, 768 dims
    baseUrl:  "http://localhost:11434/v1",
  },

  // neo4j absent — file-only mode is the safe default
};

export const ANTHROPIC_DEFAULTS: DevLensConfig = {
  deploymentMode: "local",

  summarization: {
    provider:  "anthropic",
    providerName: "anthropic",
    model:     "claude-haiku-4-5",  // fastest Claude, cheapest, good code understanding
    baseUrl:   "https://api.anthropic.com",
    batchSize: 50,
    // apiKey intentionally absent — user must set in config.json
  },

  embedding: {
    provider: "openai",
    model:    "text-embedding-3-small", // most common, cheapest OpenAI embedding
    // apiKey intentionally absent
  },

  // neo4j absent
};

//  Request Header Names 
//
// Exact header names the cloud backend sends to this Bun backend.
// Defined as constants so they are never mistyped across files.
//
// The server layer MUST call sanitizeHeaders() before logging any request.
// Headers marked "NEVER LOG" must never appear in any log output.

export const CONFIG_HEADERS = {
  // LLM provider for summarization
  PROVIDER:   "x-llm-provider",    // e.g. "anthropic" — wire protocol
  PROVIDER_NAME: "x-llm-provider-name",  // e.g. "deepseek" — brand identity
  MODEL:      "x-llm-model",       // e.g. "claude-haiku-4-5"
  API_KEY:    "x-llm-key",         
  BASE_URL:   "x-llm-base-url",    // for Ollama: "http://localhost:11434"
  BATCH_SIZE: "x-batch-size",      // e.g. "30"

  EMBED_PROVIDER: "x-embed-provider",
  EMBED_MODEL:    "x-embed-model",
  EMBED_KEY:      "x-embed-key",      
  EMBED_BASE_URL: "x-embed-base-url", // for Ollama embedding

  
  NEO4J_URL:      "x-neo4j-url",
  NEO4J_USER:     "x-neo4j-user",
  NEO4J_PASSWORD: "x-neo4j-password", 
  NEO4J_STORECODE: "false",
} as const;

//  Sensitive Headers Set 
//
// Used by sanitizeHeaders() below.
// Add any new secret header here the moment it is added to CONFIG_HEADERS.

const SENSITIVE_HEADERS = new Set<string>([
  CONFIG_HEADERS.API_KEY,
  CONFIG_HEADERS.EMBED_KEY,
  CONFIG_HEADERS.NEO4J_PASSWORD,
]);

//  sanitizeHeaders 
//
// Call this before logging ANY request headers anywhere in the codebase.
// Replaces secret values with "[REDACTED]" so API keys never appear in logs.
//
// Usage:
//   console.log("Incoming headers:", sanitizeHeaders(Object.fromEntries(req.headers)));

export function sanitizeHeaders(
  headers: Record<string, string>
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    sanitized[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? "[REDACTED]"
      : value;
  }
  return sanitized;
}
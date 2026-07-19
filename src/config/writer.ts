//! The concept of local config file should only exist in open Source, and in case of deployment the apis for writing this cofig file should never be exposed. 

import fs   from "fs";
import { CONFIG_FILE, CONFIG_DIR } from "./providers/file.js";
import type { DevLensConfig, MultiProviderStorage, ProviderConfigEntry } from "./types.js";
import { makeProviderKey } from "./types.js";


// What the user can send from the settings UI.
// Every field is optional — user only sends what they changed.
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

type PartialConfig = DeepPartial<DevLensConfig>;

// What GET /api/config safely returns to the frontend.
// DevLens is OSS/local — apiKeys are returned in full (the user owns their keys).
export interface SafeConfig {
  deploymentMode: DevLensConfig["deploymentMode"];
  summarization: {
    provider:     string;
    providerName?: string;
    model:        string;
    baseUrl?:     string;
    batchSize:    number;
    apiKey?:      string;   // full key — OSS runs locally, user owns their key
  };
  // All configured providers for the multi-provider UI
  allProviders?: {
    active: string;
    providers: ProviderConfigEntry[];
  };
  embedding: {
    provider:   string;
    model:      string;
    baseUrl?:   string;
    apiKeyHint?: string;
  };
  neo4j?: {
    url:      string;
    username: string;
    storeRawCode: boolean;
    // password never returned — not even a hint
  };
}



function readRawFile(): PartialConfig {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8")) as PartialConfig;
  } catch {
    console.warn(`DevLens: config file is malformed, resetting to empty.`);
    return {};
  }
}

//  atomicWrite
// Writes to a temp file first, then renames to the real path.
// If the server crashes mid-write, the old config survives intact.

export function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

//  writeConfig ─
//
// Public — called by PATCH /api/config handler.
//
// Takes only what the user changed from the UI settings form.
// Merges it on top of whatever is currently in config.json.
// Writes the result back atomically.
//
// Does NOT merge with defaults or env vars — that is file.ts's job at read time.
// The file only ever contains what the user explicitly set.

export function writeConfig(partial: PartialConfig): void {
  // Ensure ~/.devlens/ exists — creates it on first save
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  const existing = readRawFile();

  // ── Multi-provider summarization upsert ──────────────────────────────────
  let summarizationUpdate: Record<string, unknown> | undefined;

  if (partial.summarization) {
    const s = partial.summarization as Record<string, unknown>;
    const protocol = (s.provider as string) ?? "openai";
    const providerName = (s.providerName as string) ?? protocol;
    const key = makeProviderKey(protocol, providerName);

    // Read existing multi-provider structure (or build from legacy flat format)
    const rawSum = existing.summarization as Record<string, unknown> | undefined;
    let storage: MultiProviderStorage;

    if (rawSum && typeof rawSum === "object" && rawSum.providers && typeof rawSum.providers === "object" && typeof rawSum.active === "string") {
      // Already multi-provider format
      storage = {
        active: rawSum.active as string,
        providers: rawSum.providers as Record<string, ProviderConfigEntry>,
      };
    } else {
      // Legacy flat format or first save — create fresh multi-provider storage
      storage = { active: key, providers: {} };
      // If there's a legacy flat config, preserve it as the first entry
      if (rawSum && typeof rawSum.provider === "string") {
        const legacyKey = makeProviderKey(
          rawSum.provider as string,
          (rawSum.providerName as string) ?? (rawSum.provider as string)
        );
        storage.providers[legacyKey] = {
          provider:     rawSum.provider as ProviderConfigEntry["provider"],
          providerName: (rawSum.providerName as string) ?? (rawSum.provider as string),
          model:        (rawSum.model as string) ?? "",
          apiKey:       rawSum.apiKey as string | undefined,
          baseUrl:      rawSum.baseUrl as string | undefined,
          batchSize:    (rawSum.batchSize as number) ?? 50,
        };
        if (legacyKey !== key) {
          storage.active = key; // new entry becomes active
        }
      }
    }

    // Upsert the incoming entry
    const existingEntry = storage.providers[key];
    storage.providers[key] = {
      provider:     (s.provider as ProviderConfigEntry["provider"]) ?? existingEntry?.provider ?? "openai",
      providerName: providerName,
      model:        (s.model as string) ?? existingEntry?.model ?? "",
      apiKey:       (s.apiKey as string | undefined) ?? existingEntry?.apiKey,
      baseUrl:      (s.baseUrl as string | undefined) ?? existingEntry?.baseUrl,
      batchSize:    (s.batchSize as number | undefined) ?? existingEntry?.batchSize ?? 50,
    };
    storage.active = key;

    summarizationUpdate = storage as unknown as Record<string, unknown>;
  }

  const updated: PartialConfig = {
    ...existing,

    ...(partial.deploymentMode && {
      deploymentMode: partial.deploymentMode,
    }),

    ...(summarizationUpdate && {
      summarization: summarizationUpdate,
    }),

    ...(partial.embedding && {
      embedding: {
        ...existing.embedding,
        ...partial.embedding,
      },
    }),

    // neo4j: if user sent it, merge. If user sent null explicitly, delete it.
    ...(partial.neo4j !== undefined && {
      neo4j: partial.neo4j === null
        ? undefined
        : {
            ...existing.neo4j,
            ...partial.neo4j,
          },
    }),
  };

  atomicWrite(CONFIG_FILE, JSON.stringify(updated, null, 2));
}

function maskKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  // Show last 3 characters only — enough to identify which key is set
  return `...${key.slice(-3)}`;
}

//  maskConfig
// Public — called by GET /api/config handler.
// DevLens is OSS/local: apiKeys are returned in full (the user owns their keys).
export function maskConfig(config: DevLensConfig): SafeConfig {
  return {
    deploymentMode: config.deploymentMode,

    summarization: {
      provider:     config.summarization.provider,
      providerName: config.summarization.providerName,
      model:        config.summarization.model,
      baseUrl:      config.summarization.baseUrl,
      batchSize:    config.summarization.batchSize,
      apiKey:       config.summarization.apiKey,  // full key for OSS
    },

    embedding: {
      provider:   config.embedding.provider,
      model:      config.embedding.model,
      baseUrl:    config.embedding.baseUrl,
      apiKeyHint: maskKey(config.embedding.apiKey),
    },

    // neo4j: return url, storeCode, and username only — password never sent to browser
    ...(config.neo4j && {
      neo4j: {
        url:      config.neo4j.url,
        username: config.neo4j.username,
        storeRawCode: config.neo4j.storeRawCode,
      },
    }),
  };
}
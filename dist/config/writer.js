//! The concept of local config file should only exist in open Source, and in case of deployment the apis for writing this cofig file should never be exposed. 
import fs from "fs";
import { CONFIG_FILE, CONFIG_DIR } from "./providers/file.js";
import { makeProviderKey } from "./types.js";
function readRawFile() {
    if (!fs.existsSync(CONFIG_FILE))
        return {};
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    }
    catch {
        console.warn(`DevLens: config file is malformed, resetting to empty.`);
        return {};
    }
}
//  atomicWrite
// Writes to a temp file first, then renames to the real path.
// If the server crashes mid-write, the old config survives intact.
export function atomicWrite(filePath, content) {
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
export function writeConfig(partial) {
    // Ensure ~/.devlens/ exists — creates it on first save
    if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    const existing = readRawFile();
    // ── Multi-provider summarization upsert ──────────────────────────────────
    let summarizationUpdate;
    if (partial.summarization) {
        const s = partial.summarization;
        const protocol = s.provider ?? "openai";
        const providerName = s.providerName ?? protocol;
        const key = makeProviderKey(protocol, providerName);
        // Read existing multi-provider structure (or build from legacy flat format)
        const rawSum = existing.summarization;
        let storage;
        if (rawSum && typeof rawSum === "object" && rawSum.providers && typeof rawSum.providers === "object" && typeof rawSum.active === "string") {
            // Already multi-provider format
            storage = {
                active: rawSum.active,
                providers: rawSum.providers,
            };
        }
        else {
            // Legacy flat format or first save — create fresh multi-provider storage
            storage = { active: key, providers: {} };
            // If there's a legacy flat config, preserve it as the first entry
            if (rawSum && typeof rawSum.provider === "string") {
                const legacyKey = makeProviderKey(rawSum.provider, rawSum.providerName ?? rawSum.provider);
                storage.providers[legacyKey] = {
                    provider: rawSum.provider,
                    providerName: rawSum.providerName ?? rawSum.provider,
                    model: rawSum.model ?? "",
                    apiKey: rawSum.apiKey,
                    baseUrl: rawSum.baseUrl,
                    batchSize: rawSum.batchSize ?? 50,
                };
                if (legacyKey !== key) {
                    storage.active = key; // new entry becomes active
                }
            }
        }
        // Upsert the incoming entry
        const existingEntry = storage.providers[key];
        storage.providers[key] = {
            provider: s.provider ?? existingEntry?.provider ?? "openai",
            providerName: providerName,
            model: s.model ?? existingEntry?.model ?? "",
            apiKey: s.apiKey ?? existingEntry?.apiKey,
            baseUrl: s.baseUrl ?? existingEntry?.baseUrl,
            batchSize: s.batchSize ?? existingEntry?.batchSize ?? 50,
        };
        storage.active = key;
        summarizationUpdate = storage;
    }
    const updated = {
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
function maskKey(key) {
    if (!key)
        return undefined;
    // Show last 3 characters only — enough to identify which key is set
    return `...${key.slice(-3)}`;
}
//  maskConfig
// Public — called by GET /api/config handler.
// DevLens is OSS/local: apiKeys are returned in full (the user owns their keys).
export function maskConfig(config) {
    return {
        deploymentMode: config.deploymentMode,
        summarization: {
            provider: config.summarization.provider,
            providerName: config.summarization.providerName,
            model: config.summarization.model,
            baseUrl: config.summarization.baseUrl,
            batchSize: config.summarization.batchSize,
            apiKey: config.summarization.apiKey, // full key for OSS
        },
        embedding: {
            provider: config.embedding.provider,
            model: config.embedding.model,
            baseUrl: config.embedding.baseUrl,
            apiKeyHint: maskKey(config.embedding.apiKey),
        },
        // neo4j: return url, storeCode, and username only — password never sent to browser
        ...(config.neo4j && {
            neo4j: {
                url: config.neo4j.url,
                username: config.neo4j.username,
                storeRawCode: config.neo4j.storeRawCode,
            },
        }),
    };
}

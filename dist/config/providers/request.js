import { CONFIG_HEADERS } from "../types.js";
const VALID_LLM_PROTOCOLS = new Set(["openai", "anthropic"]);
const VALID_EMBED_PROTOCOLS = new Set(["openai", "anthropic", "openrouter", "gemini", "ollama"]);
function rejectPlaceholder(v) {
    if (!v)
        return undefined;
    // Dot-notation field references like "embedding.provider", "summarization.key"
    if (/^[a-z]+\.[a-zA-Z]/.test(v))
        return undefined;
    return v;
}
// ─ applyRequestHeaders
//
// Public — called by resolveConfig() in config/index.ts AFTER loadFileConfig().
//
// Takes the fully resolved file config as a base and overrides only the fields
// that are explicitly present in the request headers.
//
// Headers that are absent = keep the file config value unchanged.
// Headers that are present = override the file config value.
//
// This means a cloud user who only sends x-llm-key gets everything else
// (model, batchSize, etc.) from their file config or defaults.
//
// IMPORTANT: This function must never be called in local deploymentMode.
// The guard lives in resolveConfig() in index.ts — not here.
// This function trusts that its caller checked deploymentMode first.
//
// Priority after this runs:
//   request headers > file config > env vars > defaults
export function applyRequestHeaders(base, req) {
    const h = req.headers;
    // Helper — reads a header, returns undefined if absent or empty string
    function get(name) {
        const val = h.get(name);
        return (val && val.trim() !== "") ? val.trim() : undefined;
    }
    //  Summarization overrides ─
    const provider = get(CONFIG_HEADERS.PROVIDER);
    const providerName = rejectPlaceholder(get(CONFIG_HEADERS.PROVIDER_NAME));
    const model = rejectPlaceholder(get(CONFIG_HEADERS.MODEL));
    const apiKey = rejectPlaceholder(get(CONFIG_HEADERS.API_KEY));
    const baseUrl = (() => { const v = get(CONFIG_HEADERS.BASE_URL); return v && (v.startsWith("http://") || v.startsWith("https://")) ? v : undefined; })();
    const batchSize = get(CONFIG_HEADERS.BATCH_SIZE);
    //  Embedding overrides ─
    const embedProvider = get(CONFIG_HEADERS.EMBED_PROVIDER);
    const embedModel = rejectPlaceholder(get(CONFIG_HEADERS.EMBED_MODEL));
    const embedKey = rejectPlaceholder(get(CONFIG_HEADERS.EMBED_KEY));
    const embedBaseUrl = (() => { const v = get(CONFIG_HEADERS.EMBED_BASE_URL); return v && (v.startsWith("http://") || v.startsWith("https://")) ? v : undefined; })();
    //  Neo4j overrides ─
    const neo4jUrl = get(CONFIG_HEADERS.NEO4J_URL);
    const neo4jUser = get(CONFIG_HEADERS.NEO4J_USER);
    const neo4jPassword = get(CONFIG_HEADERS.NEO4J_PASSWORD);
    const neo4jStoreCode = get(CONFIG_HEADERS.NEO4J_STORECODE) == "true";
    // Build the final config — only override what headers explicitly provided
    const result = {
        // deploymentMode is never overridden by headers —
        // it is set by the server at startup, not by the cloud backend
        deploymentMode: base.deploymentMode,
        summarization: {
            ...base.summarization,
            ...(provider && VALID_LLM_PROTOCOLS.has(provider) && { provider: provider }),
            ...(providerName && { providerName }),
            ...(model && { model }),
            ...(apiKey && { apiKey }),
            ...(baseUrl && { baseUrl }),
            ...(batchSize && { batchSize: parseInt(batchSize, 10) }),
        },
        embedding: {
            ...base.embedding,
            ...(embedProvider && VALID_EMBED_PROTOCOLS.has(embedProvider) && { provider: embedProvider }),
            ...(embedModel && { model: embedModel }),
            ...(embedKey && { apiKey: embedKey }),
            ...(embedBaseUrl && { baseUrl: embedBaseUrl }),
        },
        // Neo4j: only override if ALL THREE headers are present
        // Partial Neo4j config from headers is never valid —
        // if only one header is sent we keep the base neo4j config untouched
        neo4j: (neo4jUrl && neo4jUser && neo4jPassword)
            ? { url: neo4jUrl, username: neo4jUser, password: neo4jPassword, storeRawCode: neo4jStoreCode }
            : base.neo4j,
    };
    return result;
}

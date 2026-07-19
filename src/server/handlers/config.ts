import { resolveConfig, maskConfig, writeConfig } from "../../config/index.js";
import type { DevLensConfig } from "../../config/index.js";
import { loadCatalog, saveProvider, removeProvider, resetUserCatalog } from "../../config/providers/catalog.js";
import type { CatalogProviderInput } from "../../config/providers/catalog.js";
import { listModels } from "../../summarizer/providers/models.js";

// ─── In-memory model-list cache ──────────────────────────────────────────────
// Keyed by "name|baseUrl", TTL ~5 minutes to avoid hammering provider APIs.

const modelCache = new Map<string, { models: string[]; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCachedModels(key: string): string[] | undefined {
  const entry = modelCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.models;
  modelCache.delete(key);
  return undefined;
}

function setCachedModels(key: string, models: string[]): void {
  modelCache.set(key, { models, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── GET /api/config ─────────────────────────────────────────────────────────

export function handleGetConfig(req: Request): Response {
  try {
    const config = resolveConfig(req);
    const safe   = maskConfig(config);
    return Response.json({ success: true, data: safe });
  } catch {
    return Response.json({ success: true, data: {} });
  }
}

// ─── PATCH /api/config ───────────────────────────────────────────────────────

export async function handlePatchConfig(req: Request): Promise<Response> {
  let deploymentMode = "local";
  try {
    const current = resolveConfig(req);
    deploymentMode = current.deploymentMode;
  } catch {
    // No valid config yet — let user set one up
  }

  if (deploymentMode === "cloud") {
    return Response.json(
      {
        success: false,
        error:   "Config cannot be modified in cloud deployment mode.",
        hint:    "Update settings via the cloud dashboard instead.",
      },
      { status: 403 }
    );
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { success: false, error: "Body must be a JSON object" },
      { status: 400 }
    );
  }

  // ── Validate provider values if provided ────────────────────────────────
  const VALID_LLM_PROVIDERS       = new Set(["openai", "anthropic"]);
  const VALID_EMBEDDING_PROVIDERS = new Set(["openai", "anthropic", "openrouter", "gemini", "ollama"]);

  const partial = body as Record<string, unknown>;
  if (partial.summarization) {
    const s = partial.summarization as Record<string, unknown>;
    if (s.provider && !VALID_LLM_PROVIDERS.has(s.provider as string)) {
      return Response.json(
        {
          success: false,
          error:   `Invalid summarization protocol: "${s.provider}"`,
          valid:   [...VALID_LLM_PROVIDERS],
        },
        { status: 400 }
      );
    }
    if (s.providerName !== undefined && (typeof s.providerName !== "string" || s.providerName.trim() === "")) {
      return Response.json(
        { success: false, error: "providerName must be a non-empty string if provided" },
        { status: 400 }
      );
    }
    if (s.batchSize !== undefined) {
      const size = Number(s.batchSize);
      if (!Number.isInteger(size) || size < 1 || size > 500) {
        return Response.json(
          {
            success: false,
            error:   "batchSize must be an integer between 1 and 500",
          },
          { status: 400 }
        );
      }
    }
  }

  if (partial.embedding) {
    const e = partial.embedding as Record<string, unknown>;
    if (e.provider && !VALID_EMBEDDING_PROVIDERS.has(e.provider as string)) {
      return Response.json(
        {
          success: false,
          error:   `Invalid embedding provider: "${e.provider}"`,
          valid:   [...VALID_EMBEDDING_PROVIDERS],
        },
        { status: 400 }
      );
    }
  }

  // ── Write to disk ───────────────────────────────────────────────────────
  try {
    writeConfig(partial as Parameters<typeof writeConfig>[0]);
  } catch (err) {
    return Response.json(
      {
        success: false,
        error:   err instanceof Error ? err.message : "Failed to write config",
      },
      { status: 500 }
    );
  }

  // ── Return updated masked config ────────────────────────────────────────
  try {
    const updated = resolveConfig(req);
    const safe    = maskConfig(updated);
    return Response.json({
      success: true,
      data:    safe,
      message: "Config saved successfully.",
    });
  } catch {
    return Response.json({
      success: true,
      data:    {},
      message: "Config saved. Complete your setup to enable summarization.",
    });
  }
}

// ─── GET /api/providers ──────────────────────────────────────────────────────
// Returns the full provider catalog (no models — fetched separately).

export function handleGetProviders(): Response {
  const catalog = loadCatalog();
  return Response.json({ success: true, data: catalog });
}

// ─── GET /api/providers/:name/models ─────────────────────────────────────────
// Resolves a known provider by name, reads stored apiKey + baseUrl from config,
// calls listModels(). Caches ~5 min keyed by name.
// On failure, returns { models: [], error, fallback: true } (HTTP 200).

export async function handleGetProviderModels(
  _params: Record<string, string>,
  req: Request
): Promise<Response> {
  const name = _params.name;
  if (!name) {
    return Response.json(
      { success: false, error: "Provider name is required" },
      { status: 400 }
    );
  }

  const catalog = loadCatalog();
  const entry = catalog.find(p => p.name === name);
  if (!entry) {
    return Response.json(
      { success: false, error: `Unknown provider: "${name}"` },
      { status: 404 }
    );
  }

  // Check cache
  const cacheKey = name;
  const cached = getCachedModels(cacheKey);
  if (cached) {
    return Response.json({ success: true, data: { models: cached } });
  }

  // Resolve apiKey + baseUrl from stored config
  let config: DevLensConfig;
  try {
    config = resolveConfig(req);
  } catch {
    config = null as any; // will fail below with clear error
  }

  const apiKey = config?.summarization?.apiKey;
  // Only use stored baseUrl when it was saved for THIS specific provider;
  // otherwise it's stale from a previous provider and would break the request.
  const storedProviderName = config?.summarization?.providerName;
  const storedBaseUrl     = config?.summarization?.baseUrl;
  const baseUrl = (storedProviderName === entry.name && storedBaseUrl)
    ? storedBaseUrl
    : entry.baseUrl;

  try {
    const models = await listModels({ protocol: entry.protocol, baseUrl, apiKey });
    setCachedModels(cacheKey, models);
    return Response.json({ success: true, data: { models } });
  } catch (err: any) {
    return Response.json({
      success: true,
      data: { models: [], error: err.message ?? "Failed to fetch models", fallback: true },
    });
  }
}

// ─── POST /api/providers/models ──────────────────────────────────────────────
// Lists models for a custom (not-yet-saved) endpoint.
// Body: { protocol, baseUrl, apiKey }
// Does NOT persist anything — pure discovery.

export async function handlePostProviderModels(req: Request): Promise<Response> {
  let body: { protocol?: string; baseUrl?: string; apiKey?: string };
  try {
    body = await req.json() as { protocol?: string; baseUrl?: string; apiKey?: string };
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { protocol, baseUrl, apiKey } = body ?? {};
  if (protocol !== "openai" && protocol !== "anthropic") {
    return Response.json(
      { success: false, error: 'protocol must be "openai" or "anthropic"' },
      { status: 400 }
    );
  }
  if (!baseUrl || typeof baseUrl !== "string") {
    return Response.json(
      { success: false, error: "baseUrl is required" },
      { status: 400 }
    );
  }

  // Check cache by baseUrl
  const cacheKey = `custom|${baseUrl}`;
  const cached = getCachedModels(cacheKey);
  if (cached) {
    return Response.json({ success: true, data: { models: cached } });
  }

  try {
    const models = await listModels({ protocol, baseUrl, apiKey });
    setCachedModels(cacheKey, models);
    return Response.json({ success: true, data: { models } });
  } catch (err: any) {
    return Response.json({
      success: true,
      data: { models: [], error: err.message ?? "Failed to fetch models", fallback: true },
    });
  }
}

// ─── POST /api/providers ──────────────────────────────────────────────────────
// Save (upsert) a custom provider to the user's providers.json.

export async function handlePostProvider(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const entry = saveProvider(body as CatalogProviderInput);
    return Response.json({ success: true, data: entry });
  } catch (err: any) {
    return Response.json({ success: false, error: err.message }, { status: 400 });
  }
}

// ─── DELETE /api/providers/:name ─────────────────────────────────────────────
// Remove a user override entry by name.

export function handleDeleteProvider(params: Record<string, string>): Response {
  const name = params.name;
  if (!name) {
    return Response.json({ success: false, error: "Provider name is required" }, { status: 400 });
  }
  const removed = removeProvider(name);
  return Response.json({ success: true, data: { removed } });
}

// ─── POST /api/providers/reset ───────────────────────────────────────────────
// Delete the entire user providers.json — reverts to shipped defaults.

export function handleResetProviders(): Response {
  resetUserCatalog();
  return Response.json({ success: true, message: "Provider catalog reset to defaults." });
}

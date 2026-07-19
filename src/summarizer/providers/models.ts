export interface ListModelsOpts {
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey?: string;
}

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches the live model list from a provider's models endpoint.
 * Returns deduped (case-insensitive), sorted model ID strings.
 * Throws on auth/network errors with a clear message.
 */
export async function listModels(opts: ListModelsOpts): Promise<string[]> {
  if (opts.protocol === "openai") {
    return listOpenAIModels(opts.baseUrl, opts.apiKey);
  }
  return listAnthropicModels(opts.baseUrl, opts.apiKey);
}

//  OpenAI-style lister
// GET {baseUrl}/models  |  Authorization: Bearer {apiKey}
// Tolerant of URLs with or without /v1 — tries as-is first, retries with /v1 if empty.

async function listOpenAIModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  async function tryFetch(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { method: "GET", headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const cleanBase = baseUrl.replace(/\/+$/, "");
  let res = await tryFetch(`${cleanBase}/models`);

  // If URL has no /v1 segment and the request returned nothing useful, retry with /v1
  if (!res.ok && !cleanBase.includes("/v1")) {
    res = await tryFetch(`${cleanBase}/v1/models`);
  }

  if (res.status === 401) {
    throw new Error("Invalid API key for this provider. Check your key in config.");
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch models: ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return normalizeModels((body.data ?? []).map((m) => m.id));
}

//  Anthropic-style lister 
// GET {baseUrl}/v1/models  |  x-api-key + anthropic-version
// Paginated — loops via after_id until has_more === false

async function listAnthropicModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  if (!apiKey) {
    throw new Error("Anthropic-style provider requires an API key to list models.");
  }

  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };

  const base = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const allIds: string[] = [];
  let afterId: string | undefined;
  let hasMore = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    while (hasMore) {
      const url = afterId
        ? `${base}?after_id=${afterId}&limit=1000`
        : `${base}?limit=1000`;

      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (res.status === 401) {
        throw new Error("Invalid API key for this provider. Check your key in config.");
      }
      if (!res.ok) {
        throw new Error(`Failed to fetch models: ${res.status} ${res.statusText}`);
      }

      const body = (await res.json()) as {
        data?: Array<{ id: string; display_name?: string }>;
        has_more?: boolean;
        last_id?: string;
      };

      allIds.push(...(body.data ?? []).map((m) => m.id));
      hasMore = body.has_more ?? false;
      afterId = body.last_id;
    }

    return normalizeModels(allIds);
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error(`Timed out fetching models from ${baseUrl} after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

//  Normalization 
// Dedupe case-insensitively, sort ascending.

function normalizeModels(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of models) {
    const key = m.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(m);
    }
  }
  result.sort((a, b) => a.localeCompare(b));
  return result;
}
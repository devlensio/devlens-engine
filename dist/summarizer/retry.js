// Exponential backoff retry for LLM summarization calls.
//
// Retryable: rate limits (429), server errors (5xx), network errors (ECONNRESET etc.)
// Not retryable: auth (401/403), not-found (404), bad-request (400) — retrying won't help.
export const DEFAULT_RETRY_OPTIONS = {
    maxAttempts: 4, // 1 initial + 3 retries
    baseDelayMs: 1000,
    maxDelayMs: 15000,
};
function isRetryable(err) {
    const status = err?.status ?? err?.statusCode;
    if (typeof status === "number") {
        if (status === 400 || status === 401 || status === 403 || status === 404)
            return false;
        if (status === 429 || status >= 500)
            return true;
    }
    const code = err?.code;
    if (typeof code === "string" &&
        ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EPIPE"].includes(code)) {
        return true;
    }
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return msg.includes("timeout") || msg.includes("connection") ||
        msg.includes("network") || msg.includes("socket") ||
        msg.includes("fetch failed");
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
export async function withRetry(fn, opts = DEFAULT_RETRY_OPTIONS, label = "operation") {
    for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
        try {
            return await fn();
        }
        catch (err) {
            const isLast = attempt === opts.maxAttempts - 1;
            if (!isRetryable(err) || isLast)
                throw err;
            // Exponential backoff with ±10% jitter to avoid thundering herd
            const base = opts.baseDelayMs * 2 ** attempt;
            const jitter = base * 0.1 * (Math.random() * 2 - 1);
            const wait = Math.min(base + jitter, opts.maxDelayMs);
            console.warn(`[retry] ${label} — attempt ${attempt + 1}/${opts.maxAttempts} failed, ` +
                `retrying in ${Math.round(wait)}ms — ${err instanceof Error ? err.message : err}`);
            await sleep(wait);
        }
    }
    // unreachable — loop always throws or returns
    throw new Error("withRetry: exhausted attempts");
}

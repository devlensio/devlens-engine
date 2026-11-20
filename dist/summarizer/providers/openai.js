import OpenAI from "openai";
import { requireCompletionText, wrapProviderError } from "./errors.js";
// ─── Response Parser ──────────────────────────────────────────────────────────
//
// Same XML format as anthropic.ts — consistent across all providers.
// Prompt in prompts.ts always requests this format regardless of provider.
const VALID_SEVERITIES = new Set(["none", "low", "medium", "high"]);
function parseXmlTag(text, tag) {
    const match = text.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    return match ? match[1].trim() : "";
}
function parseResponse(raw) {
    const technicalSummary = parseXmlTag(raw, "technical");
    const businessSummary = parseXmlTag(raw, "business");
    const severityRaw = parseXmlTag(raw, "security_severity").toLowerCase();
    const securitySummary = parseXmlTag(raw, "security_summary");
    const severity = VALID_SEVERITIES.has(severityRaw)
        ? severityRaw
        : "none";
    return {
        technicalSummary: technicalSummary || raw.trim(),
        businessSummary: businessSummary || "",
        security: {
            severity,
            summary: severity === "none" ? "" : securitySummary,
        },
        tokensUsed: 0,
    };
}
// Also used as the base for other OpenAI-compatible providers —
// both expose OpenAI-compatible APIs, just with a different baseURL.
export class OpenAIClient {
    constructor(apiKey, model, baseURL, providerName) {
        this.provider = "openai";
        this.model = model;
        this.providerName = providerName;
        this.client = new OpenAI({ apiKey, maxRetries: 0, ...(baseURL ? { baseURL } : {}) });
    }
    async summarize(request) {
        let response;
        try {
            response = await this.client.chat.completions.create({
                model: this.model,
                temperature: request.temperature ?? 0,
                max_tokens: request.maxTokens ?? 2048,
                messages: request.messages.map(m => ({ role: m.role, content: m.content })),
            });
        }
        catch (err) {
            // SDK/network errors: normalise so the retry layer sees a status and the
            // job log says what happened instead of "fetch failed".
            throw wrapProviderError(err, { provider: this.providerName ?? this.provider, model: this.model });
        }
        // Some gateways answer 200 with {"error": ...} or an empty choices array.
        // Reading choices[0] blindly threw "undefined is not an object" and killed
        // the whole run; this raises a message that names the provider and the body.
        const raw = requireCompletionText(response, {
            provider: this.providerName ?? this.provider,
            model: this.model,
        });
        const finish = response?.choices?.[0]?.finish_reason;
        if (finish === "length") {
            console.warn(`[summarizer] ${this.model} hit max_tokens — the summary was truncated.`);
        }
        const result = parseResponse(raw);
        const usage = response?.usage;
        result.tokensUsed = usage
            ? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0))
            : 0;
        return result;
    }
    async validateConnection() {
        try {
            await this.client.chat.completions.create({
                model: this.model,
                max_tokens: 10,
                messages: [{ role: "user", content: "hi" }],
            });
        }
        catch (err) {
            const status = err?.status ?? err?.statusCode;
            if (status === 401)
                throw new Error(`API key is invalid or missing. Check your key in config.`);
            if (status === 403)
                throw new Error(`API key does not have permission to use model "${this.model}".`);
            if (status === 404)
                throw new Error(`Model "${this.model}" not found. Check model name in config.`);
            if (status === 429)
                throw new Error(`Rate limit hit during connection check. Try again shortly.`);
            throw new Error(`LLM connection failed: ${err?.message ?? "unknown error"}`);
        }
    }
}

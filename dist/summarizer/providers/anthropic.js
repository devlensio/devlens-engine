import Anthropic from "@anthropic-ai/sdk";
// ─── Response Parser ──────────────────────────────────────────────────────────
//
// LLM is prompted to return strict XML — simple and reliable to parse.
// Falls back gracefully if a tag is missing rather than throwing.
//
// Expected format:
//   <technical>...</technical>
//   <business>...</business>
//   <security_severity>none|low|medium|high</security_severity>
//   <security_summary>...</security_summary>
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
        technicalSummary: technicalSummary || raw.trim(), // fallback: use raw if parse fails
        businessSummary: businessSummary || "",
        security: {
            severity,
            summary: severity === "none" ? "" : securitySummary,
        },
        tokensUsed: 0, // populated after API call
    };
}
export class AnthropicClient {
    constructor(apiKey, model) {
        this.provider = "anthropic";
        this.model = model;
        this.client = new Anthropic({ apiKey });
    }
    async summarize(request) {
        const systemMessage = request.messages.find(m => m.role === "system");
        const userMessages = request.messages.filter(m => m.role !== "system");
        const response = await this.client.messages.create({
            model: this.model,
            max_tokens: request.maxTokens ?? 2048,
            temperature: request.temperature ?? 0,
            system: systemMessage?.content,
            messages: userMessages.map(m => ({ role: m.role, content: m.content })),
        });
        const raw = response.content[0].type === "text" ? response.content[0].text : "";
        const result = parseResponse(raw);
        result.tokensUsed = (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0);
        return result;
    }
    async validateConnection() {
        try {
            // Minimal call — 1 token in, 1 token out, just to verify key + model are valid
            await this.client.messages.create({
                model: this.model,
                max_tokens: 10,
                messages: [{ role: "user", content: "hi" }],
            });
        }
        catch (err) {
            const status = err?.status ?? err?.statusCode;
            if (status === 401)
                throw new Error(`Anthropic API key is invalid or missing. Check your key in config.`);
            if (status === 403)
                throw new Error(`Anthropic API key does not have permission to use model "${this.model}".`);
            if (status === 404)
                throw new Error(`Anthropic model "${this.model}" not found. Check model name in config.`);
            if (status === 429)
                throw new Error(`Anthropic rate limit hit during connection check. Try again shortly.`);
            throw new Error(`Anthropic connection failed: ${err?.message ?? "unknown error"}`);
        }
    }
}

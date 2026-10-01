// providers/index.ts has one job — given the config, return the right LLMClient instance.
// It's the factory that the batch loop calls so it never has to know which provider is being used.
// The switch has exactly 2 arms: the two wire protocols (openai, anthropic).
// Brand identity (providerName) is data — resolved from the catalog or user input.
import { findProvider } from "../../config/providers/catalog.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAIClient } from "./openai.js";
export function createLLMClient(config) {
    const { provider, providerName, model, apiKey, baseUrl } = config;
    const entry = findProvider(providerName ?? "");
    const needsKey = entry?.requiresKey ?? true; // unknown/custom → require key
    const effectiveBase = baseUrl ?? entry?.baseUrl;
    switch (provider) {
        case "openai": {
            if (!apiKey)
                throw new Error(`No API key configured for "${providerName}" — run "devlens init" to set one up.`);
            return new OpenAIClient(apiKey, model, effectiveBase, providerName);
        }
        case "anthropic": {
            if (!apiKey)
                throw new Error(`No API key configured for "${providerName}" — run "devlens init" to set one up.`);
            return new AnthropicClient(apiKey, model, effectiveBase, providerName);
        }
        default:
            throw new Error(`Unknown provider protocol: ${provider}`);
    }
}

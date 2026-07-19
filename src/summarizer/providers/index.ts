// providers/index.ts has one job — given the config, return the right LLMClient instance.
// It's the factory that the batch loop calls so it never has to know which provider is being used.
// The switch has exactly 2 arms: the two wire protocols (openai, anthropic).
// Brand identity (providerName) is data — resolved from the catalog or user input.

import type { SummarizationConfig } from "../../config/types.js";
import { findProvider } from "../../config/providers/catalog.js";
import { AnthropicClient } from "./anthropic.js";
import { OpenAIClient } from "./openai.js";
import type { LLMClient } from "./types.js";

export function createLLMClient(config: SummarizationConfig): LLMClient {
  const { provider, providerName, model, apiKey, baseUrl } = config;
  const entry = findProvider(providerName ?? "");
  const needsKey = entry?.requiresKey ?? true;   // unknown/custom → require key
  const effectiveBase = baseUrl ?? entry?.baseUrl;

  switch (provider) {
    case "openai": {
      if (needsKey && !apiKey)
        throw new Error(`Provider "${providerName}" requires an API key`);
      return new OpenAIClient(apiKey ?? "ollama", model, effectiveBase, providerName);
    }
    case "anthropic": {
      if (!apiKey)
        throw new Error(`Provider "${providerName}" requires an API key`);
      return new AnthropicClient(apiKey, model, effectiveBase, providerName);
    }
    default:
      throw new Error(`Unknown provider protocol: ${provider}`);
  }
}

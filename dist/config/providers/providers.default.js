export const DEFAULT_PROVIDERS = [
    { name: "deepseek", label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com", requiresKey: true },
    { name: "openai", label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", requiresKey: true },
    { name: "anthropic", label: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com", requiresKey: true },
    { name: "gemini", label: "Google Gemini", protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", requiresKey: true },
    { name: "groq", label: "Groq", protocol: "openai", baseUrl: "https://api.groq.com/openai/v1", requiresKey: true },
    { name: "mistral", label: "Mistral", protocol: "openai", baseUrl: "https://api.mistral.ai/v1", requiresKey: true },
    { name: "xai", label: "xAI Grok", protocol: "openai", baseUrl: "https://api.x.ai/v1", requiresKey: true },
    { name: "openrouter", label: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1", requiresKey: true },
    { name: "ollama", label: "Ollama (local)", protocol: "openai", baseUrl: "http://localhost:11434/v1", requiresKey: false },
];
export const CATALOG_VERSION = 2;

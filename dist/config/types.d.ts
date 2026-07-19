export type LLMProvider = "openai" | "anthropic";
export type EmbeddingProvider = "openai" | "anthropic" | "openrouter" | "gemini" | "ollama";
export type DeploymentMode = "local" | "cloud";
export interface SummarizationConfig {
    provider: LLMProvider;
    providerName?: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    batchSize: number;
}
/** A single provider entry stored in the multi-provider map on disk. */
export interface ProviderConfigEntry {
    provider: LLMProvider;
    providerName: string;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    batchSize: number;
}
/** Storage shape for `summarization` inside config.json (v2 multi-provider). */
export interface MultiProviderStorage {
    active: string;
    providers: Record<string, ProviderConfigEntry>;
}
/** Derive the composite key from a protocol + providerName pair. */
export declare function makeProviderKey(protocol: string, providerName: string): string;
/** Parse a composite key back into its parts. */
export declare function parseProviderKey(key: string): {
    protocol: string;
    providerName: string;
};
export interface EmbeddingConfig {
    provider: EmbeddingProvider;
    model: string;
    apiKey?: string;
    baseUrl?: string;
}
export interface Neo4jConfig {
    url: string;
    username: string;
    password: string;
    storeRawCode: boolean;
}
export interface DevLensConfig {
    deploymentMode: DeploymentMode;
    summarization: SummarizationConfig;
    embedding: EmbeddingConfig;
    neo4j?: Neo4jConfig;
}
export declare const OLLAMA_DEFAULTS: DevLensConfig;
export declare const ANTHROPIC_DEFAULTS: DevLensConfig;
export declare const CONFIG_HEADERS: {
    readonly PROVIDER: "x-llm-provider";
    readonly PROVIDER_NAME: "x-llm-provider-name";
    readonly MODEL: "x-llm-model";
    readonly API_KEY: "x-llm-key";
    readonly BASE_URL: "x-llm-base-url";
    readonly BATCH_SIZE: "x-batch-size";
    readonly EMBED_PROVIDER: "x-embed-provider";
    readonly EMBED_MODEL: "x-embed-model";
    readonly EMBED_KEY: "x-embed-key";
    readonly EMBED_BASE_URL: "x-embed-base-url";
    readonly NEO4J_URL: "x-neo4j-url";
    readonly NEO4J_USER: "x-neo4j-user";
    readonly NEO4J_PASSWORD: "x-neo4j-password";
    readonly NEO4J_STORECODE: "false";
};
export declare function sanitizeHeaders(headers: Record<string, string>): Record<string, string>;

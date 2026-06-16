export type LLMProvider = "anthropic" | "openai" | "openrouter" | "gemini" | "ollama" | "managed";
export type EmbeddingProvider = "openai" | "anthropic" | "openrouter" | "gemini" | "ollama" | "managed";
export type DeploymentMode = "local" | "cloud";
export interface SummarizationConfig {
    provider: LLMProvider;
    model: string;
    apiKey?: string;
    baseUrl?: string;
    batchSize: number;
}
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

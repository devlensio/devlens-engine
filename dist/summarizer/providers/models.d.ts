export interface ListModelsOpts {
    protocol: "openai" | "anthropic";
    baseUrl: string;
    apiKey?: string;
}
/**
 * Fetches the live model list from a provider's models endpoint.
 * Returns deduped (case-insensitive), sorted model ID strings.
 * Throws on auth/network errors with a clear message.
 */
export declare function listModels(opts: ListModelsOpts): Promise<string[]>;

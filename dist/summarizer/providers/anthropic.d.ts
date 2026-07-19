import type { LLMClient, LLMRequest, NodeSummaryOutput } from "./types.js";
export declare class AnthropicClient implements LLMClient {
    readonly provider: "anthropic";
    readonly providerName?: string;
    readonly model: string;
    private client;
    constructor(apiKey: string, model: string, baseURL?: string, providerName?: string);
    summarize(request: LLMRequest): Promise<NodeSummaryOutput>;
    validateConnection(): Promise<void>;
}

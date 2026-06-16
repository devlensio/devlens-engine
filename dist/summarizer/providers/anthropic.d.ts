import type { LLMClient, LLMRequest, NodeSummaryOutput } from "./types.js";
export declare class AnthropicClient implements LLMClient {
    readonly provider: "anthropic";
    readonly model: string;
    private client;
    constructor(apiKey: string, model: string);
    summarize(request: LLMRequest): Promise<NodeSummaryOutput>;
    validateConnection(): Promise<void>;
}

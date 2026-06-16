import type { LLMClient, LLMRequest, NodeSummaryOutput } from "./types.js";
export declare class OpenRouterClient implements LLMClient {
    readonly provider: "openrouter";
    readonly model: string;
    private inner;
    constructor(apiKey: string, model: string);
    summarize(request: LLMRequest): Promise<NodeSummaryOutput>;
    validateConnection(): Promise<void>;
}

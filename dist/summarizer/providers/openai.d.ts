import type { LLMClient, LLMRequest, NodeSummaryOutput } from "./types.js";
export declare class OpenAIClient implements LLMClient {
    readonly provider: "openai";
    readonly model: string;
    private client;
    constructor(apiKey: string, model: string, baseURL?: string);
    summarize(request: LLMRequest): Promise<NodeSummaryOutput>;
    validateConnection(): Promise<void>;
}

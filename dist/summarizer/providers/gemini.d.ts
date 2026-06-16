import type { LLMClient, LLMRequest, NodeSummaryOutput } from "./types.js";
export declare class GeminiClient implements LLMClient {
    readonly provider: "gemini";
    readonly model: string;
    private ai;
    constructor(apiKey: string, model: string);
    summarize(request: LLMRequest): Promise<NodeSummaryOutput>;
    validateConnection(): Promise<void>;
}

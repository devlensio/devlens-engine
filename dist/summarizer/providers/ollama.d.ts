import type { LLMClient, LLMRequest, NodeSummaryOutput } from "./types.js";
export declare class OllamaClient implements LLMClient {
    readonly provider: "ollama";
    readonly model: string;
    private inner;
    constructor(model: string, baseURL?: string);
    summarize(request: LLMRequest): Promise<NodeSummaryOutput>;
    validateConnection(): Promise<void>;
}

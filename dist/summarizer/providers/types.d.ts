import type { LLMProvider } from "../../config/types.js";
export interface LLMMessage {
    role: "user" | "assistant" | "system";
    content: string;
}
export interface LLMRequest {
    messages: LLMMessage[];
    temperature?: number;
    maxTokens?: number;
}
export interface SecuritySummary {
    severity: "none" | "low" | "medium" | "high";
    summary: string;
}
export interface NodeSummaryOutput {
    technicalSummary: string;
    businessSummary: string;
    security: SecuritySummary;
    tokensUsed: number;
}
export interface LLMClient {
    readonly provider: LLMProvider;
    readonly model: string;
    summarize(request: LLMRequest): Promise<NodeSummaryOutput>;
    validateConnection(): Promise<void>;
}
export type LLMClientFactory = (config: {
    provider: LLMProvider;
    model: string;
    apiKey?: string;
    baseUrl?: string;
}) => LLMClient;

import type { CodeNode } from "../types.js";
import type { LLMClient, NodeSummaryOutput } from "./providers/types.js";
export declare function exceedsThreshold(node: CodeNode): boolean;
export declare function mapreduceSummarize(node: CodeNode, client: LLMClient, systemPrompt: string): Promise<NodeSummaryOutput>;

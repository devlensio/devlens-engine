import { ExtractorInput, ExtractorResult, LanguageExtractor } from "./types.js";
export declare function runSubprocessExtractor(extractor: LanguageExtractor, input: ExtractorInput, timeoutMs?: number): Promise<ExtractorResult>;
export declare function runInlineExtractor(input: ExtractorInput, onStep?: (step: "fingerprint" | "filesystem" | "parse" | "edges" | "scoring") => void): Promise<ExtractorResult>;
export declare function runExtractor(repoPath: string, options?: {
    includeThirdPartyLibs?: string[];
    onStep?: (step: "fingerprint" | "filesystem" | "parse" | "edges" | "scoring") => void;
}): Promise<ExtractorResult>;

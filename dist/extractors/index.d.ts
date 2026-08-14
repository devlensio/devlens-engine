import { Language } from "../types.js";
import { ExtractorResult, LanguageExtractor } from "./types.js";
export declare function defaultParseResult(stdout: string): ExtractorResult;
export declare function getExtractor(language: Language): LanguageExtractor | undefined;
export declare const INLINE_LANGUAGES: Set<Language>;

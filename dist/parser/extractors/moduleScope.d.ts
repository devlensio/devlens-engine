import { SourceFile } from "ts-morph";
import { type ExtractedCallData } from "./functions.js";
/**
 * Collect every call executed at module scope, classified exactly like calls
 * inside a function (same builtin filtering, hook/api tracking, call sites).
 * Returns EMPTY data for files with no module-scope calls.
 */
export declare function extractModuleScopeCalls(file: SourceFile): ExtractedCallData;

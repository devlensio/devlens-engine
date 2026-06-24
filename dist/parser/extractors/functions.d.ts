import { SourceFile } from "ts-morph";
import type { CodeNode } from "../../types.js";
import { type RenderingBoundary } from "../directives.js";
export declare function extractFunctionCalls(node: any): string[];
export declare function extractHookCalls(node: any): string[];
export declare function extractApiCalls(node: any): string[];
export declare function hasErrorHandling(node: any): boolean;
export declare function extractThrowStatements(node: any): boolean;
export declare function extractFunctions(file: SourceFile, fileDirective?: RenderingBoundary): CodeNode[];

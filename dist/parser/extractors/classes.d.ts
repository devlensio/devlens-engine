import { SourceFile } from "ts-morph";
import type { CodeNode } from "../../types.js";
import { type RenderingBoundary } from "../directives.js";
export declare function stripGenerics(typeText: string): string;
export declare function extractClasses(file: SourceFile, fileDirective?: RenderingBoundary): CodeNode[];

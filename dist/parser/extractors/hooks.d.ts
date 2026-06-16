import { SourceFile } from "ts-morph";
import type { CodeNode } from "../../types.js";
import { type RenderingBoundary } from "../directives.js";
export declare function extractHooks(file: SourceFile, fileDirective?: RenderingBoundary): CodeNode[];

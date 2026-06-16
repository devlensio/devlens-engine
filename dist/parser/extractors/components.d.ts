import { SourceFile, Node } from "ts-morph";
import type { CodeNode } from "../../types.js";
import { type RenderingBoundary } from "../directives.js";
export declare function returnsJSX(node: Node): boolean;
export declare function extractComponents(file: SourceFile, fileDirective?: RenderingBoundary): CodeNode[];

import { SourceFile, Node } from "ts-morph";
export type RenderingBoundary = "client" | "server" | null;
export declare function detectFileDirective(sourceFile: SourceFile): RenderingBoundary;
export declare function detectFunctionDirective(bodyNode: Node | undefined): RenderingBoundary;

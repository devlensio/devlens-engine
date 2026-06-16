import { SourceFile } from "ts-morph";
export interface ParamInfo {
    name: string;
    type?: string;
}
export declare function extractParams(node: any): ParamInfo[];
export declare function extractReturnTypeAnnotation(node: any): string | undefined;
export declare function extractBareTypeNames(typeStrings: (string | undefined)[]): string[];
export declare function extractReferencedInterfaces(sourceFile: SourceFile, typeNames: string[]): Record<string, Record<string, string>>;

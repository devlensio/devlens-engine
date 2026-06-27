import { Project, SourceFile } from "ts-morph";
export declare function urlPathtoRegex(urlPath: string): RegExp;
export declare function normalizeUrl(rawUrl: string): string | null;
export declare function reconstructTemplate(templateExpr: any): string;
export declare function extractUrlFromArg(arg: any, sourceFile: SourceFile, project: Project): {
    rawUrl: string;
    resolvedUrl: string;
} | null;

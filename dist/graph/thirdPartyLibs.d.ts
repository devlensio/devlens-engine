import type { CodeNode } from "../types.js";
export declare function readPackageDependencies(repoPath: string): {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
};
export declare function categorizeLibrary(packageName: string, isDev: boolean): "runtime" | "ui" | "devtool" | "unknown";
export declare function extractPackageName(importSpecifier: string): string;
export declare function buildThirdPartyNodes(repoPath: string, includedLibs: string[]): CodeNode[];

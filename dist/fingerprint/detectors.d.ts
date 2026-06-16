import type { Language, Framework, RouterType, StateLibrary, DataFetchingLibrary, DatabaseLibrary, ProjectType } from "../types.js";
export declare function detectLanguage(repoPath: string): Language;
export declare function detectFramework(deps: Record<string, string>): Framework;
export declare function detectRouter(deps: Record<string, string>, framework: Framework, repoPath: string): RouterType;
export declare function detectStateManagement(deps: Record<string, string>): StateLibrary[];
export declare function detectDataFetching(deps: Record<string, string>): DataFetchingLibrary[];
export declare function detectDatabases(deps: Record<string, string>): DatabaseLibrary[];
export declare function detectProjectType(framework: Framework, deps: Record<string, string>, repoPath: string): ProjectType;

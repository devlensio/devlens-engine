import type { CodeNode } from "../types.js";
export interface LookupMaps {
    nodesByName: Map<string, CodeNode[]>;
    nodesByFile: Map<string, CodeNode[]>;
    fileNodesByPath: Map<string, CodeNode>;
    storeNodes: CodeNode[];
    thirdPartyNodesByName: Map<string, CodeNode>;
    thirdPartyImportAliases: Map<string, Map<string, string>>;
}
export declare function buildLookupMaps(codeNodes: CodeNode[]): LookupMaps;

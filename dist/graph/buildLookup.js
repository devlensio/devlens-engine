export function buildLookupMaps(codeNodes) {
    const nodesByName = new Map();
    const nodesByFile = new Map();
    const fileNodesByPath = new Map();
    const storeNodes = [];
    const thirdPartyNodesByName = new Map();
    const thirdPartyImportAliases = new Map();
    for (const node of codeNodes) {
        if (node.type === "THIRD_PARTY") {
            thirdPartyNodesByName.set(node.name, node);
            continue;
        }
        // FILE nodes go into their own dedicated map — kept separate so other
        // detectors (guards, call edges, etc.) only see function/component nodes
        if (["FILE", "TEST", "STORY"].includes(node.type)) {
            fileNodesByPath.set(node.filePath, node);
            continue;
        }
        if (!nodesByName.has(node.name)) {
            nodesByName.set(node.name, []);
        }
        nodesByName.get(node.name).push(node);
        if (!nodesByFile.has(node.filePath)) {
            nodesByFile.set(node.filePath, []);
        }
        nodesByFile.get(node.filePath).push(node);
        if (node.type === "STATE_STORE") {
            storeNodes.push(node);
        }
    }
    return { nodesByName, nodesByFile, fileNodesByPath, storeNodes, thirdPartyNodesByName, thirdPartyImportAliases };
}

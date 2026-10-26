export function buildLookupMaps(codeNodes) {
    const nodesByName = new Map();
    const nodesByFile = new Map();
    const fileNodesByPath = new Map();
    const storeNodes = [];
    const thirdPartyNodesByName = new Map();
    const thirdPartyImportAliases = new Map();
    const localImportSymbols = new Map();
    const importTargets = new Map();
    const exportBindings = new Map();
    const reexportLinks = new Map();
    const reexportGlobs = new Map();
    const nodeIds = new Set();
    for (const node of codeNodes) {
        if (node.type === "THIRD_PARTY") {
            thirdPartyNodesByName.set(node.name, node);
            nodeIds.add(node.id);
            continue;
        }
        // FILE nodes go into their own dedicated map — kept separate so other
        // detectors (guards, call edges, etc.) only see function/component nodes
        if (["FILE", "TEST", "STORY"].includes(node.type)) {
            fileNodesByPath.set(node.filePath, node);
            nodeIds.add(node.id);
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
        nodeIds.add(node.id);
    }
    return {
        nodesByName,
        nodesByFile,
        fileNodesByPath,
        storeNodes,
        thirdPartyNodesByName,
        thirdPartyImportAliases,
        localImportSymbols,
        importTargets,
        exportBindings,
        reexportLinks,
        reexportGlobs,
        nodeIds,
    };
}
/**
 * Rebuild a flat node list from the lookup maps.
 * Detectors that only receive `LookupMaps` (importEdges) need the node array to
 * index declarations — the maps are a partition of the same nodes, so this is
 * lossless and avoids threading the array through every signature.
 */
export function nodesFromLookup(lookup) {
    const out = [];
    for (const nodes of lookup.nodesByName.values())
        out.push(...nodes);
    for (const node of lookup.fileNodesByPath.values())
        out.push(node);
    return out;
}

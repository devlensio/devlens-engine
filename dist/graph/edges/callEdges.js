import { closestByPath } from "./utils.js";
export function detectCallEdges(nodes, lookupMp) {
    const edges = [];
    // Dedup for THIRD_PARTY CALLS edges — one per (caller, target) pair
    const createdThirdPartyEdges = new Set();
    // Accumulate resolved calls per node — written back to metadata after edge loop
    const resolvedCallsMap = new Map();
    // Lazily-created method nodes for default/namespace import member-access calls
    const createdMethodNodes = new Map();
    for (const node of nodes) {
        // Only functions, hooks, components, and class methods make direct calls
        if (node.type !== "FUNCTION" &&
            node.type !== "HOOK" &&
            node.type !== "COMPONENT" &&
            node.type !== "METHOD")
            continue;
        const calls = node.metadata.calls;
        const uses = node.metadata.uses;
        const hookCalls = node.metadata.hookCalls;
        const dependencies = node.metadata.dependencies;
        const hooks = node.metadata.hooks;
        // Primary call list determines the edge type
        const primaryNames = calls ?? uses;
        const edgeType = calls ? "CALLS" : "USES";
        // Hook / dependency names are checked for third-party edges only —
        // local hook-to-hook edges are already handled by hookEdges.ts.
        const hookNames = [
            ...(hookCalls ?? []),
            ...(dependencies ?? []),
            ...(hooks ?? []),
        ];
        const hasPrimary = primaryNames && primaryNames.length > 0;
        const hasHooks = hookNames.length > 0;
        if (!hasPrimary && !hasHooks)
            continue;
        // ── Primary names: both third-party and local edges ──────────────
        for (const calledName of (primaryNames ?? [])) {
            // ── Third-party guard ─────────────────────────────────────────
            // The alias map is keyed by node.filePath (relative) and populated
            // by importEdges.ts (which runs first).
            const fileAliasMap = lookupMp.thirdPartyImportAliases.get(node.filePath);
            if (fileAliasMap) {
                const rootName = calledName.split(".")[0];
                let tpNodeId = fileAliasMap.get(calledName) ?? fileAliasMap.get(rootName);
                if (tpNodeId) {
                    // When the alias resolved to a package node (default/namespace import)
                    // AND the calledName is a member-access expression like "axios.get",
                    // create a more granular per-method node.
                    const isPackageNode = !tpNodeId.includes("::");
                    const hasMemberAccess = calledName.includes(".");
                    if (isPackageNode && hasMemberAccess) {
                        const methodSuffix = calledName.slice(rootName.length + 1); // "get" from "axios.get"
                        const methodNodeId = `${tpNodeId}::${methodSuffix}`;
                        if (!createdMethodNodes.has(methodNodeId)) {
                            const pkgName = tpNodeId.replace(/^\[npm\]\//, "");
                            const pkgNode = lookupMp.thirdPartyNodesByName.get(pkgName);
                            createdMethodNodes.set(methodNodeId, {
                                id: methodNodeId,
                                name: `${pkgName}.${methodSuffix}`,
                                type: "THIRD_PARTY",
                                filePath: tpNodeId,
                                startLine: 0,
                                endLine: 0,
                                rawCode: undefined,
                                codeHash: undefined,
                                metadata: {
                                    isThirdParty: true,
                                    packageVersion: pkgNode?.metadata.packageVersion ?? "unknown",
                                    category: pkgNode?.metadata.category ?? "unknown",
                                    parentPackageId: tpNodeId,
                                    methodName: methodSuffix,
                                },
                            });
                        }
                        // Cache in the alias map so subsequent lookups for the same
                        // expression skip re-creation.
                        fileAliasMap.set(calledName, methodNodeId);
                        tpNodeId = methodNodeId;
                    }
                    const edgeKey = `${node.id}→${tpNodeId}:CALLS`;
                    if (!createdThirdPartyEdges.has(edgeKey)) {
                        createdThirdPartyEdges.add(edgeKey);
                        edges.push({
                            from: node.id,
                            to: tpNodeId,
                            type: "CALLS",
                            metadata: { calledName, isThirdParty: true },
                        });
                    }
                    continue;
                }
            }
            // Skip non-third-party member-access calls (console.log, Math.round, etc.)
            // const rootName = calledName.split(".")[0];
            // const NOISE_ROOTS = new Set([
            //     "console", "Math", "Object", "JSON", "Date", "document",
            //     "Array", "String", "Number", "Boolean", "Promise", "Error",
            //     "setTimeout", "setInterval", "clearTimeout", "clearInterval",
            //     "parseInt", "parseFloat", "isNaN", "isFinite",
            // ]);
            // if (NOISE_ROOTS.has(rootName)) continue;
            // // Check if a node exists with the full dotted name
            // if (!lookupMp.nodesByName.has(calledName)) {
            //     continue;
            // }
            // ── Local node lookup ─────────────────────────────────────────
            // Direct name match first; if it misses, try substituting the
            // root through the local-import alias map (`US.get()` where
            // `import { UserService as US }` → resolve `UserService.get`).
            let targets = lookupMp.nodesByName.get(calledName);
            let resolvedName = calledName;
            if ((!targets || targets.length === 0) && calledName.includes(".")) {
                const rootName = calledName.split(".")[0];
                const fileAliases = lookupMp.localImportSymbols.get(node.filePath);
                const importedName = fileAliases?.get(rootName);
                if (importedName) {
                    resolvedName = importedName + calledName.slice(rootName.length);
                    targets = lookupMp.nodesByName.get(resolvedName);
                }
            }
            if (!targets || targets.length === 0)
                continue;
            const target = targets.length === 1
                ? targets[0]
                : closestByPath(targets, node.filePath);
            if (target.id === node.id)
                continue; // skip self-reference
            edges.push({
                from: node.id,
                to: target.id,
                type: edgeType,
                metadata: { calledName: resolvedName },
            });
            if (!resolvedCallsMap.has(node.id))
                resolvedCallsMap.set(node.id, []);
            const existing = resolvedCallsMap.get(node.id);
            if (!existing.some(r => r.nodeId === target.id)) {
                existing.push({ name: resolvedName, nodeId: target.id });
            }
        }
        // ── Hook / dependency names: third-party edges only ──────────────
        if (hookNames.length > 0) {
            const fileAliasMap = lookupMp.thirdPartyImportAliases.get(node.filePath);
            if (fileAliasMap) {
                for (const hookName of hookNames) {
                    const rootName = hookName.split(".")[0];
                    const tpNodeId = fileAliasMap.get(hookName) ?? fileAliasMap.get(rootName);
                    if (!tpNodeId)
                        continue;
                    const edgeKey = `${node.id}→${tpNodeId}:CALLS`;
                    if (!createdThirdPartyEdges.has(edgeKey)) {
                        createdThirdPartyEdges.add(edgeKey);
                        edges.push({
                            from: node.id,
                            to: tpNodeId,
                            type: "CALLS",
                            metadata: { calledName: hookName, isThirdParty: true },
                        });
                    }
                }
            }
        }
    }
    // Write resolved calls back onto nodes
    for (const node of nodes) {
        node.metadata.resolvedCalls = resolvedCallsMap.get(node.id) ?? [];
    }
    return { edges, newThirdPartyNodes: [...createdMethodNodes.values()] };
}

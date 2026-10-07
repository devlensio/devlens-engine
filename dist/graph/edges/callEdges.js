import { closestByPath } from "./utils.js";
// Arity compatibility: a candidate matches when the call provides at least all
// required (non-optional, non-rest) params, and does not exceed the declared
// count unless the candidate declares a rest parameter. Candidates without
// parameters metadata are permissive (unknown shape).
function arityMatches(candidate, argCount) {
    const parameters = candidate.metadata?.parameters;
    const params = candidate.metadata?.params;
    if (!params && !parameters)
        return true;
    const total = parameters?.length ?? params?.length ?? 0;
    const hasRest = parameters?.some((p) => p.isRest) ?? false;
    const required = parameters
        ? parameters.filter((p) => !p.isOptional && !p.isRest).length
        : total;
    return argCount >= required && (hasRest || argCount <= total);
}
// Loose type agreement between a call-site arg type tag and a declared param
// type text. Both sides are cheap/heuristic (no type checker), so this scores
// rather than gates: unknown tags never match, text containment counts.
function typeAgrees(argType, paramType) {
    if (!argType || argType === "unknown" || !paramType)
        return false;
    const p = paramType.trim();
    return p === argType || p.includes(argType);
}
function typeScore(candidate, argTypes) {
    const parameters = candidate.metadata?.parameters;
    if (!parameters)
        return 0;
    let score = 0;
    for (let i = 0; i < argTypes.length; i++) {
        if (parameters[i] && typeAgrees(argTypes[i], parameters[i].type))
            score++;
    }
    return score;
}
// Picks the right overload among same-name candidates using the call site's
// argument shape. Ladder:
//   1. no usable call shape (USES edges, spread calls, missing callSites)
//      → legacy closestByPath behavior
//   2. arity filter — survivors whose declared params accept argCount
//   3. type tiebreak — among arity survivors, prefer the candidate with the
//      highest arg-type agreement (handles same arity, different types)
//   4. still ambiguous → closestByPath among survivors
function resolveOverloadTarget(candidates, caller, callSite) {
    if (candidates.length === 1)
        return { target: candidates[0], matchedBy: "name" };
    const usableShape = callSite
        && typeof callSite.argCount === "number"
        && !callSite.hasSpread;
    if (!usableShape)
        return { target: closestByPath(candidates, caller.filePath), matchedBy: "name" };
    let pool = candidates.filter((c) => arityMatches(c, callSite.argCount));
    if (pool.length === 0)
        pool = candidates; // nothing accepts this arity — keep all
    if (pool.length === 1)
        return { target: pool[0], matchedBy: "arity" };
    const argTypes = callSite.argTypes ?? [];
    if (argTypes.some((t) => t && t !== "unknown")) {
        let best = pool[0];
        let bestScore = typeScore(pool[0], argTypes);
        let tieAtBest = 1;
        for (let i = 1; i < pool.length; i++) {
            const s = typeScore(pool[i], argTypes);
            if (s > bestScore) {
                best = pool[i];
                bestScore = s;
                tieAtBest = 1;
            }
            else if (s === bestScore)
                tieAtBest++;
        }
        if (bestScore > 0 && tieAtBest === 1) {
            return { target: best, matchedBy: "signature" };
        }
    }
    return { target: closestByPath(pool, caller.filePath), matchedBy: "name" };
}
export function detectCallEdges(nodes, lookupMp) {
    const edges = [];
    // Dedup for THIRD_PARTY CALLS edges — one per (caller, target) pair
    const createdThirdPartyEdges = new Set();
    // Dedup for local CALLS/USES edges — overload call sites can resolve to
    // the same target through different (name, arity) pairs
    const createdLocalEdges = new Set();
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
        // Structured callSites carry the argument shape for overload-aware
        // resolution; fall back to bare calls/uses strings when absent.
        const callSites = node.metadata.callSites;
        // Each (name, arity) call site iterates separately — a caller that
        // invokes two overloads of one name gets two edges.
        const primaryCallSites = (callSites && callSites.length > 0)
            ? callSites
            : (primaryNames ?? []).map((name) => ({ name, argCount: -1 }));
        for (const callSite of primaryCallSites) {
            const calledName = callSite.name;
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
            const { target, matchedBy } = resolveOverloadTarget(targets, node, callSite.argCount >= 0 ? callSite : undefined);
            if (target.id === node.id)
                continue; // skip self-reference
            const localEdgeKey = `${node.id}→${target.id}:${edgeType}`;
            if (createdLocalEdges.has(localEdgeKey))
                continue;
            createdLocalEdges.add(localEdgeKey);
            edges.push({
                from: node.id,
                to: target.id,
                type: edgeType,
                metadata: { calledName: resolvedName, matchedBy },
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

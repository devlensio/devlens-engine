import type { CallSite, CodeEdge, CodeNode } from "../../types.js";
import type { LookupMaps } from "../buildLookup.js";
import { closestByPath } from "./utils.js";
import { buildAliasChain } from "./aliasChain.js";

export interface CallEdgeResult {
    edges: CodeEdge[];
    // Method nodes created lazily when default/namespace import member-access calls
    // are discovered (e.g. axios.get → [npm]/axios::get).
    newThirdPartyNodes: CodeNode[];
}

// Arity compatibility: a candidate matches when the call provides at least all
// required (non-optional, non-rest) params, and does not exceed the declared
// count unless the candidate declares a rest parameter. Candidates without
// parameters metadata are permissive (unknown shape).
function arityMatches(candidate: CodeNode, argCount: number): boolean {
    const parameters = candidate.metadata?.parameters as
        | { isOptional?: boolean; isRest?: boolean }[]
        | undefined;
    const params = candidate.metadata?.params as string[] | undefined;
    if (!params && !parameters) return true;
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
function typeAgrees(argType: string, paramType: string | undefined): boolean {
    if (!argType || argType === "unknown" || !paramType) return false;
    const p = paramType.trim();
    return p === argType || p.includes(argType);
}

function typeScore(candidate: CodeNode, argTypes: string[]): number {
    const parameters = candidate.metadata?.parameters as { type?: string }[] | undefined;
    if (!parameters) return 0;
    let score = 0;
    for (let i = 0; i < argTypes.length; i++) {
        if (parameters[i] && typeAgrees(argTypes[i], parameters[i].type)) score++;
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
function resolveOverloadTarget(
    candidates: CodeNode[],
    caller: CodeNode,
    callSite: CallSite | undefined,
): { target: CodeNode; matchedBy: "name" | "arity" | "signature" } {
    if (candidates.length === 1) return { target: candidates[0], matchedBy: "name" };

    const usableShape = callSite
        && typeof callSite.argCount === "number"
        && !callSite.hasSpread;
    if (!usableShape) return { target: closestByPath(candidates, caller.filePath), matchedBy: "name" };

    let pool = candidates.filter((c) => arityMatches(c, callSite!.argCount));
    if (pool.length === 0) pool = candidates; // nothing accepts this arity — keep all
    if (pool.length === 1) return { target: pool[0], matchedBy: "arity" };

    const argTypes = callSite!.argTypes ?? [];
    if (argTypes.some((t) => t && t !== "unknown")) {
        let best = pool[0];
        let bestScore = typeScore(pool[0], argTypes);
        let tieAtBest = 1;
        for (let i = 1; i < pool.length; i++) {
            const s = typeScore(pool[i], argTypes);
            if (s > bestScore) { best = pool[i]; bestScore = s; tieAtBest = 1; }
            else if (s === bestScore) tieAtBest++;
        }
        if (bestScore > 0 && tieAtBest === 1) {
            return { target: best, matchedBy: "signature" };
        }
    }

    return { target: closestByPath(pool, caller.filePath), matchedBy: "name" };
}

export function detectCallEdges(nodes: CodeNode[], lookupMp: LookupMaps): CallEdgeResult {
    const edges: CodeEdge[] = [];
    // Dedup for THIRD_PARTY CALLS edges — one per (caller, target) pair
    const createdThirdPartyEdges = new Set<string>();
    // Dedup for local CALLS/USES edges — overload call sites can resolve to
    // the same target through different (name, arity) pairs
    const createdLocalEdges = new Set<string>();
    // Accumulate resolved calls per node — written back to metadata after edge loop
    const resolvedCallsMap = new Map<string, { name: string; nodeId: string }[]>();
    // Lazily-created method nodes for default/namespace import member-access calls
    const createdMethodNodes = new Map<string, CodeNode>();
    // id → node, for turning resolved export bindings back into candidates
    const nodesById = new Map<string, CodeNode>();
    for (const n of nodes) nodesById.set(n.id, n);
    // memoized alias chains (provenance only; see aliasChain.ts)
    const aliasChainCache = new Map<string, string[] | undefined>();

    for (const node of nodes) {
        // FILE is a caller for module-scope execution (calls executed at file
        // load, attached by parser/extractors/moduleScope.ts). TEST/STORY are
        // leaves and deliberately excluded.
        if (
            node.type !== "FUNCTION" &&
            node.type !== "HOOK" &&
            node.type !== "COMPONENT" &&
            node.type !== "METHOD" &&
            node.type !== "FILE"
        ) continue;

        const calls = node.metadata.calls as string[] | undefined;
        const uses = node.metadata.uses as string[] | undefined;
        const hookCalls = node.metadata.hookCalls as string[] | undefined;
        const dependencies = node.metadata.dependencies as string[] | undefined;
        const hooks = node.metadata.hooks as string[] | undefined;

        // Primary call list determines the edge type
        const primaryNames = calls ?? uses;
        const edgeType = calls ? "CALLS" : "USES";

        // Hook / dependency names are checked for third-party edges only —
        // local hook-to-hook edges are already handled by hookEdges.ts.
        const hookNames: string[] = [
            ...(hookCalls ?? []),
            ...(dependencies ?? []),
            ...(hooks ?? []),
        ];

        const hasPrimary = primaryNames && primaryNames.length > 0;
        const hasHooks = hookNames.length > 0;
        if (!hasPrimary && !hasHooks) continue;

        // ── Primary names: both third-party and local edges ──────────────
        // Structured callSites carry the argument shape for overload-aware
        // resolution; fall back to bare calls/uses strings when absent.
        const callSites = node.metadata.callSites as CallSite[] | undefined;
        // Each (name, arity) call site iterates separately — a caller that
        // invokes two overloads of one name gets two edges.
        const primaryCallSites: CallSite[] = (callSites && callSites.length > 0)
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
                            metadata: {
                                calledName,
                                isThirdParty: true,
                                ...(node.type === "FILE" ? { scope: "module" } : {}),
                            },
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
            // Tier 2 — module-scoped (binding-aware). The import resolved to a
            // file, and that file's export table already points at the ORIGIN
            // declaration: TypeScript's checker followed every `export … from`,
            // `export *` and `export { a as b }` when the table was built. Two
            // map reads, independent of chain depth.
            let targets: CodeNode[] | undefined;
            let resolvedName = calledName;
            let aliasChain: string[] | undefined;
            const rootName = calledName.split(".")[0];
            const importTarget = lookupMp.importTargets.get(node.filePath)?.get(rootName);

            if (importTarget) {
                const suffix = calledName.slice(rootName.length); // "" or ".get"
                let exportName = importTarget.importedName;
                let memberSuffix = suffix;

                if (importTarget.kind === "namespace") {
                    // `import * as ns` + `ns.member()` → the member is the export
                    const member = suffix.startsWith(".") ? suffix.slice(1) : "";
                    exportName = member.split(".")[0];
                    memberSuffix = member.slice(exportName.length);
                }

                if (exportName) {
                    const ids = lookupMp.exportBindings.get(importTarget.targetFile)?.get(exportName);
                    if (ids && ids.length > 0) {
                        if (memberSuffix) {
                            // Member access on an imported class/object: nodes are
                            // dotted (`file::Class.method`). Accept only ids that
                            // exist — never invent an edge to the container.
                            const memberIds = ids
                                .map((id) => `${id}${memberSuffix}`)
                                .filter((id) => lookupMp.nodeIds.has(id));
                            targets = memberIds
                                .map((id) => nodesById.get(id))
                                .filter((n): n is CodeNode => !!n);
                        } else {
                            targets = ids
                                .map((id) => nodesById.get(id))
                                .filter((n): n is CodeNode => !!n);
                        }
                        if (targets.length > 0) {
                            aliasChain = buildAliasChain(lookupMp, importTarget, aliasChainCache);
                        }
                    }
                }
            }

            // Tier 3 — legacy name-based fallback (unchanged behaviour): direct
            // name match, then the one-hop local alias substitution. Keeps repos
            // where module resolution fails (no config, exotic layouts) exactly
            // as they were.
            if (!targets || targets.length === 0) {
                resolvedName = calledName;
                targets = lookupMp.nodesByName.get(calledName);
                if (!targets || targets.length === 0) {
                    const importedName = lookupMp.localImportSymbols.get(node.filePath)?.get(rootName);
                    if (importedName) {
                        resolvedName = calledName.includes(".")
                            ? importedName + calledName.slice(rootName.length)
                            : importedName;
                        targets = lookupMp.nodesByName.get(resolvedName);
                    }
                }
            }
            if (!targets || targets.length === 0) continue;

            const { target, matchedBy } = resolveOverloadTarget(targets, node, callSite.argCount >= 0 ? callSite : undefined);

            if (target.id === node.id) continue; // skip self-reference

            // The origin symbol's own name — for an aliased call this differs
            // from what the caller wrote (`httpResponse` → `data`).
            resolvedName = target.name;

            // A chain that ends inside a module (local `export { a as b }`) gets
            // the origin file appended, so every chain ends at the node the edge
            // points to. Skipped when the last hop already *is* that id (or its
            // overload base, e.g. `fmt::fmt` vs `fmt::fmt#1`).
            if (aliasChain && aliasChain.length > 0) {
                const last = aliasChain[aliasChain.length - 1];
                if (last !== target.id && !target.id.startsWith(last)) {
                    aliasChain = [...aliasChain, target.id];
                }
            }

            const localEdgeKey = `${node.id}→${target.id}:${edgeType}`;
            if (createdLocalEdges.has(localEdgeKey)) continue;
            createdLocalEdges.add(localEdgeKey);

            edges.push({
                from: node.id,
                to: target.id,
                type: edgeType,
                metadata: {
                    // as written at the call site
                    calledName,
                    // the declaration the graph edge actually points at
                    resolvedName,
                    // true when the name was aliased (import alias, re-export, …)
                    ...(calledName !== target.name ? { aliased: true } : {}),
                    // provenance for the UI — only when a re-export chain exists
                    ...(aliasChain ? { aliasChain } : {}),
                    matchedBy,
                    ...(node.type === "FILE" ? { scope: "module" } : {}),
                },
            });

            if (!resolvedCallsMap.has(node.id)) resolvedCallsMap.set(node.id, []);
            const existing = resolvedCallsMap.get(node.id)!;
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
                    if (!tpNodeId) continue;

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

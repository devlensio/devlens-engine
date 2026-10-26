// Alias-chain provenance ("how did this name get here?").
//
// Resolution NEVER uses this file. The chain is already collapsed inside
// `exportBindings` (TypeScript's checker followed every re-export when it
// produced `getExportedDeclarations()`), so a call site resolves with two map
// reads no matter how deep the chain is.
//
// This module exists only to answer the display question — "the caller wrote
// `httpResponse`, the edge points at `data`, why?" — by walking the recorded
// hops (`reexportLinks` / `reexportGlobs`). It is:
//   - memoized per (file, exported name), so a chain shared by many call sites
//     is computed once;
//   - depth-capped and cycle-guarded, so a pathological barrel ring can neither
//     hang nor recurse forever;
//   - best-effort: a missing link simply ends the chain.

import type { ImportTarget, LookupMaps } from "../buildLookup.js";

const MAX_CHAIN_HOPS = 24;

/**
 * Chain of `file::name` hops from the imported module to the origin symbol.
 * Returns undefined when the name is not aliased beyond the importing module
 * (depth 1) — the common case, which must not bloat the edge metadata.
 */
export function buildAliasChain(
    lookup: LookupMaps,
    target: ImportTarget,
    cache: Map<string, string[] | undefined>,
): string[] | undefined {
    if (target.kind === "namespace") return undefined;

    const key = `${target.targetFile}::${target.importedName}`;
    if (cache.has(key)) return cache.get(key);

    const chain: string[] = [];
    const visited = new Set<string>();
    let current: { file: string; name: string } | undefined = {
        file: target.targetFile,
        name: target.importedName,
    };

    while (current && chain.length < MAX_CHAIN_HOPS) {
        const hopId = `${current.file}::${current.name}`;
        if (visited.has(hopId)) break; // cycle in the barrel ring
        visited.add(hopId);
        chain.push(hopId);

        current = nextHop(lookup, current.file, current.name);
    }

    // depth 1 = imported straight from the declaring module: not a chain
    const result = chain.length > 1 ? chain : undefined;
    cache.set(key, result);
    return result;
}

function nextHop(
    lookup: LookupMaps,
    file: string,
    name: string,
): { file: string; name: string } | undefined {
    const explicit = lookup.reexportLinks.get(file)?.get(name);
    if (explicit) return { file: explicit.targetFile, name: explicit.targetName };

    // `export * from "./x"` keeps the name — follow the first glob that owns it
    const globs = lookup.reexportGlobs.get(file);
    if (globs) {
        for (const glob of globs) {
            const owns =
                lookup.exportBindings.get(glob)?.has(name) === true ||
                lookup.reexportLinks.get(glob)?.has(name) === true ||
                (lookup.reexportGlobs.get(glob)?.length ?? 0) > 0;
            if (owns) return { file: glob, name };
        }
    }

    return undefined;
}

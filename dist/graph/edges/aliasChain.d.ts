import type { ImportTarget, LookupMaps } from "../buildLookup.js";
/**
 * Chain of `file::name` hops from the imported module to the origin symbol.
 * Returns undefined when the name is not aliased beyond the importing module
 * (depth 1) — the common case, which must not bloat the edge metadata.
 */
export declare function buildAliasChain(lookup: LookupMaps, target: ImportTarget, cache: Map<string, string[] | undefined>): string[] | undefined;

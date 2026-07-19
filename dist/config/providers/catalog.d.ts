export interface CatalogProvider {
    name: string;
    label: string;
    protocol: "openai" | "anthropic";
    baseUrl: string;
    requiresKey: boolean;
}
/** Same shape as CatalogProvider — input type for saveProvider. */
export type CatalogProviderInput = CatalogProvider;
export declare function loadCatalog(): CatalogProvider[];
export declare function findProvider(name: string): CatalogProvider | undefined;
/** Returns only the user's overrides (not merged with defaults). */
export declare function listUserProviders(): CatalogProvider[];
/**
 * Upsert a provider entry in the user's providers.json.
 * Validates the entry before writing. Returns the entry as written.
 * The user file only stores the override layer — never the merged result.
 */
export declare function saveProvider(entry: CatalogProviderInput): CatalogProvider;
/**
 * Remove a user override entry by name.
 * Returns true if an entry was removed, false if it wasn't present.
 * Only removes entries from the user file — default providers cannot be removed.
 */
export declare function removeProvider(name: string): boolean;
/** Delete the entire user providers.json — catalog reverts to shipped defaults. */
export declare function resetUserCatalog(): void;

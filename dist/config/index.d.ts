import { type DevLensConfig, type ProviderConfigEntry } from "./types.js";
export declare function detectOllama(): Promise<boolean>;
export declare function initConfig(): Promise<void>;
export declare function resolveConfig(req?: Request): DevLensConfig;
export type { DevLensConfig } from "./types.js";
export type { SafeConfig } from "./writer.js";
export { maskConfig, writeConfig, atomicWrite } from "./writer.js";
export { CONFIG_FILE, CONFIG_DIR, ENV } from "./providers/file.js";
export { sanitizeHeaders, CONFIG_HEADERS } from "./types.js";
export { OLLAMA_DEFAULTS, ANTHROPIC_DEFAULTS } from "./types.js";
export type { ProviderConfigEntry, MultiProviderStorage } from "./types.js";
export { makeProviderKey, parseProviderKey } from "./types.js";
export interface AllProvidersResult {
    active: string;
    providers: ProviderConfigEntry[];
}
/** Return ALL configured providers (from disk) — for the frontend settings UI. */
export declare function resolveAllProviders(): AllProvidersResult;
/** Switch the active provider by composite key. */
export declare function setActiveProvider(key: string): void;
/** Remove a provider entry by composite key. Cannot remove the active provider. */
export declare function removeProvider(key: string): void;

import { type DevLensConfig } from "../types.js";
export { CONFIG_DIR, CONFIG_FILE } from "./paths.js";
export declare const ENV: {
    readonly LLM_PROVIDER: "DEVLENS_LLM_PROVIDER";
    readonly LLM_PROVIDER_NAME: "DEVLENS_LLM_PROVIDER_NAME";
    readonly LLM_MODEL: "DEVLENS_LLM_MODEL";
    readonly LLM_KEY: "DEVLENS_LLM_KEY";
    readonly LLM_BASE_URL: "DEVLENS_LLM_BASE_URL";
    readonly BATCH_SIZE: "DEVLENS_BATCH_SIZE";
    readonly EMBED_PROVIDER: "DEVLENS_EMBED_PROVIDER";
    readonly EMBED_MODEL: "DEVLENS_EMBED_MODEL";
    readonly EMBED_KEY: "DEVLENS_EMBED_KEY";
    readonly EMBED_BASE_URL: "DEVLENS_EMBED_BASE_URL";
    readonly NEO4J_URL: "DEVLENS_NEO4J_URL";
    readonly NEO4J_USER: "DEVLENS_NEO4J_USER";
    readonly NEO4J_PASSWORD: "DEVLENS_NEO4J_PASSWORD";
    readonly NEO4J_STORECODE: "NEO4J_STORE_CODE";
};
/** Public — reads the raw config.json as a plain object. Used by multi-provider helpers. */
export declare function readRawConfigFile(): Record<string, unknown>;
export declare function loadFileConfig(defaults?: DevLensConfig): DevLensConfig;

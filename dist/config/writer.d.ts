import type { DevLensConfig, ProviderConfigEntry } from "./types.js";
type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
type PartialConfig = DeepPartial<DevLensConfig>;
export interface SafeConfig {
    deploymentMode: DevLensConfig["deploymentMode"];
    summarization: {
        provider: string;
        providerName?: string;
        model: string;
        baseUrl?: string;
        batchSize: number;
        apiKey?: string;
    };
    allProviders?: {
        active: string;
        providers: ProviderConfigEntry[];
    };
    embedding: {
        provider: string;
        model: string;
        baseUrl?: string;
        apiKeyHint?: string;
    };
    neo4j?: {
        url: string;
        username: string;
        storeRawCode: boolean;
    };
}
export declare function atomicWrite(filePath: string, content: string): void;
export declare function writeConfig(partial: PartialConfig): void;
export declare function maskConfig(config: DevLensConfig): SafeConfig;
export {};

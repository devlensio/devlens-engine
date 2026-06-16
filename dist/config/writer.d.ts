import type { DevLensConfig } from "./types.js";
type DeepPartial<T> = {
    [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};
type PartialConfig = DeepPartial<DevLensConfig>;
export interface SafeConfig {
    deploymentMode: DevLensConfig["deploymentMode"];
    summarization: {
        provider: string;
        model: string;
        baseUrl?: string;
        batchSize: number;
        apiKeyHint?: string;
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
export declare function writeConfig(partial: PartialConfig): void;
export declare function maskConfig(config: DevLensConfig): SafeConfig;
export {};

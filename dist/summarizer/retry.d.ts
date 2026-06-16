export interface RetryOptions {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
}
export declare const DEFAULT_RETRY_OPTIONS: RetryOptions;
export declare function withRetry<T>(fn: () => Promise<T>, opts?: RetryOptions, label?: string): Promise<T>;

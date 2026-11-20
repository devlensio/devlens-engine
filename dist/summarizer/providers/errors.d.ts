export interface LLMErrorContext {
    provider?: string;
    model?: string;
}
/** Truncate anything (string, object, HTML page) to something loggable. */
export declare function describeBody(value: unknown, max?: number): string;
/**
 * A provider answered, but the answer is unusable: no choices, no text, or a
 * payload the provider rejected inside a 200. Carries `retryable` so the retry
 * layer does not have to re-derive intent from the message.
 */
export declare class LLMResponseError extends Error {
    readonly retryable: boolean;
    readonly status?: number;
    readonly provider?: string;
    readonly model?: string;
    readonly bodySnippet?: string;
    constructor(message: string, opts: {
        retryable: boolean;
        status?: number;
        bodySnippet?: string;
    } & LLMErrorContext);
}
/**
 * Wrap whatever the SDK threw into an Error whose message a human can act on.
 * The SDK already classifies HTTP errors (status + body), so this mostly
 * forwards: status, provider, model, and a body snippet when one exists.
 */
export declare function wrapProviderError(err: unknown, ctx: LLMErrorContext): Error;
/**
 * Assert that a chat-completions payload actually carries a choice, and return
 * its first message content. Throws a descriptive, retryable error otherwise.
 */
export declare function requireCompletionText(response: unknown, ctx: LLMErrorContext): string;
/**
 * Same for the Anthropic messages API: `content` is an array of blocks and the
 * first text block is the answer.
 */
export declare function requireAnthropicText(response: unknown, ctx: LLMErrorContext): string;
/** One-line summary of an unknown thrown value, for logs and job warnings. */
export declare function errorMessage(err: unknown): string;

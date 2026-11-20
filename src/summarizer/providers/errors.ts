// Shared error types for LLM providers.
//
// Two problems this solves:
//
// 1. Providers (and the gateways people put in front of them) sometimes answer
//    HTTP 200 with a body that is not a completion — `{"error": ...}`, a quota
//    notice, an HTML error page. Reading `response.choices[0]` on that throws a
//    bare `undefined is not an object`, which says nothing about the cause.
// 2. Retry classification needs to know whether the failure is worth retrying.
//    A provider that keeps returning an empty body is retryable; a 401 is not.

export interface LLMErrorContext {
  provider?: string;
  model?: string;
}

/** Truncate anything (string, object, HTML page) to something loggable. */
export function describeBody(value: unknown, max = 300): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value instanceof Error) text = value.stack ?? value.message;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * A provider answered, but the answer is unusable: no choices, no text, or a
 * payload the provider rejected inside a 200. Carries `retryable` so the retry
 * layer does not have to re-derive intent from the message.
 */
export class LLMResponseError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly provider?: string;
  readonly model?: string;
  readonly bodySnippet?: string;

  constructor(
    message: string,
    opts: { retryable: boolean; status?: number; bodySnippet?: string } & LLMErrorContext,
  ) {
    super(message);
    this.name = "LLMResponseError";
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.provider = opts.provider;
    this.model = opts.model;
    this.bodySnippet = opts.bodySnippet;
  }
}

/**
 * Wrap whatever the SDK threw into an Error whose message a human can act on.
 * The SDK already classifies HTTP errors (status + body), so this mostly
 * forwards: status, provider, model, and a body snippet when one exists.
 */
export function wrapProviderError(err: unknown, ctx: LLMErrorContext): Error {
  const anyErr = err as any;
  const status: number | undefined =
    typeof anyErr?.status === "number" ? anyErr.status
    : typeof anyErr?.statusCode === "number" ? anyErr.statusCode
    : typeof anyErr?.response?.status === "number" ? anyErr.response.status
    : undefined;

  const body =
    anyErr?.error ?? anyErr?.response?.data ?? anyErr?.body ??
    (typeof anyErr?.message === "string" ? anyErr.message : err);

  const retryable =
    status === 408 || status === 409 || status === 429 || (typeof status === "number" && status >= 500);

  const label = [ctx.provider, ctx.model].filter(Boolean).join(" / ") || "provider";
  const message =
    `${label} request failed` +
    (status ? ` (HTTP ${status})` : "") +
    `: ${describeBody(body, 240)}`;

  return new LLMResponseError(message, {
    retryable,
    status,
    bodySnippet: describeBody(body, 400),
    ...ctx,
  });
}

/**
 * Assert that a chat-completions payload actually carries a choice, and return
 * its first message content. Throws a descriptive, retryable error otherwise.
 */
export function requireCompletionText(
  response: unknown,
  ctx: LLMErrorContext,
): string {
  const anyRes = response as any;
  const choices = anyRes?.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    const apiError = anyRes?.error;
    throw new LLMResponseError(
      `${ctx.provider ?? "Provider"} returned no choices for model "${ctx.model ?? "unknown"}"` +
        (apiError ? ` — the API reported: ${describeBody(apiError, 200)}` : ` — body: ${describeBody(response)}`),
      { retryable: true, bodySnippet: describeBody(response, 400), ...ctx },
    );
  }

  const choice = choices[0];
  const content = choice?.message?.content;

  if (typeof content !== "string" || content.trim() === "") {
    throw new LLMResponseError(
      `${ctx.provider ?? "Provider"} returned an empty completion for model "${ctx.model ?? "unknown"}"` +
        (choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : ""),
      { retryable: true, bodySnippet: describeBody(choice, 400), ...ctx },
    );
  }

  return content;
}

/**
 * Same for the Anthropic messages API: `content` is an array of blocks and the
 * first text block is the answer.
 */
export function requireAnthropicText(
  response: unknown,
  ctx: LLMErrorContext,
): string {
  const blocks = (response as any)?.content;

  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new LLMResponseError(
      `Anthropic returned no content blocks for model "${ctx.model ?? "unknown"}" — body: ${describeBody(response)}`,
      { retryable: true, bodySnippet: describeBody(response, 400), ...ctx },
    );
  }

  const text = blocks
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
    .trim();

  if (!text) {
    throw new LLMResponseError(
      `Anthropic returned no text block for model "${ctx.model ?? "unknown"}" — body: ${describeBody(response)}`,
      { retryable: true, bodySnippet: describeBody(response, 400), ...ctx },
    );
  }

  return text;
}

/** One-line summary of an unknown thrown value, for logs and job warnings. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return describeBody(err, 240);
}
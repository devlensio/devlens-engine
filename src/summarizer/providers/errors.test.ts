import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { OpenAIClient } from "./openai.js";
import { LLMResponseError } from "./errors.js";
import { withRetry } from "../retry.js";

let server: any;
const received: string[] = [];
const GOOD = "<technical>Does a thing.</technical><business>Helps users.</business><security_severity>none</security_severity>";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      received.push(body);

      if (body.includes("FAIL_CHOICES")) {
        return Response.json({ error: { message: "quota exceeded", type: "rate_limit" } });
      }
      if (body.includes("FAIL_EMPTY")) {
        return Response.json({ choices: [] });
      }
      if (body.includes("FAIL_HTTP")) {
        return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), { status: 500 });
      }
      return Response.json({
        choices: [{ message: { role: "assistant", content: GOOD }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 20 },
      });
    },
  });
});

afterAll(() => server?.stop(true));

function client() {
  return new OpenAIClient("test-key", "mock-model", `http://127.0.0.1:${server.port}/v1`, "mock-gateway");
}

async function ask(marker: string) {
  return client().summarize({
    messages: [{ role: "user", content: marker }],
    temperature: 0,
  });
}

describe("provider response handling", () => {
  it("summarizes a well-formed response", async () => {
    const out = await ask("hello");
    expect(out.technicalSummary).toBe("Does a thing.");
    expect(out.tokensUsed).toBe(30);
  });

  it("turns a 200 carrying an error body into an actionable, retryable error", async () => {
    const err = await ask("FAIL_CHOICES").catch(e => e);

    expect(err).toBeInstanceOf(LLMResponseError);
    expect(err.message).toContain("no choices");
    expect(err.message).toContain("mock-gateway");
    expect(err.message).toContain("mock-model");
    expect(err.message).toContain("quota exceeded");
    expect(err.retryable).toBe(true);
  });

  it("turns an empty choices array into an actionable error", async () => {
    const err = await ask("FAIL_EMPTY").catch(e => e);
    expect(err).toBeInstanceOf(LLMResponseError);
    expect(err.message).toContain("no choices");
  });

  it("keeps the HTTP status on server errors", async () => {
    const err = await ask("FAIL_HTTP").catch(e => e);
    expect(err).toBeInstanceOf(LLMResponseError);
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(true);
  });
});

describe("retry with exponential backoff", () => {
  it("retries a retryable failure and succeeds", async () => {
    let attempts = 0;
    const value = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new LLMResponseError("temporary", { retryable: true });
        return "ok";
      },
      { maxAttempts: 4, baseDelayMs: 20, maxDelayMs: 100 },
      "test",
    );

    expect(value).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("backs off exponentially", async () => {
    const started = Date.now();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts++;
        throw new LLMResponseError("always", { retryable: true });
      },
      { maxAttempts: 3, baseDelayMs: 60, maxDelayMs: 1000 },
      "backoff",
    ).catch(() => {});

    const elapsed = Date.now() - started;
    expect(attempts).toBe(3);
    expect(elapsed).toBeGreaterThanOrEqual(60 + 120);
  });

  it("does not retry when the error is marked non-retryable", async () => {
    let attempts = 0;
    await withRetry(
      async () => {
        attempts++;
        throw new LLMResponseError("bad key", { retryable: false, status: 401 });
      },
      { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 20 },
      "no-retry",
    ).catch(() => {});

    expect(attempts).toBe(1);
  });
});
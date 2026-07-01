// spec(§7) — OpenRouter ModelProviderPort adapter (5.7): its OWN processor (never an
// OpenAI alias, safety rule 5), distinct endpoint path + providerId; request mapping,
// output→candidate, error/cancel mapping, redaction.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { createOpenRouterModelProvider } from "../src/model/openrouter-provider";
import { createOpenAiModelProvider } from "../src/model/openai-provider";
import {
  respondingTransport,
  secretsReturning,
  openAiBody,
  makeRequest,
} from "./_model-fixtures";

const orReq = () =>
  makeRequest({ provider: "openrouter", model: "anthropic/claude-opus-4", endpoint: "https://openrouter.ai" });

describe("createOpenRouterModelProvider — distinct processor identity", () => {
  it("serves providerId 'openrouter' — NOT 'openai'", () => {
    const provider = createOpenRouterModelProvider({
      transport: respondingTransport(200, openAiBody({ ok: true })),
      secrets: secretsReturning("sk-or"),
      secretRef: "keychain://providers/openrouter",
    });
    expect(provider.providerId).toBe("openrouter");
    expect(provider.providerId).not.toBe("openai");
  });

  it("posts to OpenRouter's own /api/v1/chat/completions path (distinct from OpenAI's)", async () => {
    const orTransport = respondingTransport(200, openAiBody({ ok: true }));
    const orProvider = createOpenRouterModelProvider({
      transport: orTransport,
      secrets: secretsReturning("sk-or-key-99"),
      secretRef: "keychain://providers/openrouter",
    });
    await orProvider.complete(orReq());
    expect(orTransport.lastRequest!.url).toBe("https://openrouter.ai/api/v1/chat/completions");

    // Contrast: the OpenAI adapter uses a different path — the two are not aliases.
    const oaiTransport = respondingTransport(200, openAiBody({ ok: true }));
    const oaiProvider = createOpenAiModelProvider({
      transport: oaiTransport,
      secrets: secretsReturning("sk"),
      secretRef: "keychain://providers/openai",
    });
    await oaiProvider.complete(makeRequest({ provider: "openai", endpoint: "https://openrouter.ai" }));
    expect(oaiTransport.lastRequest!.url).not.toBe(orTransport.lastRequest!.url);
  });
});

describe("createOpenRouterModelProvider — completion + errors", () => {
  it("parses the OpenAI-compatible body into a candidate object", async () => {
    const transport = respondingTransport(200, openAiBody({ verdict: "accepted" }));
    const provider = createOpenRouterModelProvider({
      transport,
      secrets: secretsReturning("sk-or"),
      secretRef: "keychain://providers/openrouter",
    });
    const res = await provider.complete(orReq());
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.candidateOutput).toEqual({ verdict: "accepted" });
  });

  it("maps HTTP 429 to a retryable rate_limited error", async () => {
    const transport = respondingTransport(429, "");
    const provider = createOpenRouterModelProvider({
      transport,
      secrets: secretsReturning("sk-or"),
      secretRef: "keychain://providers/openrouter",
    });
    const res = await provider.complete(orReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("rate_limited");
    expect(res.error.retryable).toBe(true);
  });

  it("returns cancelled for an already-aborted signal", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createOpenRouterModelProvider({
      transport,
      secrets: secretsReturning("sk-or"),
      secretRef: "keychain://providers/openrouter",
    });
    const ac = new AbortController();
    ac.abort();
    const res = await provider.complete(orReq(), ac.signal);
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("cancelled");
    expect(transport.calls).toBe(0);
  });
});

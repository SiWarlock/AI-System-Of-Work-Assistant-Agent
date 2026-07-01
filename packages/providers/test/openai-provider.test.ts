// spec(§7) — OpenAI ModelProviderPort adapter (5.7): OpenAI Chat Completions request
// mapping, output→candidate, error/cancel mapping, Bearer-key from SecretsPort, redaction.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { createOpenAiModelProvider } from "../src/model/openai-provider";
import type { SafeProviderLog } from "../src/redaction/provider-log-redaction";
import {
  respondingTransport,
  throwingTransport,
  secretsReturning,
  secretsUnavailable,
  openAiBody,
  makeRequest,
} from "./_model-fixtures";

const oaiReq = () =>
  makeRequest({ provider: "openai", model: "gpt-4o", endpoint: "https://api.openai.com" });

describe("createOpenAiModelProvider — request mapping", () => {
  it("serves providerId 'openai' and posts to /v1/chat/completions with a Bearer key", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createOpenAiModelProvider({
      transport,
      secrets: secretsReturning("sk-openai-key-123456"),
      secretRef: "keychain://providers/openai",
    });
    expect(provider.providerId).toBe("openai");
    const res = await provider.complete(oaiReq());
    expect(isOk(res)).toBe(true);
    const sent = transport.lastRequest!;
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.headers["Authorization"]).toBe("Bearer sk-openai-key-123456");
    const body = JSON.parse(sent.body) as {
      model: string;
      response_format: { type: string; json_schema: { name: string } };
    };
    expect(body.model).toBe("gpt-4o");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("sow:meeting-close-output");
  });
});

describe("createOpenAiModelProvider — output → candidate + errors", () => {
  it("parses choices[0].message.content into a candidate object + usage", async () => {
    const transport = respondingTransport(200, openAiBody({ summary: "done" }));
    const provider = createOpenAiModelProvider({
      transport,
      secrets: secretsReturning("sk"),
      secretRef: "keychain://providers/openai",
    });
    const res = await provider.complete(oaiReq());
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.candidateOutput).toEqual({ summary: "done" });
    expect(res.value.usage.inputTokens).toBe(11);
    expect(res.value.usage.outputTokens).toBe(7);
  });

  it("maps HTTP 400 to invalid_request (not retryable)", async () => {
    const transport = respondingTransport(400, "");
    const provider = createOpenAiModelProvider({
      transport,
      secrets: secretsReturning("sk"),
      secretRef: "keychain://providers/openai",
    });
    const res = await provider.complete(oaiReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("invalid_request");
    expect(res.error.retryable).toBe(false);
  });

  it("maps HTTP 500 to a retryable transport_error", async () => {
    const transport = respondingTransport(503, "");
    const provider = createOpenAiModelProvider({
      transport,
      secrets: secretsReturning("sk"),
      secretRef: "keychain://providers/openai",
    });
    const res = await provider.complete(oaiReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("transport_error");
    expect(res.error.retryable).toBe(true);
  });

  it("maps HTTP 401 to a retryable auth_unavailable (unlock/rotate then re-drive)", async () => {
    const transport = respondingTransport(401, "");
    const provider = createOpenAiModelProvider({
      transport,
      secrets: secretsReturning("sk"),
      secretRef: "keychain://providers/openai",
    });
    const res = await provider.complete(oaiReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("auth_unavailable");
    expect(res.error.retryable).toBe(true);
  });
});

describe("createOpenAiModelProvider — degrade + cancel + redaction", () => {
  it("degrades (auth_unavailable) on a missing Keychain key without dispatching", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createOpenAiModelProvider({
      transport,
      secrets: secretsUnavailable("missing"),
      secretRef: "keychain://providers/openai",
    });
    const res = await provider.complete(oaiReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("auth_unavailable");
    expect(transport.calls).toBe(0);
  });

  it("returns cancelled for an already-aborted signal", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createOpenAiModelProvider({
      transport,
      secrets: secretsReturning("sk"),
      secretRef: "keychain://providers/openai",
    });
    const ac = new AbortController();
    ac.abort();
    const res = await provider.complete(oaiReq(), ac.signal);
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("cancelled");
    expect(transport.calls).toBe(0);
  });

  it("never emits the Bearer key into an emitted log", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const logs: SafeProviderLog[] = [];
    const provider = createOpenAiModelProvider({
      transport,
      secrets: secretsReturning("sk-openai-key-123456"),
      secretRef: "keychain://providers/openai",
      logSink: (l) => logs.push(l),
    });
    await provider.complete(oaiReq());
    expect(JSON.stringify(logs)).not.toContain("sk-openai-key-123456");
  });
});

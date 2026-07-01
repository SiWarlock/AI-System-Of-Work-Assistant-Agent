// spec(§7) — Claude ModelProviderPort adapter (5.7): Anthropic Messages API request
// mapping, output→candidate, error/timeout/cancel mapping, Keychain-degrade, redaction.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  createClaudeModelProvider,
  ANTHROPIC_VERSION,
} from "../src/model/claude-provider";
import type { SafeProviderLog } from "../src/redaction/provider-log-redaction";
import {
  MockTransport,
  respondingTransport,
  throwingTransport,
  secretsReturning,
  secretsUnavailable,
  anthropicBody,
  makeRequest,
} from "./_model-fixtures";

const claudeReq = () =>
  makeRequest({ provider: "claude", model: "claude-opus-4-8", endpoint: "https://api.anthropic.com" });

describe("createClaudeModelProvider — request mapping", () => {
  it("serves providerId 'claude' and posts to the Messages API with x-api-key + version headers", async () => {
    const transport = respondingTransport(200, anthropicBody({ ok: true }));
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant-secretkey-abcdef"),
      secretRef: "keychain://providers/claude",
    });
    expect(provider.providerId).toBe("claude");

    const res = await provider.complete(claudeReq());
    expect(isOk(res)).toBe(true);
    const sent = transport.lastRequest!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent.headers["x-api-key"]).toBe("sk-ant-secretkey-abcdef");
    expect(sent.headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    const body = JSON.parse(sent.body) as {
      model: string;
      messages: { role: string; content: string }[];
      output_config: { format: { schema: { $id: string } } };
    };
    expect(body.model).toBe("claude-opus-4-8");
    // Input refs are referenced, never inlined raw content.
    expect(body.messages[0]?.content).toContain("[note:note-123]");
    expect(body.output_config.format.schema.$id).toBe("sow:meeting-close-output");
  });

  it("resolves the key from the injected SecretsPort ref — never an inline key", async () => {
    const transport = respondingTransport(200, anthropicBody({ ok: true }));
    let askedRef = "";
    const provider = createClaudeModelProvider({
      transport,
      secrets: { getSecret: async (ref) => { askedRef = ref; return { ok: true, value: "sk-live" }; } },
      secretRef: "keychain://providers/claude",
    });
    await provider.complete(claudeReq());
    expect(askedRef).toBe("keychain://providers/claude");
  });
});

describe("createClaudeModelProvider — output → candidate", () => {
  it("parses the text block into a candidate object + folds token usage", async () => {
    const transport = respondingTransport(200, anthropicBody({ decision: "close", owner: "TBD" }));
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant"),
      secretRef: "keychain://providers/claude",
    });
    const res = await provider.complete(claudeReq());
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.status).toBe("completed");
    expect(res.value.candidateOutput).toEqual({ decision: "close", owner: "TBD" });
    expect(res.value.usage.inputTokens).toBe(13);
    expect(res.value.usage.outputTokens).toBe(9);
  });

  it("maps non-JSON completion text to malformed_output", async () => {
    const badBody = JSON.stringify({ content: [{ type: "text", text: "not json" }] });
    const transport = respondingTransport(200, badBody);
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant"),
      secretRef: "keychain://providers/claude",
    });
    const res = await provider.complete(claudeReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("malformed_output");
  });
});

describe("createClaudeModelProvider — error / timeout / cancel mapping", () => {
  it("maps HTTP 429 to a retryable rate_limited error", async () => {
    const transport = respondingTransport(429, "");
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant"),
      secretRef: "keychain://providers/claude",
    });
    const res = await provider.complete(claudeReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("rate_limited");
    expect(res.error.retryable).toBe(true);
  });

  it("maps HTTP 404 to model_unavailable", async () => {
    const transport = respondingTransport(404, "");
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant"),
      secretRef: "keychain://providers/claude",
    });
    const res = await provider.complete(claudeReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("model_unavailable");
  });

  it("maps a transport timeout throw to a retryable timeout", async () => {
    const transport = throwingTransport(Object.assign(new Error("slow"), { name: "TimeoutError" }));
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant"),
      secretRef: "keychain://providers/claude",
    });
    const res = await provider.complete(claudeReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("timeout");
    expect(res.error.retryable).toBe(true);
  });

  it("returns cancelled for an already-aborted signal without calling the transport", async () => {
    const transport = respondingTransport(200, anthropicBody({ ok: true }));
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant"),
      secretRef: "keychain://providers/claude",
    });
    const ac = new AbortController();
    ac.abort();
    const res = await provider.complete(claudeReq(), ac.signal);
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("cancelled");
    expect(transport.calls).toBe(0);
  });

  it("classifies a transport AbortError throw as cancelled", async () => {
    const transport = throwingTransport(
      Object.assign(new Error("connection reset"), { name: "AbortError" }),
    );
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant"),
      secretRef: "keychain://providers/claude",
    });
    const res = await provider.complete(claudeReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("cancelled");
  });
});

describe("createClaudeModelProvider — Keychain degrade + redaction (5.6/5.9)", () => {
  it("marks the provider degraded (auth_unavailable, retryable) when the key is locked", async () => {
    const transport = respondingTransport(200, anthropicBody({ ok: true }));
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsUnavailable("locked"),
      secretRef: "keychain://providers/claude",
    });
    const res = await provider.complete(claudeReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("auth_unavailable");
    expect(res.error.retryable).toBe(true);
    // Never dispatched — no key, no call.
    expect(transport.calls).toBe(0);
  });

  it("redacts a credential-shaped string echoed by a transport fault before it reaches the sink", async () => {
    const leak = "boom key=sk-LEAKED0123456789abcdef";
    const transport = throwingTransport(new Error(leak));
    const logs: SafeProviderLog[] = [];
    const provider = createClaudeModelProvider({
      transport,
      secrets: secretsReturning("sk-ant"),
      secretRef: "keychain://providers/claude",
      logSink: (l) => logs.push(l),
    });
    const res = await provider.complete(claudeReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.message).not.toContain("sk-LEAKED0123456789abcdef");
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("sk-LEAKED0123456789abcdef");
    // The api key itself never appears in any emitted log.
    expect(serialized).not.toContain("sk-ant");
  });
});

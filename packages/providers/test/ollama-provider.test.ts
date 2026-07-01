// spec(§7) — Ollama ModelProviderPort adapter (5.7): loopback / non-egress; endpoint
// from an EXPLICIT allowlist (arbitrary URL rejected); no secret; output→candidate;
// error/cancel mapping.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { createOllamaModelProvider } from "../src/model/ollama-provider";
import {
  respondingTransport,
  openAiBody,
  makeRequest,
} from "./_model-fixtures";

const LOOPBACK = "http://127.0.0.1:11434";
const ollamaReq = (endpoint = LOOPBACK) =>
  makeRequest({ provider: "ollama", model: "llama3.1", endpoint, egressClass: "local" });

describe("createOllamaModelProvider — allowlist + no-secret", () => {
  it("serves providerId 'ollama' and posts to an allowlisted loopback endpoint with NO Authorization header", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createOllamaModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    expect(provider.providerId).toBe("ollama");
    const res = await provider.complete(ollamaReq());
    expect(isOk(res)).toBe(true);
    const sent = transport.lastRequest!;
    expect(sent.url).toBe(`${LOOPBACK}/v1/chat/completions`);
    expect(sent.headers["Authorization"]).toBeUndefined();
  });

  it("REJECTS an arbitrary / unlisted endpoint (invalid_request) without dispatching", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createOllamaModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    const res = await provider.complete(ollamaReq("http://evil.example.com:11434"));
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("invalid_request");
    expect(transport.calls).toBe(0);
  });
});

describe("createOllamaModelProvider — completion + errors", () => {
  it("parses the OpenAI-compatible body into a candidate object", async () => {
    const transport = respondingTransport(200, openAiBody({ tasks: [] }));
    const provider = createOllamaModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    const res = await provider.complete(ollamaReq());
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.candidateOutput).toEqual({ tasks: [] });
  });

  it("maps HTTP 500 to a retryable transport_error", async () => {
    const transport = respondingTransport(500, "");
    const provider = createOllamaModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    const res = await provider.complete(ollamaReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("transport_error");
    expect(res.error.retryable).toBe(true);
  });

  it("returns cancelled for an already-aborted signal", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createOllamaModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    const ac = new AbortController();
    ac.abort();
    const res = await provider.complete(ollamaReq(), ac.signal);
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("cancelled");
    expect(transport.calls).toBe(0);
  });
});

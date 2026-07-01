// spec(§7) — LM Studio ModelProviderPort adapter (5.7): loopback / non-egress; endpoint
// from an EXPLICIT allowlist (arbitrary URL rejected); no secret; output→candidate;
// error/cancel mapping.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import { createLmStudioModelProvider } from "../src/model/lmstudio-provider";
import {
  respondingTransport,
  openAiBody,
  makeRequest,
} from "./_model-fixtures";

const LOOPBACK = "http://127.0.0.1:1234";
const lmReq = (endpoint = LOOPBACK) =>
  makeRequest({ provider: "lm_studio", model: "local-model", endpoint, egressClass: "local" });

describe("createLmStudioModelProvider — allowlist + no-secret", () => {
  it("serves providerId 'lm_studio' and posts to an allowlisted loopback endpoint with NO Authorization header", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createLmStudioModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    expect(provider.providerId).toBe("lm_studio");
    const res = await provider.complete(lmReq());
    expect(isOk(res)).toBe(true);
    const sent = transport.lastRequest!;
    expect(sent.url).toBe(`${LOOPBACK}/v1/chat/completions`);
    expect(sent.headers["Authorization"]).toBeUndefined();
  });

  it("REJECTS an arbitrary / unlisted endpoint (invalid_request) without dispatching", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createLmStudioModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    const res = await provider.complete(lmReq("http://10.0.0.9:1234"));
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("invalid_request");
    expect(transport.calls).toBe(0);
  });
});

describe("createLmStudioModelProvider — completion + errors", () => {
  it("parses the OpenAI-compatible body into a candidate object + folds usage", async () => {
    const transport = respondingTransport(200, openAiBody({ note: "x" }, { prompt: 5, completion: 3 }));
    const provider = createLmStudioModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    const res = await provider.complete(lmReq());
    if (!isOk(res)) throw new Error("expected ok");
    expect(res.value.candidateOutput).toEqual({ note: "x" });
    expect(res.value.usage.inputTokens).toBe(5);
    expect(res.value.usage.outputTokens).toBe(3);
  });

  it("maps non-JSON completion content to malformed_output", async () => {
    const badBody = JSON.stringify({ choices: [{ message: { content: "plain text" } }] });
    const transport = respondingTransport(200, badBody);
    const provider = createLmStudioModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    const res = await provider.complete(lmReq());
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("malformed_output");
  });

  it("returns cancelled for an already-aborted signal", async () => {
    const transport = respondingTransport(200, openAiBody({ ok: true }));
    const provider = createLmStudioModelProvider({ transport, allowedEndpoints: [LOOPBACK] });
    const ac = new AbortController();
    ac.abort();
    const res = await provider.complete(lmReq(), ac.signal);
    if (!isErr(res)) throw new Error("expected err");
    expect(res.error.kind).toBe("cancelled");
    expect(transport.calls).toBe(0);
  });
});

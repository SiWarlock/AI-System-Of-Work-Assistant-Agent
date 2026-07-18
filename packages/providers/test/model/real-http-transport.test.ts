// spec(§19.5)/spec(§16) — 18.18b: the real, dependency-injected HttpTransport over Node
// `fetch`. A THIN pass-through — it does the HTTP round-trip and returns { status, body }
// verbatim; it NEVER classifies status (executeCompletion → providerErrorFromStatus does),
// NEVER swallows/wraps a network throw (classifyTransportThrow maps abort/timeout/error), and
// takes NO log sink (never echoes the secret-bearing headers/body, rule 7). Mock-fetch tested:
// no real network call in any test (SAFE-BUILD; not enabled — no production call-site yet, L11).
import { describe, it, expect, vi } from "vitest";
import type { HttpTransportRequest } from "../../src/model/http-transport";
import {
  createRealModelHttpTransport,
  type FetchLike,
  type FetchResponseLike,
} from "../../src/model/real-http-transport";

const REQ: HttpTransportRequest = {
  url: "https://api.anthropic.com/v1/messages",
  method: "POST",
  headers: { "x-api-key": "SUPER-SECRET-KEY", "content-type": "application/json" },
  body: '{"model":"claude-opus-4-8"}',
};

const okResponse: FetchResponseLike = { status: 200, text: async () => '{"ok":true}' };

describe("createRealModelHttpTransport — injected-fetch pass-through (18.18b, §19.5/§16)", () => {
  it("request_maps_verbatim_to_fetch — url/method/headers/body reach fetch unchanged", async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return okResponse;
    };
    await createRealModelHttpTransport({ fetch }).send(REQ);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("no fetch call captured");
    expect(call.url).toBe(REQ.url);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual(REQ.headers);
    expect(call.init.body).toBe(REQ.body);
  });

  it("ok_response_maps_status_and_body — 2xx → { status, body } via text()", async () => {
    const fetch: FetchLike = async () => ({ status: 200, text: async () => "hello-body" });
    const res = await createRealModelHttpTransport({ fetch }).send(REQ);
    expect(res).toEqual({ status: 200, body: "hello-body" });
  });

  it("non_2xx_passes_through_no_throw — 500 → { status, body }, no throw, no classification", async () => {
    // Context7/undici: `fetch` rejects only on network failure — a 4xx/5xx still fulfills. The
    // transport passes it through; executeCompletion → providerErrorFromStatus maps it, not us.
    const fetch: FetchLike = async () => ({ status: 500, text: async () => "err-body" });
    const res = await createRealModelHttpTransport({ fetch }).send(REQ);
    expect(res).toEqual({ status: 500, body: "err-body" });
  });

  it("network_throw_propagates_unchanged — same error reference (L15 non-vacuous)", async () => {
    // classifyTransportThrow owns abort/timeout/error mapping; the transport must not swallow/wrap.
    const boom = new Error("ECONNREFUSED");
    const fetch: FetchLike = async () => {
      throw boom;
    };
    await expect(createRealModelHttpTransport({ fetch }).send(REQ)).rejects.toBe(boom);
  });

  it("abort_signal_forwarded_to_fetch — signal reaches fetch; an aborted signal's throw propagates unchanged", async () => {
    let seen: AbortSignal | undefined;
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetch: FetchLike = async (_url, init) => {
      seen = init.signal;
      if (init.signal?.aborted === true) throw abortErr;
      return okResponse;
    };
    const t = createRealModelHttpTransport({ fetch });

    const live = new AbortController();
    await t.send(REQ, live.signal);
    expect(seen).toBe(live.signal); // forwarded verbatim (cooperative cancel, 5.4)

    const aborted = new AbortController();
    aborted.abort();
    await expect(t.send(REQ, aborted.signal)).rejects.toBe(abortErr); // propagates unchanged
  });

  it("drives fetch with redirect:'manual' + a COPIED headers object (rule 7 wire-safety + defense-in-depth)", async () => {
    // A cross-origin 3xx would re-send x-api-key (undici strips only authorization/cookie); "manual"
    // returns the 3xx to the executor → fail-closed. Enforced for EVERY injected fetch (not just default).
    let seen: Parameters<FetchLike>[1] | undefined;
    const fetch: FetchLike = async (_url, init) => {
      seen = init;
      return okResponse;
    };
    await createRealModelHttpTransport({ fetch }).send(REQ);
    expect(seen?.redirect).toBe("manual");
    expect(seen?.headers).toEqual(REQ.headers);
    expect(seen?.headers).not.toBe(REQ.headers); // a COPY — never the caller's live secret map
  });

  it("no_secret_in_observable_output — no log-sink dep + no console.* call; x-api-key never echoed (rule 7)", async () => {
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const spies = methods.map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const fetch: FetchLike = async () => okResponse;
    // RealHttpTransportDeps has NO logSink field (compile-time guarantee); assert no runtime leak.
    const res = await createRealModelHttpTransport({ fetch }).send(REQ);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
    // the observable output is { status, body } ONLY — never the secret-bearing request headers.
    expect(Object.keys(res).sort()).toEqual(["body", "status"]);
    expect(JSON.stringify(res)).not.toContain("SUPER-SECRET-KEY");
  });

  it("default fetch = the Node global (when deps.fetch omitted) — forwards all fields + normalizes text()", async () => {
    // Covers the ONLY production-path code (the default wrapper) with NO real network — the spy
    // intercepts globalThis.fetch. Pins field-forwarding + res.text()→body + method-call this-binding.
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ status: 200, text: async () => "global-body" } as unknown as Response);
    try {
      const ctrl = new AbortController();
      const res = await createRealModelHttpTransport().send(REQ, ctrl.signal); // no deps.fetch → default
      expect(res).toEqual({ status: 200, body: "global-body" });
      expect(spy).toHaveBeenCalledTimes(1);
      const call = spy.mock.calls[0];
      if (call === undefined) throw new Error("global fetch not called");
      const [url, init] = call;
      expect(url).toBe(REQ.url);
      expect(init).toMatchObject({ method: "POST", body: REQ.body, redirect: "manual", signal: ctrl.signal });
      expect(init?.headers).toEqual(REQ.headers); // spread copy, verbatim
    } finally {
      spy.mockRestore();
    }
  });
});

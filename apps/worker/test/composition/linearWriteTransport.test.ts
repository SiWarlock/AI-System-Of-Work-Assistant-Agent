// The real HTTP client and the owner switch for Linear writes. Linear slice 2 of 6, part 2.
//
// ⛔ OFF UNLESS THE OWNER TURNS IT ON, and off again if anything it needs is missing. The switch
// (`SOW_LINEAR_WRITES`) only BUILDS a gate; `selectAdapterTransport` still requires `enabled === true`
// AND a factory, and nothing is constructed until the gate is used. With no credential source there is
// no gate at all — a switch that is on but cannot authenticate must not look armed.
//
// ⚠ Arming this alone still creates NO Linear issue: nothing proposes one yet, and approving an
// external write in the Approvals screen goes to a no-op (slices 3 and 5). This slice makes the SENDER
// correct and switchable; it does not make anything send.
import { describe, it, expect, vi } from "vitest";
import { ok } from "@sow/contracts";
import type { AdapterTransportRequest } from "@sow/integrations";
import type { HttpTransport, HttpTransportRequest } from "@sow/integrations/tools/adapters/write-http-transport";
import { createFetchHttpTransport, buildLinearWriteTransportGate } from "../../src/composition/linearWriteTransport";
import { selectAdapterTransport } from "../../src/composition/backends";

function req(targetSystem: AdapterTransportRequest["targetSystem"], op: AdapterTransportRequest["op"] = "query"): AdapterTransportRequest {
  return { op, targetSystem, canonicalObjectKey: "cok", idempotencyKey: "idem", identity: {}, workspaceId: "employer-work" };
}
const secrets = { getSecret: vi.fn(async () => ok("lin_api_FAKE")) };

describe("createFetchHttpTransport — the real client, over an injected fetch", () => {
  it("sends url, method, headers and body, with redirects NOT followed, and returns status + text", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"a":1}', { status: 201 }));
    const http = createFetchHttpTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const out = await http.send({ url: "https://api.linear.app/graphql", method: "POST", headers: { "content-type": "application/json" }, body: "{}", redirect: "manual" });
    expect(out).toEqual({ status: 201, body: '{"a":1}' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual"); // a cross-origin 3xx would re-send the Authorization header
    expect(init?.body).toBe("{}");
  });

  it("gives up after its timeout instead of hanging a write forever", async () => {
    const fetchImpl = vi.fn((_u: string, init: RequestInit) =>
      new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted")))),
    );
    const http = createFetchHttpTransport({ timeoutMs: 10, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(http.send({ url: "https://api.linear.app/graphql", method: "POST", headers: {}, redirect: "manual" })).rejects.toThrow();
  });
});

describe("buildLinearWriteTransportGate — the owner switch", () => {
  it("is ABSENT when the switch is off or unset — nothing armed, nothing built", () => {
    expect(buildLinearWriteTransportGate({ enabled: undefined, secrets })).toBeUndefined();
    expect(buildLinearWriteTransportGate({ enabled: false, secrets })).toBeUndefined();
  });

  it("⛔ is ABSENT when on but there is NO credential source — a switch that cannot authenticate must not look armed", () => {
    expect(buildLinearWriteTransportGate({ enabled: true, secrets: undefined })).toBeUndefined();
  });

  it("builds NOTHING until used — the factory is lazy", () => {
    const http: HttpTransport = { send: vi.fn(async () => ({ status: 200, body: "{}" })) };
    const gate = buildLinearWriteTransportGate({ enabled: true, secrets, http });
    expect(gate?.enabled).toBe(true);
    expect(http.send).not.toHaveBeenCalled();
    expect(secrets.getSecret).not.toHaveBeenCalled();
  });

  it("once selected, sends Linear writes to api.linear.app with the RAW key, and refuses every other service", async () => {
    const calls: HttpTransportRequest[] = [];
    const http: HttpTransport = {
      async send(r) {
        calls.push(r);
        return { status: 200, body: JSON.stringify({ data: { issues: { nodes: [] } } }) };
      },
    };
    const transport = selectAdapterTransport(buildLinearWriteTransportGate({ enabled: true, secrets, http }));
    const linear = await transport(req("linear"));
    expect(linear).toEqual({ ok: true, object: null }); // a clean MISS from the filter probe
    expect(calls[0]?.url).toBe("https://api.linear.app/graphql");
    expect(calls[0]?.headers["Authorization"]).toBe("lin_api_FAKE"); // raw, no Bearer
    const todoist = await transport(req("todoist"));
    expect(!todoist.ok && todoist.faultDetail).toBe("target_not_armed");
    expect(calls).toHaveLength(1); // the refused service never reached the network
  });
});

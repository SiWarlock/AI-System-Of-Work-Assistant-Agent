// The real HTTP client and the owner switch for Linear writes. Linear slice 2 of 6, part 2.
//
// ⛔ OFF UNLESS THE OWNER TURNS IT ON, and off again if anything it needs is missing. The switch
// (`SOW_LINEAR_WRITES`) arms only when a workspace's Linear key actually RESOLVES from the Keychain.
// An accessor that merely exists is not proof of a key: the first cut checked construction, so the
// switch reported ARMED with no key at all (review, 2026-09-21, upheld 3/3).
//
// ⚠ Arming this alone still creates NO Linear issue: nothing proposes one yet (slice 5). Approving an
// external write in the Approvals screen does send it since slice 3+4, but there is nothing to approve.
// This file pins the SENDER and the switch; it does not make anything send.
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type { AdapterTransportRequest, WriteSecretsAccessor } from "@sow/integrations";
import type { HttpTransport, HttpTransportRequest } from "@sow/integrations/tools/adapters/write-http-transport";
import {
  createFetchHttpTransport,
  resolveLinearWriteArming,
  describeLinearWriteArming,
  LINEAR_ARMING_WORKSPACES,
} from "../../src/composition/linearWriteTransport";
import { selectAdapterTransport } from "../../src/composition/backends";

function req(targetSystem: AdapterTransportRequest["targetSystem"], op: AdapterTransportRequest["op"] = "query"): AdapterTransportRequest {
  return { op, targetSystem, canonicalObjectKey: "cok", idempotencyKey: "idem", identity: {}, workspaceId: "employer-work" };
}

const KEY = "lin_api_FAKE";
/** A Keychain fake holding a Linear key for exactly the named workspaces, and nothing else. */
function keychainWith(workspaces: readonly string[]): WriteSecretsAccessor & { getSecret: ReturnType<typeof vi.fn> } {
  return {
    getSecret: vi.fn(async (ref: string) =>
      workspaces.some((ws) => ref === `keychain://connector-write.${ws}/linear`) ? ok(KEY) : err({ reason: "missing" as const }),
    ),
  };
}
const WORKSPACES = ["employer-work", "personal-business", "personal-life"] as const;

describe("createFetchHttpTransport — the real client, over an injected fetch", () => {
  it("sends url, method, headers and body, with redirects NOT followed, and returns status + text", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response('{"a":1}', { status: 201 }));
    const http = createFetchHttpTransport({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const headers = { "content-type": "application/json", Authorization: "lin_api_FAKE" };
    const out = await http.send({ url: "https://api.linear.app/graphql", method: "POST", headers, body: "{}", redirect: "manual" });
    expect(out).toEqual({ status: 201, body: '{"a":1}' });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init?.method).toBe("POST");
    // ⛔ The Authorization header must reach fetch: dropping it would turn every live write into a 401.
    expect(init?.headers).toEqual(headers);
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

describe("LINEAR_ARMING_WORKSPACES — where the switch looks for a key", () => {
  it("is the three scopes onboarding can create (the wizard sets id = scope for the type)", () => {
    expect([...LINEAR_ARMING_WORKSPACES].sort()).toEqual([...WORKSPACES].sort());
  });
});

describe("resolveLinearWriteArming — the owner switch, armed only by a key that RESOLVES", () => {
  it("is NOT ARMED when the switch is off or unset — and reads no credential", async () => {
    const secrets = keychainWith(WORKSPACES);
    for (const enabled of [undefined, false]) {
      expect(await resolveLinearWriteArming({ enabled, secrets, workspaceIds: WORKSPACES })).toEqual({ armed: false, reason: "switch_off" });
    }
    expect(secrets.getSecret).not.toHaveBeenCalled();
  });

  it("is NOT ARMED when on but there is no credential source", async () => {
    expect(await resolveLinearWriteArming({ enabled: true, secrets: undefined, workspaceIds: WORKSPACES })).toEqual({
      armed: false,
      reason: "no_secrets_gate",
    });
  });

  it("⛔ is NOT ARMED when on with a credential source but NO workspace's Linear key resolves — construction is not resolution", async () => {
    const empty = keychainWith([]);
    expect(await resolveLinearWriteArming({ enabled: true, secrets: empty, workspaceIds: WORKSPACES })).toEqual({
      armed: false,
      reason: "no_credential_resolved",
    });
    expect(empty.getSecret).toHaveBeenCalledTimes(WORKSPACES.length); // it LOOKED, per workspace

    const locked: WriteSecretsAccessor = { getSecret: async () => err({ reason: "locked" as const }) };
    const throwing: WriteSecretsAccessor = { getSecret: async () => { throw new Error("boom"); } };
    const blank: WriteSecretsAccessor = { getSecret: async () => ok("   ") };
    for (const secrets of [locked, throwing, blank]) {
      expect(await resolveLinearWriteArming({ enabled: true, secrets, workspaceIds: WORKSPACES })).toEqual({
        armed: false,
        reason: "no_credential_resolved",
      });
    }
  });

  it("⛔ another vendor's key for the workspace does not arm Linear", async () => {
    const todoistOnly: WriteSecretsAccessor = {
      getSecret: async (ref) => (ref === "keychain://connector-write.employer-work/todoist" ? ok(KEY) : err({ reason: "missing" as const })),
    };
    const out = await resolveLinearWriteArming({ enabled: true, secrets: todoistOnly, workspaceIds: WORKSPACES });
    expect(out).toEqual({ armed: false, reason: "no_credential_resolved" });
  });

  it("is ARMED when one workspace's key resolves, and names only the workspaces that have a key", async () => {
    const out = await resolveLinearWriteArming({ enabled: true, secrets: keychainWith(["employer-work"]), workspaceIds: WORKSPACES });
    expect(out.armed).toBe(true);
    if (!out.armed) return;
    expect(out.workspaces).toEqual(["employer-work"]);
    expect(out.gate.enabled).toBe(true);
    expect(out.gate.targets).toEqual(["linear"]); // only Linear is real: every other system's writes wait
    expect(out.gate.workspaces).toEqual(["employer-work"]); // only where a key resolved: other workspaces wait
    expect(typeof out.gate.make).toBe("function");
  });

  it("⛔ rule 7: neither the outcome nor its description carries the key", async () => {
    const armed = await resolveLinearWriteArming({ enabled: true, secrets: keychainWith(["employer-work"]), workspaceIds: WORKSPACES });
    const notArmed = await resolveLinearWriteArming({ enabled: true, secrets: keychainWith([]), workspaceIds: WORKSPACES });
    for (const o of [armed, notArmed]) {
      expect(JSON.stringify(o)).not.toContain(KEY);
      expect(describeLinearWriteArming(o)).not.toContain(KEY);
    }
    expect(describeLinearWriteArming(armed)).toContain("employer-work");
    expect(describeLinearWriteArming(notArmed)).toContain("NOT ARMED");
  });

  it("builds no sender until used — resolving reads the key but sends nothing", async () => {
    const http: HttpTransport = { send: vi.fn(async () => ({ status: 200, body: "{}" })) };
    const out = await resolveLinearWriteArming({ enabled: true, secrets: keychainWith(["employer-work"]), workspaceIds: WORKSPACES, http });
    expect(out.armed).toBe(true);
    expect(http.send).not.toHaveBeenCalled();
  });

  it("once selected, sends Linear writes to api.linear.app with the RAW key, and refuses every other service", async () => {
    const calls: HttpTransportRequest[] = [];
    const http: HttpTransport = {
      async send(r) {
        calls.push(r);
        return { status: 200, body: JSON.stringify({ data: { issues: { nodes: [] } } }) };
      },
    };
    const out = await resolveLinearWriteArming({ enabled: true, secrets: keychainWith(["employer-work"]), workspaceIds: WORKSPACES, http });
    const transport = selectAdapterTransport(out.armed ? out.gate : undefined);
    const linear = await transport(req("linear"));
    expect(linear).toEqual({ ok: true, object: null }); // a clean MISS from the filter probe
    expect(calls[0]?.url).toBe("https://api.linear.app/graphql");
    expect(calls[0]?.headers["Authorization"]).toBe(KEY); // raw, no Bearer
    const todoist = await transport(req("todoist"));
    expect(!todoist.ok && todoist.faultDetail).toBe("target_not_armed");
    expect(calls).toHaveLength(1); // the refused service never reached the network
  });
});

// Linear slice 5a (owner decision 2026-09-25): the form's team list is read from Linear ONLY when Linear writes are on
// for that workspace. The reader is built INSIDE the armed branch, so an unarmed switch has nothing that could call.
describe("the armed gate's team lister (Linear slice 5a)", () => {
  const TEAMS = { data: { teams: { nodes: [{ id: "t-1", name: "Core" }], pageInfo: { hasNextPage: false } } } };
  function recordingHttp(): HttpTransport & { calls: HttpTransportRequest[] } {
    const calls: HttpTransportRequest[] = [];
    return { calls, async send(r) { calls.push(r); return { status: 200, body: JSON.stringify(TEAMS) }; } };
  }

  it("an armed gate carries a lister that reads THIS workspace's teams over the same key", async () => {
    const h = recordingHttp();
    const out = await resolveLinearWriteArming({ enabled: true, secrets: keychainWith(["employer-work"]), workspaceIds: WORKSPACES, http: h });
    expect(out.armed).toBe(true);
    if (!out.armed) return;
    expect(h.calls).toHaveLength(0); // arming reads keys, sends nothing
    const teams = await out.gate.listLinearTeams?.("employer-work");
    expect(teams).toEqual({ ok: true, teams: [{ id: "t-1", name: "Core" }], hasMore: false });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.headers["Authorization"]).toBe(KEY);
  });

  it("⛔ a workspace whose key did not resolve at boot is refused WITHOUT a network call or a key read", async () => {
    const h = recordingHttp();
    const secrets = keychainWith(["employer-work"]);
    const out = await resolveLinearWriteArming({ enabled: true, secrets, workspaceIds: WORKSPACES, http: h });
    if (!out.armed) throw new Error("expected armed");
    const readsAfterArming = secrets.getSecret.mock.calls.length;
    expect(await out.gate.listLinearTeams?.("personal-life")).toEqual({ ok: false, reason: "not_armed_for_workspace" });
    expect(h.calls).toHaveLength(0);
    expect(secrets.getSecret.mock.calls.length).toBe(readsAfterArming);
  });

  it("⛔ the switch off, or no key anywhere, builds NO gate — so there is no lister to call", async () => {
    for (const deps of [
      { enabled: false, secrets: keychainWith(WORKSPACES), workspaceIds: WORKSPACES },
      { enabled: true, secrets: keychainWith([]), workspaceIds: WORKSPACES },
    ]) {
      const out = await resolveLinearWriteArming(deps);
      expect(out.armed).toBe(false);
      expect("gate" in out).toBe(false);
    }
  });
});

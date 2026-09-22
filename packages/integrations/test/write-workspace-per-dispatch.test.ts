// ⛔⛔ SAFETY RULE 4 — the dispatch's workspace must reach the HTTP request, PER DISPATCH.
//
// THE GAP (found 2026-09-21 by a grounding review, verified 19/21 by an independent verifier):
// `DispatchOptions.workspaceId` was read ONLY by the gateway's credential pre-check. The gateway then
// called `adapter.existenceCheck / create / update` with NO workspace, the adapter stamped
// `AdapterTransportRequest.workspaceId` only from `AdapterDeps.workspaceId`, and the production
// registry is built ONCE at boot with `{ transport, clock }` — no workspace. So once a real
// `createWriteHttpTransport` was armed, EVERY real write would have been refused at the first vendor
// call with `workspace_unscoped`, while the gateway pre-check had already passed. It failed closed
// (nothing leaked), but it could never have worked.
//
// ⭐ WHY NOTHING CAUGHT IT: every end-to-end transport test bound `workspaceId` straight into
// `AdapterDeps` — the one arrangement production never uses. And two doc comments claimed the
// opposite of the code ("an adapter is already built per routed dispatch"; "threaded from
// DispatchOptions.workspaceId"). Both were written 2026-09-03, both false.
//
// THIS SUITE uses the PRODUCTION arrangement: the boot-style shared registry built with NO workspace,
// a REAL `createWriteHttpTransport`, and the workspace supplied ONLY per dispatch.
import { describe, it, expect } from "vitest";
import { ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import {
  createWriteHttpTransport,
  type WriteHttpSpec,
  type HttpTransport,
  type HttpTransportRequest,
} from "../src/tools/adapters/write-http-transport";
import { writeSecretRef, type WriteSecretsAccessor, type WriteSecretUnavailable } from "../src/tools/adapters/adapter-core";
import { buildWriteAdapterRegistry, dispatchRouted, createUnroutedWriteAdapter } from "../src/tools/write-adapter-registry";
import type { ExternalWriteDeps } from "../src/tools/gateway";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import { InMemoryReceiptStore, makeProposedAction } from "./support/fakes";

const CLOCK = (): string => "2026-09-21T00:00:00.000Z";

// A vendor-neutral spec: POST one path; a query is always a MISS so the pipeline proceeds to create.
const SPEC: WriteHttpSpec = {
  baseUrl: "https://api.vendor.test",
  allowedHosts: ["api.vendor.test"],
  buildRequest: () => ({ method: "POST", path: "/write", body: "{}" }),
  mapResponse: (_status, json, req) => {
    if (req.op === "query") return { ok: true, object: null };
    const id = (json as { id?: unknown })?.id;
    return typeof id === "string" ? { ok: true, object: { externalObjectId: id } } : { ok: false, fault: "unknown", detail: "no id" };
  },
};

function harness() {
  const calls: HttpTransportRequest[] = [];
  const http: HttpTransport = {
    async send(req) {
      calls.push(req);
      return { status: 200, body: JSON.stringify({ id: "vendor-obj-1" }) };
    },
  };
  const refs: string[] = [];
  const secrets: WriteSecretsAccessor = {
    async getSecret(ref): Promise<Result<string, WriteSecretUnavailable>> {
      refs.push(ref);
      return ok("faketoken");
    },
  };
  // ⭐ THE PRODUCTION ARRANGEMENT: one shared registry, built with NO workspace (backends.ts builds
  // exactly `{ transport, clock }`).
  const registry = buildWriteAdapterRegistry({ transport: createWriteHttpTransport(SPEC, { http, secrets }), clock: CLOCK });
  const deps: ExternalWriteDeps = {
    adapter: createUnroutedWriteAdapter(), // placeholder — dispatchRouted overrides it
    receiptStore: new InMemoryReceiptStore(),
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => false,
    audit: async () => {},
    clock: CLOCK,
    secrets, // the gateway pre-check is armed too, as it is once writes are on
  };
  return { calls, refs, registry, deps };
}

function linearWrite(idem: string) {
  const action = makeProposedAction({ targetSystem: "linear", idempotencyKey: idem, canonicalObjectKey: `cok_${idem}` });
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) throw new Error("envelope failed to build");
  return { action, env: built.value };
}

describe("the dispatch's workspace reaches the HTTP request — per dispatch, not per boot", () => {
  it("⛔ THE GAP: a boot-built registry + a real transport + the workspace ONLY in DispatchOptions WRITES", async () => {
    const h = harness();
    const { action, env } = linearWrite("idem_1");
    const res = await dispatchRouted(h.registry, env, action, h.deps, undefined, { workspaceId: "employer-work" });
    expect(res.status).toBe("created");
    // The request actually went out (probe + create), which the old code could never reach.
    expect(h.calls.length).toBeGreaterThanOrEqual(1);
    // And EVERY credential lookup — gateway pre-check AND transport — used the dispatch's workspace.
    expect(h.refs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(h.refs)).toEqual(new Set([writeSecretRef("linear", "employer-work")]));
  });

  it("⛔ two dispatches through the SAME shared adapter use TWO different credentials", async () => {
    // The property a construction-time binding could never give: the adapter is shared, so the
    // workspace MUST ride with each call.
    const h = harness();
    const a = linearWrite("idem_a");
    const b = linearWrite("idem_b");
    const first = await dispatchRouted(h.registry, a.env, a.action, h.deps, undefined, { workspaceId: "employer-work" });
    const afterFirst = h.refs.length;
    const second = await dispatchRouted(h.registry, b.env, b.action, h.deps, undefined, { workspaceId: "personal-life" });
    // ⚠ Both must actually WRITE. Without this the test passes on the broken code: the gateway
    // pre-check alone already used the right workspace per dispatch, and the transport — the half
    // that was broken — never got far enough to look anything up.
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    // Pre-check + transport = at least two lookups per dispatch, all in that dispatch's workspace.
    expect(afterFirst).toBeGreaterThanOrEqual(2);
    expect(h.refs.length - afterFirst).toBeGreaterThanOrEqual(2);
    expect(new Set(h.refs.slice(0, afterFirst))).toEqual(new Set([writeSecretRef("linear", "employer-work")]));
    expect(new Set(h.refs.slice(afterFirst))).toEqual(new Set([writeSecretRef("linear", "personal-life")]));
  });

  it("a dispatch that names NO workspace sends NOTHING — fail closed, not an unscoped credential", async () => {
    const h = harness();
    const { action, env } = linearWrite("idem_none");
    const res = await dispatchRouted(h.registry, env, action, h.deps);
    expect(res.status).toBe("rejected");
    expect(h.calls).toHaveLength(0);
    // No lookup ever used an unscoped or foreign ref.
    expect(h.refs.every((r) => r.includes("connector-write."))).toBe(true);
  });
});

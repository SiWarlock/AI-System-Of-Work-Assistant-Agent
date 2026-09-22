// A per-service router for the ONE shared write transport. Linear slice 2 of 6.
//
// ⛔ WHY IT IS NEEDED (grounding review 2026-09-21, verified): the worker builds all seven write
// adapters over ONE `AdapterTransport` (`buildWriteAdapterRegistry({ transport, ... })`). Arming that
// with a Linear-only sender would have sent Todoist, Calendar, Drive, GitHub, Asana and Telegram writes
// through the Linear spec — and, since the credential is still looked up per target, could have put
// another service's token in an Authorization header bound for api.linear.app (rule 7).
//
// ⭐ AN UNROUTED SERVICE FAILS CLOSED, not through to the stub. The stub fabricates success receipts
// (`stub-obj:<target>:<key>`); once real writes are armed, a fake "created" for a Todoist task that was
// never created is worse than an honest refusal. The refusal names itself (`target_not_armed`) so the
// operator sees why, instead of a generic "request rejected".
import { describe, it, expect, vi } from "vitest";
import type { AdapterTransport, AdapterTransportRequest } from "../src/tools/adapters/transport";
import { createRoutedAdapterTransport } from "../src/tools/adapters/routed-transport";

function req(targetSystem: AdapterTransportRequest["targetSystem"]): AdapterTransportRequest {
  return { op: "create", targetSystem, canonicalObjectKey: "cok", idempotencyKey: "idem", identity: {}, workspaceId: "employer-work" };
}

describe("createRoutedAdapterTransport", () => {
  it("sends a routed service's write to ITS transport, unchanged", async () => {
    const linear = vi.fn<AdapterTransport>(async () => ({ ok: true, object: { externalObjectId: "L1" } }));
    const routed = createRoutedAdapterTransport({ linear });
    const r = req("linear");
    expect(await routed(r)).toEqual({ ok: true, object: { externalObjectId: "L1" } });
    expect(linear).toHaveBeenCalledWith(r);
  });

  it("⛔ an UNROUTED service fails closed with a named reason — and no other transport is called", async () => {
    const linear = vi.fn<AdapterTransport>(async () => ({ ok: true, object: { externalObjectId: "L1" } }));
    const routed = createRoutedAdapterTransport({ linear });
    for (const t of ["todoist", "calendar", "drive", "github", "asana", "telegram"] as const) {
      const res = await routed(req(t));
      expect(res.ok, t).toBe(false);
      if (!res.ok) {
        expect(res.fault).toBe("rejected");
        expect(res.faultDetail).toBe("target_not_armed");
      }
    }
    // The Linear transport never saw another service's request, so it could never attach its own
    // credential to one — or have another service's credential attached to a Linear-bound request.
    expect(linear).not.toHaveBeenCalled();
  });

  it("an empty route table refuses everything — arming with nothing routed writes nothing", async () => {
    const res = await createRoutedAdapterTransport({})(req("linear"));
    expect(!res.ok && res.faultDetail).toBe("target_not_armed");
  });
});

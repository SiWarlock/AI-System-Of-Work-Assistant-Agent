// @sow/integrations — route each service's writes to ITS real transport; refuse the rest.
// Linear slice 2 of 6.
//
// ⛔ WHY: the worker builds all seven write adapters over ONE shared `AdapterTransport`
// (`buildWriteAdapterRegistry({ transport, ... })`). Arming that with a single vendor's sender would
// have sent every other service's writes through it — and since the credential is looked up per
// target, another service's token could have ridden in an Authorization header bound for the wrong
// host (rule 7).
//
// ⭐ AN UNROUTED SERVICE FAILS CLOSED rather than falling through to the stub. The stub fabricates
// success receipts; once real writes are armed, a fake "created" for something never created is worse
// than an honest refusal. The refusal carries `target_not_armed` so the operator sees why.
import type { TargetSystem } from "@sow/contracts";
import type { AdapterTransport, AdapterTransportRequest, TransportResponse } from "./transport";

export function createRoutedAdapterTransport(
  routes: Readonly<Partial<Record<TargetSystem, AdapterTransport>>>,
): AdapterTransport {
  return async (req: AdapterTransportRequest): Promise<TransportResponse> => {
    const transport = routes[req.targetSystem];
    if (transport === undefined) {
      return { ok: false, fault: "rejected", detail: "no real transport is armed for this target", faultDetail: "target_not_armed" };
    }
    return transport(req);
  };
}

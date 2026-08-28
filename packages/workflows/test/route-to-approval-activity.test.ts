// spec(safety rule 7 / task I2, R3 24.73 restore round) — the routeToApproval
// ACTIVITY (src/activities/routeToApproval.ts, registered
// `crossCalendarRouteToApproval`).
//
// This activity dispatches through an injected {@link PendingApprovalGateway}.
// A prior round added a redaction here (`redactRouteToApprovalError`) that
// forwarded neither the gateway's `cause` nor its `message`. R3 deleted it: the
// REAL bound gateway (buildActivities.ts's `crossCalendarRouteToApproval.gateway`)
// already builds its message from a closed `DbErrorCode` alone
// (`pending approval record failed: ${code}`) and never attaches `cause` — so the
// redaction guarded a field that was already safe, for zero incremental safety,
// while costing the operator the real diagnostic. These tests pin BOTH the
// functional fold (the closed `code` crosses; the OK arm passes the gateway's
// result straight through) and the restore (the gateway's own `message` now
// crosses verbatim).
import { describe, it, expect } from "vitest";
import { err, ok, isOk } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { createRouteToApprovalActivity } from "../src/activities/routeToApproval";
import type { PendingApprovalGateway } from "../src/activities/routeToApproval";
import type { RouteToApprovalError } from "../src/ports/crossCalendarScheduling";
import { makeProposedAction, makeEnvelope } from "./support/approval-fakes";

describe("createRouteToApprovalActivity — folds the gateway result; never dispatches the write itself", () => {
  it("a fresh reservation is ok, carrying the gateway's approvalRef/created VERBATIM", async () => {
    const gateway: PendingApprovalGateway = {
      reservePending() {
        return Promise.resolve(ok({ approvalRef: "apr-1", created: true }));
      },
    };
    const port = createRouteToApprovalActivity({ gateway });
    const res = await port.route(makeProposedAction(), makeEnvelope());
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value).toEqual({ approvalRef: "apr-1", created: true });
  });

  it("folds a gateway precondition failure to precondition_failed", async () => {
    const gateway: PendingApprovalGateway = {
      reservePending() {
        return Promise.resolve(err({ code: "precondition_failed", message: "stale" }));
      },
    };
    const port = createRouteToApprovalActivity({ gateway });
    const res = await port.route(makeProposedAction(), makeEnvelope());
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("precondition_failed");
  });

  it("R3 (24.73 restore round): forwards a gateway failure's real message verbatim — NOT redacted", async () => {
    const gateway: PendingApprovalGateway = {
      reservePending(): Promise<
        Result<{ approvalRef: string; created: boolean }, RouteToApprovalError>
      > {
        return Promise.resolve(
          err({ code: "route_failed", message: "pending approval record failed: conflict" }),
        );
      },
    };
    const port = createRouteToApprovalActivity({ gateway });
    const res = await port.route(makeProposedAction(), makeEnvelope());
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.error.code).toBe("route_failed");
    // RESTORED: the gateway's own message crosses verbatim (this is the EXACT
    // shape the real bound gateway builds — buildActivities.ts:
    // `pending approval record failed: ${created.error.code}`) — a mutation-proof
    // pin (a re-added redaction would replace this with a different fixed literal,
    // failing this assertion).
    expect(res.error.message).toBe("pending approval record failed: conflict");
  });
});

// spec(16.4, REQ-I-005) — task 24.24 HOP 1: the connectorPoll activity must carry a
// coverage-degrade GatewayHealthSignal through on an ADVANCED pass, not just on a
// held/degraded pass.
//
// Context (HOP 0, correct, packages/integrations territory, read-only reference):
// the §8 Connector Gateway (packages/integrations/src/connectors/gateway.ts) sets
// `coverageIncomplete = true` when a COMMITTED page reported `incompleteCoverage`,
// and its terminal 'advanced' return CAN carry a `healthSignal` (built via
// `buildConnectorCoverageDegradeSignal`) alongside `status: "advanced"`. Fail-VISIBLE:
// the records already committed; the gateway announces the partiality, it does NOT
// drop or hold.
//
// This file pins that `projectSyncResult` (packages/workflows territory) preserves
// that signal instead of discarding it on the 'advanced' early-return branch.
import { describe, it, expect } from "vitest";
import { projectSyncResult } from "../src/activities/connectorPoll";

describe("spec(REQ-I-005) connectorPoll activity — projects the ACTUAL gateway ConnectorSyncResult", () => {
  it("projectSyncResult carries a coverage-degrade healthReason on an ADVANCED pass (16.4 fail-VISIBLE)", () => {
    // Shape copied from the gateway's own builder (packages/integrations/src/health/
    // health-signal.ts:122-134, buildConnectorCoverageDegradeSignal) — the coverage
    // class, not the unreachable class, and a redaction-safe message.
    const result = projectSyncResult("drive-corp", {
      status: "advanced",
      cursor: "c2",
      processed: 7,
      health: "reachable",
      healthSignal: {
        failureClass: "sync_lagging",
        subjectRef: "drive-corp",
        severity: "warn",
        message: "connector drive-corp coverage degraded: connector reported partial corpus coverage (incompleteSearch)",
        refs: ["ws-1"],
      },
    });

    // The cursor DID advance and the pass IS advanced — partial coverage does not
    // retract either. Only the presence of the reason changes.
    expect(result.status).toBe("advanced");
    expect(result.cursorAdvanced).toBe(true);
    // M2 + 16.4 restore: `sync_lagging` on a ConnectorSyncResult has exactly ONE
    // producer (buildConnectorCoverageDegradeSignal) whose reason is a hardcoded
    // SoW literal, never adapter/vendor text — so projectSyncResult mirrors that
    // literal here instead of collapsing to the bare failure-class alias, which
    // would defeat the whole point of a fail-VISIBLE coverage signal.
    expect(result.healthReason).toBe(
      "connector drive-corp coverage degraded: connector reported partial corpus coverage (incompleteSearch)",
    );
  });

  // R2 restore, mutation-kill: a `sync_lagging` (16.4 coverage-degrade, fail-VISIBLE,
  // SoW-authored reason) healthReason must NOT collapse into the same shape as a
  // generic `connector_unreachable` healthReason for the same connector/status — a
  // mutant that special-cases nothing (or drops the special case) would make both
  // render as "connector drive-corp advanced: <class>", losing the actual reason.
  it("the 16.4 coverage-degrade reason renders DIFFERENTLY from a generic failureClass-only reason", () => {
    const coverage = projectSyncResult("drive-corp", {
      status: "advanced",
      cursor: "c2",
      processed: 7,
      health: "reachable",
      healthSignal: {
        failureClass: "sync_lagging",
        subjectRef: "drive-corp",
        severity: "warn",
        message: "connector drive-corp coverage degraded: connector reported partial corpus coverage (incompleteSearch)",
        refs: ["ws-1"],
      },
    });
    const generic = projectSyncResult("drive-corp", {
      status: "advanced",
      cursor: "c2",
      processed: 7,
      health: "reachable",
      healthSignal: {
        failureClass: "connector_unreachable",
        subjectRef: "drive-corp",
        severity: "warn",
        message: "connector drive-corp unreachable: some vendor detail",
        refs: ["ws-1"],
      },
    });

    expect(coverage.healthReason).not.toBe(generic.healthReason);
    expect(coverage.healthReason).toContain("connector reported partial corpus coverage (incompleteSearch)");
    expect(generic.healthReason).toBe("connector drive-corp advanced: connector_unreachable");
  });
});

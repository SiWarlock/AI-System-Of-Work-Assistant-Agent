// spec(25.2 PKG-W3, R2 restore) — refreshConnectors activity: the failing
// connector's id must be nameable in the redacted failure message.
//
// The redacted message deliberately never forwards the refresher's raw
// `.message`/`.cause` (SAFETY RULE 7 — see `redactConnectorRefreshError`'s own doc
// comment in src/activities/refreshConnectors.ts: the refresher wraps the Connector
// Gateway, out of this package's territory, so neither can be proven free of
// provider/auth/URL detail). But with several connectors configured, a fixed
// generic message naming only the failure class leaves the operator unable to tell
// WHICH connector needs attention. This file pins that the connector id (a
// caller-supplied, workspace-configured identifier this activity already iterates
// over — never adapter content) DOES cross, while the raw vendor detail still does
// not.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { createRefreshConnectorsActivity } from "../src/activities/refreshConnectors";
import type {
  ConnectorRefresher,
  ConnectorRefreshError,
} from "../src/activities/refreshConnectors";

function makeRefresher(failing: Record<string, ConnectorRefreshError>): ConnectorRefresher {
  return {
    refresh(connectorId: string): Promise<Result<void, ConnectorRefreshError>> {
      const failure = failing[connectorId];
      return Promise.resolve(failure !== undefined ? err(failure) : ok(undefined));
    },
  };
}

describe("createRefreshConnectorsActivity — R2 restore: WHICH connector failed must be nameable", () => {
  it("names the failing connector's id in the message — not just the failure class", async () => {
    const activity = createRefreshConnectorsActivity({
      connectorIds: ["gcal-primary", "drive-corp"],
      refresher: makeRefresher({
        "drive-corp": {
          code: "connector_unreachable",
          message: "token expired (401), re-auth required",
          cause: { url: "https://vendor.example/oauth?token=SECRET" },
        },
      }),
    });

    const res = await activity.refresh({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("connector_unreachable");
    expect(res.error.message).toContain("drive-corp");
    // rule 7 stays intact: the raw vendor message/cause never crosses.
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("re-auth required");
  });

  it("two different connectors failing the SAME way render DIFFERENT messages naming each one", async () => {
    const first = createRefreshConnectorsActivity({
      connectorIds: ["gcal-primary"],
      refresher: makeRefresher({
        "gcal-primary": { code: "connector_stale", message: "cursor behind" },
      }),
    });
    const second = createRefreshConnectorsActivity({
      connectorIds: ["drive-corp"],
      refresher: makeRefresher({
        "drive-corp": { code: "connector_stale", message: "cursor behind" },
      }),
    });

    const resFirst = await first.refresh({});
    const resSecond = await second.refresh({});
    expect(resFirst.ok).toBe(false);
    expect(resSecond.ok).toBe(false);
    if (resFirst.ok || resSecond.ok) return;
    // Mutation-kill: a mutant that drops the id parameter renders both connectors'
    // failures as the SAME fixed string — this must go RED on that mutant.
    expect(resFirst.error.message).not.toBe(resSecond.error.message);
    expect(resFirst.error.message).toContain("gcal-primary");
    expect(resSecond.error.message).toContain("drive-corp");
  });

  it("fail-fast: a refresh over several connectors stops at the FIRST failing one", async () => {
    let secondCalled = false;
    const activity = createRefreshConnectorsActivity({
      connectorIds: ["a", "b"],
      refresher: {
        refresh(connectorId: string): Promise<Result<void, ConnectorRefreshError>> {
          if (connectorId === "a") {
            return Promise.resolve(err({ code: "connector_unreachable", message: "down" }));
          }
          secondCalled = true;
          return Promise.resolve(ok(undefined));
        },
      },
    });
    const res = await activity.refresh({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.message).toContain("a");
    expect(secondCalled).toBe(false);
  });
});

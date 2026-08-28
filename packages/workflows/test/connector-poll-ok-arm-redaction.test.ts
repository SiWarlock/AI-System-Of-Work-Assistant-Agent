// spec(M2, safety rule 7) — connectorPoll's OK arm must never leak adapter-authored
// text through `healthReason`.
//
// Four earlier rounds closed the `cause` channel on this activity's caught-throw
// (err) arm (see the header comment on createConnectorPollActivity). This file pins
// the DIFFERENT channel a final audit found open: the `message`/`reason` channel on
// the activity's SUCCESS (ok) arm. `poll.poll()` returns `ok(...)` for EVERY §8
// gateway verdict, including 'degraded' (a real connector fetch failure the gateway
// classified rather than a poll-activity crash) — so a poisoned vendor error message
// can ride the happy path straight into `ConnectorPollResult.healthReason`, which
// this REGISTERED activity's return makes durable, replayed Temporal workflow
// history (SAFETY RULE 7).
//
// Demonstrated END-TO-END through the REGISTERED activity (createConnectorPollActivity)
// driving the REAL @sow/integrations gateway (runConnectorSync → classifyConnectorError
// → buildConnectorHealthSignal → redactString), not a hand-rolled ConnectorSyncResult —
// this proves the whole chain, including that `redactString` (credential-SHAPE
// scrubbing only) is not what makes this safe; `projectSyncResult` never reading
// `healthSignal.message` at all is what makes it safe.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import { createConnectorPollActivity } from "../src/activities/connectorPoll";
import type { ConnectorPort, ConnectorSyncDeps } from "@sow/integrations";

const NOW = "2026-08-27T00:00:00.000Z";

// The two poison payloads named in the ticket: a vault filesystem path (a shape
// `redactString` does not recognize at all) and a URL carrying a bare token value
// (a shape `redactString`'s URL-credential-param pattern happens to catch — but the
// fix below does not rely on that: it never reads `.message` in the first place).
const POISON_PATH = "/Users/x/vault/PZN9F3A1BSECRET-leak.md";
const POISON_URL = "https://api.vendor.com?token=PZN9F3A1BSECRET-leak";
const POISON_TOKEN = "PZN9F3A1BSECRET-leak";

function fakeCursors(): ConnectorSyncDeps["cursors"] {
  return {
    get: () => Promise.resolve(err({ code: "not_found" as const, message: "nf" })),
    upsert: (r: unknown) => Promise.resolve(ok(r)),
    listByConnector: () => Promise.resolve(ok([])),
  } as unknown as ConnectorSyncDeps["cursors"];
}

describe("spec(M2) connectorPoll OK arm — never leaks adapter-authored text", () => {
  it("a poisoned vendor error message never reaches the registered activity's returned result", async () => {
    const port: ConnectorPort = {
      connectorId: "drive-corp",
      // 'malformed' is NON-transient — the gateway degrades on the first fetch (no
      // retry loop), still returning `poll.poll()` OK (never throws): this IS the
      // OK arm, carrying a real classified fetch failure via `healthSignal`.
      fetch: () =>
        Promise.resolve(
          err({
            code: "malformed" as const,
            message: `unexpected response body: ${POISON_PATH} ; retry via ${POISON_URL}`,
          }),
        ),
    };
    const syncDeps: ConnectorSyncDeps = {
      cursors: fakeCursors(),
      workspaceId: "ws-1",
      onRecords: () => Promise.resolve(ok(undefined)),
      backoffCfg: { baseMs: 1, maxMs: 4, maxAttempts: 1 },
      clock: () => NOW,
    };
    const activity = createConnectorPollActivity({ resolve: () => ({ port, syncDeps }) });

    const out = await activity.poll({ connectorId: "drive-corp", workspaceId: "ws-1" });

    // This IS the OK arm: the activity did not throw/err — the connector READ
    // failed and the gateway classified it, but the activity Result is a success.
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Mutation-killer: pin that a signal actually rode along first, so a mutant
    // that silently drops `healthReason` altogether cannot make the negative
    // assertions below pass vacuously.
    expect(out.value.healthReason).toBeDefined();
    expect(out.value.status).toBe("degraded");

    // The whole activity RESULT — exactly what becomes durable Temporal workflow
    // history — must not contain the poisoned path, URL, or bare token substring.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(POISON_PATH);
    expect(serialized).not.toContain(POISON_URL);
    expect(serialized).not.toContain(POISON_TOKEN);

    // Still diagnostically useful: names the reachability status + the CLOSED
    // FailureClass taxonomy + the workspace-configured connectorId — an operator
    // can act on this without any vendor text ever crossing the boundary.
    //
    // C2 restore: the trailing clause is the SoW-authored phrase for the CLOSED
    // `ConnectorError.code` ('malformed'), so a malformed payload no longer renders
    // identically to a 429 or an outage. The code crosses; the error's `message`
    // (which carried every poison string above) does not — that is the whole
    // distinction, and the negative assertions above prove it held end-to-end
    // through the REAL gateway.
    expect(out.value.healthReason).toBe(
      "connector drive-corp degraded: connector_unreachable — the connector reported a malformed vendor response (malformed — the adapter's shape check rejected the payload)",
    );
    // The MACHINE discriminator (an enum, never parsed from the string above).
    expect(out.value.cause).toBe("malformed_response");
  });
});

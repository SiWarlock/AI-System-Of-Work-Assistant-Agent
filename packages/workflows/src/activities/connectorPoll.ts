// @sow/workflows — slice 7.15 ACTIVITY: poll ONE connector through the §8 Connector
// Gateway (`runConnectorSync`) and project its outcome onto the driver-facing
// {@link ConnectorPollResult}.
//
// This is an ACTIVITY, NOT workflow code — it runs worker-side and MAY bind real
// adapters (the concrete ConnectorPort + the P2 ConnectorCursorRepository + a wall
// clock). It implements {@link ConnectorPollPort}. The pure driver
// (src/workflows/connectorSyncHealth.ts) NEVER imports the gateway or a real
// transport; it only RECEIVES the typed poll result from this seam. Tested with
// injected fakes (no real transport).
//
// THE LOAD-BEARING PIN (REQ-I-005 / the bug-class prior verify passes caught): the
// {@link ConnectorPollResult} this activity returns is projected DIRECTLY from the
// ACTUAL `ConnectorSyncResult` the gateway produced — `status`, `cursor`, `processed`
// come straight from the gateway's verdict, and `cursorAdvanced` is derived from the
// gateway `status === 'advanced'` (the ONLY status on which the gateway advanced +
// persisted the cursor). So the driver's degraded/queue branch reads the real
// reachability outcome that actually flowed through the cursor advance — never a decoy
// descriptor field. The activity NEVER fabricates an `advanced` on a held/degraded
// pass, and NEVER advances a cursor the gateway did not advance.
//
// §16: returns a typed Result — never throws. A gateway crash (the async call
// rejecting) is caught and folded to a typed {@link ConnectorPollError}.
import { ok, err, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { runConnectorSync } from "@sow/integrations";
import type {
  ConnectorError,
  ConnectorPort,
  ConnectorSyncDeps,
  ConnectorSyncResult,
} from "@sow/integrations";
import type {
  ConnectorPollCause,
  ConnectorPollPort,
  ConnectorPollResult,
  ConnectorPollError,
  ConnectorTarget,
} from "../workflows/connectorSyncHealth";
import { dropCause } from "./redaction";

/**
 * Resolve the concrete {@link ConnectorPort} + the per-pass {@link ConnectorSyncDeps}
 * for a given target. Injected so the activity binds the real connector adapter +
 * cursor repo + consumer (`onRecords`) + backoff at the worker edge, while tests pass
 * fakes. `port` is the transport seam; `syncDeps` carries `cursors`/`onRecords`/
 * `backoffCfg`/`clock` — everything `runConnectorSync` needs. `workspaceId` on the
 * `syncDeps` MUST equal the target's workspaceId (WS-2 — the sync is workspace-scoped).
 */
export interface ConnectorPollActivityDeps {
  readonly resolve: (
    connector: ConnectorTarget,
  ) => { readonly port: ConnectorPort; readonly syncDeps: ConnectorSyncDeps };
}

const COVERAGE_DEGRADE_REASON = "connector reported partial corpus coverage (incompleteSearch)";

/**
 * SoW-AUTHORED operator phrase per {@link ConnectorPollCause}. Every string here is a
 * literal written in this file — no adapter/vendor text, no interpolated error body,
 * nothing derived from a fetched payload. Each names the remedy that distinguishes it
 * from its siblings, because the frozen `FailureClass` cannot: an operator seeing
 * `connector_unreachable` alone cannot tell "unlock the Keychain" from "wait out a
 * 429" from "file an adapter bug".
 *
 * The parenthesised code in each phrase is the CLOSED `ConnectorError` code (or the
 * cause name) — printed as an anchor for the operator, never re-parsed by anything.
 */
const CAUSE_PHRASE: Readonly<Record<ConnectorPollCause, string>> = {
  consumer_rejected:
    "the downstream consumer rejected this page (consumer_rejected — the connector was reachable; cursor unchanged, the records are re-fetched next pass)",
  auth_locked:
    "connector credentials are locked or unavailable (auth_locked — unlock the Keychain or re-authorize the connector)",
  rate_limited:
    "the vendor rate-limited the read (rate_limited — back off and retry later)",
  transport_unreachable:
    "the connector could not reach the vendor (unreachable — check network and vendor availability)",
  malformed_response:
    "the connector reported a malformed vendor response (malformed — the adapter's shape check rejected the payload)",
  unknown_fetch_error:
    "the connector reported an unclassified fetch failure (unknown)",
  coverage_incomplete: COVERAGE_DEGRADE_REASON,
};

/**
 * Derive the CLOSED {@link ConnectorPollCause} behind a gateway verdict. PURE.
 *
 * Inputs, in priority order:
 *  1. `healthSignal.failureClass === 'sync_lagging'` — an ENUM comparison on a frozen
 *     `FailureClass` (not string parsing). Within a `ConnectorSyncResult` this class
 *     has exactly one producer: the gateway's `buildConnectorCoverageDegradeSignal`
 *     (packages/integrations/src/connectors/gateway.ts). ⇒ 16.4 coverage-degrade.
 *  2. `status === 'advanced'` with no coverage signal ⇒ no cause (nothing went wrong).
 *  3. `health === 'reachable'` on a non-advanced pass ⇒ the FETCH succeeded, so the
 *     pass was stopped downstream of the transport. Today the gateway's only
 *     `health: "reachable"` non-advanced return is its `onRecords`-rejected hold, so
 *     this reads `consumer_rejected`.
 *  4. Otherwise the transport failed, and `observedErrorCode` (the last
 *     `ConnectorError.code` the tapped port saw — see {@link createConnectorPollActivity})
 *     names which failure it was.
 *
 * ⛔ WHY THE OBSERVED CODE IS SOUND HERE, BY MECHANISM: it is consulted ONLY once the
 * gateway's own `health` verdict is NOT 'reachable'. The gateway reaches a
 * non-reachable verdict by calling `classifyConnectorError` on a fetch error and
 * RETURNING in that same loop iteration (its `auth_locked` hold and its degraded
 * return) — so on exactly those arms the last observed code is that error's code. On
 * a 'reachable' verdict the observed code is IGNORED, which is what stops a transient
 * that was retried and then SUCCEEDED from masquerading as the cause of a later
 * consumer-side hold. This is not a claim that the code is always the verdict's cause;
 * it is a claim about the two arms on which it is read. If a future gateway arm broke
 * that, the cost is a wrong operator HINT, never a wrong branch: no downstream branch
 * reads the CONTENT of `cause` or `healthReason` — the queue/retry decision reads
 * `status` (connectorSyncHealth.ts step 4), and the advanced-pass health surfacing
 * there gates on the mere PRESENCE of `healthReason`, never on what it says.
 *
 * The `switch` has NO default: `ConnectorError['code']` is a closed union, so adding a
 * member is a compile error HERE, forcing a deliberate phrase + remedy decision.
 */
export function causeForSyncResult(
  result: ConnectorSyncResult,
  observedErrorCode: ConnectorError["code"] | undefined,
): ConnectorPollCause | undefined {
  if (result.healthSignal?.failureClass === "sync_lagging") return "coverage_incomplete";
  if (result.status === "advanced") return undefined;
  if (result.health === "reachable") return "consumer_rejected";
  if (observedErrorCode === undefined) return undefined;
  switch (observedErrorCode) {
    case "auth_locked":
      return "auth_locked";
    case "rate_limited":
      return "rate_limited";
    case "unreachable":
      return "transport_unreachable";
    case "malformed":
      return "malformed_response";
    case "unknown":
      return "unknown_fetch_error";
  }
}

/**
 * Project the gateway's {@link ConnectorSyncResult} onto the driver-facing
 * {@link ConnectorPollResult}. PURE. `cursorAdvanced` is derived from
 * `status === 'advanced'` (REQ-I-005: the only status on which the gateway advanced +
 * persisted the cursor) — never fabricated. `cause` + `healthReason` are carried
 * whenever the pass held/degraded, and on an advanced pass with incomplete coverage
 * (16.4, fail-VISIBLE: the records already committed, the cursor DID advance, and the
 * partiality is announced rather than dropped or held).
 *
 * ⛔ WHY THE CAUSE IS HERE AT ALL — System Health is the operator's primary diagnostic
 * surface, and the frozen `FailureClass` collapses it: the driver stamps
 * `connector_unreachable` with the connectorId as `subjectRef` on an expired token, a
 * consumer-side write rejection, a 429, a transport outage and a malformed payload
 * alike. Rebuilding the reason from `failureClass` + `status` alone collapsed those
 * five remedies into TWO strings — the three degrade causes all rendered
 * "connector <id> degraded: connector_unreachable", and the two hold causes (which
 * carry no `healthSignal` at all) both rendered the bare "connector held".
 * {@link causeForSyncResult} restores the discriminator from closed-taxonomy inputs.
 * See {@link ConnectorPollCause} for the enum, and note that `cause` is the machine
 * field — `healthReason` is its human rendering and must never be parsed.
 *
 * M2 (this activity is REGISTERED — SAFETY RULE 7, its return is durable replayed
 * Temporal workflow history, on EVERY arm, not only the caught-throw arm below):
 * `healthReason` is built ONLY from CLOSED-TAXONOMY inputs + the SoW-authored literals
 * in {@link CAUSE_PHRASE} — the signal's `failureClass` (a frozen `FailureClass`
 * enum), the poll `status` (a closed union), the gateway's `health` verdict (a closed
 * union), the observed `ConnectorError.code` (a closed union declared in
 * packages/integrations/src/connectors/port.ts), and `connectorId` (the
 * workspace-configured identifier, not raw content, already embedded elsewhere in this
 * file). It NEVER reads `result.healthSignal.message`, and it never reads a
 * `ConnectorError.message`: those carry the ADAPTER'S raw error text (an unbounded
 * vendor error body, a filesystem path, a URL carrying a token), and `redactString`
 * scrubs credential SHAPES only — it does not touch filesystem paths or vendor error
 * bodies — so passing that text through is not a safe crossing even after redaction.
 * Reading the error's CODE while never reading its MESSAGE is the whole distinction.
 *
 * ONE NAMED EXCEPTION (16.4, `sync_lagging`): within a `ConnectorSyncResult` this
 * failureClass has exactly ONE producer — the Connector Gateway's
 * `buildConnectorCoverageDegradeSignal` (packages/integrations/src/connectors/
 * gateway.ts, `reason: "connector reported partial corpus coverage
 * (incompleteSearch)"` — a hardcoded SoW literal, never adapter/vendor text; the
 * OTHER healthSignal producer on this type, `buildConnectorHealthSignal`, only ever
 * emits `connector_unreachable`). So for `sync_lagging` alone this file mirrors that
 * known-safe literal instead of collapsing to the bare class name — otherwise a
 * fail-VISIBLE coverage-degrade signal (the records already committed; the whole
 * point is to announce the partiality) reads as indistinguishable from any other
 * `sync_lagging` occurrence, defeating its purpose.
 */
export function projectSyncResult(
  connectorId: string,
  result: ConnectorSyncResult,
  observedErrorCode?: ConnectorError["code"],
): ConnectorPollResult {
  const cause = causeForSyncResult(result, observedErrorCode);
  const base: ConnectorPollResult = {
    connectorId,
    status: result.status,
    processed: result.processed,
    // The gateway advanced + persisted the cursor ONLY on 'advanced' — mirror that
    // exactly (never claim a cursor advance the gateway did not make).
    cursorAdvanced: result.status === "advanced",
    ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
    ...(cause !== undefined ? { cause } : {}),
  };
  // The SoW-authored detail that separates two outcomes sharing one failureClass.
  const phrase = cause !== undefined ? CAUSE_PHRASE[cause] : undefined;
  // A healthSignal takes priority whenever the gateway emitted one (advanced-with-
  // coverage-degrade, 16.4, included). Absent a signal, a held/degraded pass still
  // gets a reason built from the cause; an advanced pass with no signal carries none.
  // The signal branch below deliberately drops `result.healthSignal.message` for every
  // failureClass EXCEPT `sync_lagging` — see the doc comment above.
  const reason =
    result.healthSignal !== undefined
      ? cause === "coverage_incomplete"
        ? `connector ${connectorId} coverage degraded: ${COVERAGE_DEGRADE_REASON}`
        : `connector ${connectorId} ${result.status}: ${result.healthSignal.failureClass}${
            phrase !== undefined ? ` — ${phrase}` : ""
          }`
      : result.status === "advanced"
        ? undefined
        : // No signal at all — the gateway's two held returns emit none. Without the
          // cause this read `connector held` for BOTH of them: a locked credential and
          // a consumer-side rejection rendered byte-identically, and the two remedies
          // are unrelated.
          `connector ${connectorId} ${result.status}: ${phrase ?? "cause not reported by the gateway"}`;
  return reason === undefined ? base : { ...base, healthReason: reason };
}

/**
 * Build a {@link ConnectorPollPort} that drives the §8 Connector Gateway per
 * connector. It resolves the concrete port + sync deps, runs ONE sync pass
 * (`runConnectorSync` — which advances the cursor ONLY after a page's records are
 * successfully processed, REQ-I-005), and projects the outcome. A gateway-level
 * rejection (the async call throwing — the gateway itself never throws by contract,
 * but a real adapter binding might) is folded to a typed `poll_failed`. `deps.resolve`
 * itself binds the real connector adapter (once armed) and MAY throw too — it runs
 * INSIDE the same try (§16: a throwing resolve must fold to the same typed error, never
 * escape the activity as an unhandled rejection). Never throws.
 *
 * THE OBSERVED-CODE TAP: `ConnectorSyncResult` carries the gateway's verdict but NOT
 * which `ConnectorError` produced it, so a 429, a transport outage and a malformed
 * payload arrived here indistinguishable (all three: `status: 'degraded'`,
 * `failureClass: 'connector_unreachable'`). This wraps the resolved port in a
 * pass-through that records the LAST fetch error's `code` — a member of the CLOSED
 * union in packages/integrations/src/connectors/port.ts. The error's `message` (raw
 * adapter/vendor text) is never touched, so nothing crossing the boundary widens.
 * The wrapper forwards the port's `Result` byte-for-byte and adds no branch, so the
 * gateway's retry/hold/degrade behaviour is unchanged; see {@link causeForSyncResult}
 * for the mechanism that makes the recorded code the verdict's cause. The recorder is
 * per-INVOCATION (not module state), so concurrent polls cannot observe each other.
 *
 * SAFETY RULE 7: this activity is REGISTERED (buildActivities.ts) — its returned
 * Result becomes durable, replayed Temporal workflow history. Whatever `cause`
 * carries here can be a real provider/HTTP rejection (a request URL with a token, a
 * Bearer auth header, a vendor error body), so it is DROPPED via {@link dropCause}
 * before crossing; only the stable `poll_failed` code + a fixed `message`
 * (interpolating only `connector.connectorId`, the workspace-configured connector
 * identifier — never response/error detail) cross.
 */
export function createConnectorPollActivity(
  deps: ConnectorPollActivityDeps,
): ConnectorPollPort {
  return {
    async poll(
      connector: ConnectorTarget,
    ): Promise<Result<ConnectorPollResult, ConnectorPollError>> {
      // Per-invocation: two concurrent polls must never see each other's fetch errors.
      let observedErrorCode: ConnectorError["code"] | undefined;
      try {
        const { port, syncDeps } = deps.resolve(connector);
        const tapped: ConnectorPort = {
          connectorId: port.connectorId,
          // Pass-through: the page Result is returned unchanged. Only the CLOSED
          // error code is recorded — never `error.message` (raw adapter text).
          fetch: async (cursor?: string) => {
            const page = await port.fetch(cursor);
            if (isErr(page)) observedErrorCode = page.error.code;
            return page;
          },
        };
        const result = await runConnectorSync(tapped, syncDeps);
        return ok(projectSyncResult(connector.connectorId, result, observedErrorCode));
      } catch (cause) {
        return err<ConnectorPollError>(
          dropCause({
            code: "poll_failed",
            message: `connector ${connector.connectorId} sync pass failed`,
            cause,
          }),
        );
      }
    },
  };
}

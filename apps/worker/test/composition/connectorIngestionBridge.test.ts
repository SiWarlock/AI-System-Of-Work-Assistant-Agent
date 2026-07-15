// Task 15.1 — the connector→ingestion bridge (worker composition). RED-first. "The missing spine."
//
// createConnectorIngestionBridge returns the poll driver's `onRecords` consumer seam: a fetched page
// of ConnectorRecords → each mapped to a RegisterSourceInput → registerSource (the candidate-data
// gate) → on `registered`, a SourceIngestionInput → the injected dispatch (dispatchSourceIngestion).
// It is the SECOND production trigger into the ingestion path alongside the .md vault watcher.
//
// SAFETY (security-reviewer=invariant):
//   - candidate-data gate (rule 2): every record routes THROUGH registerSource; a rejected record
//     does NOT dispatch, and the bridge never bypasses the gate.
//   - idempotent dispatch (rule 3, worker Lesson 16): the content-versioned key `src:${ws}:${hash}`
//     IS the Temporal workflowId under REJECT_DUPLICATE — re-polling the same record does NOT
//     double-dispatch (AlreadyStarted → deduped no-op).
//   - WS-8 / no-inference (rule 2, REQ-F-017): the source's workspaceId comes from the BOUND
//     connector-instance (14.2), never from the record's payload content.
//   - no silent drop (REQ-I-005): a DISPATCH failure (Temporal down) HOLDS (onRecords returns err →
//     the gateway leaves the cursor at the last committed page); a permanently-malformed record is
//     rejected + observed (never an infinite poison-hold).
//   - pure/dormant: FAKE deps only — no network, no real transport, no tokenRef.
import { describe, it, expect } from "vitest";
import { ok, err, type Result } from "@sow/contracts";
import type { SourceIngestionInput } from "@sow/workflows";
import type { ConnectorRecord } from "@sow/integrations";
import type { DispatchOutcome, DispatchError } from "../../src/temporal/dispatchSourceIngestion";
import {
  createConnectorIngestionBridge,
  type ConnectorIngestionBinding,
} from "../../src/composition/connectorIngestionBridge";

const binding = (over: Partial<ConnectorIngestionBinding> = {}): ConnectorIngestionBinding => ({
  connectorId: "asana",
  workspaceId: "ws-a", // WS-8 anchor — from the 14.2 connector-instance, NOT content
  origin: "connector:asana",
  type: "asana_task",
  sensitivity: "normal",
  routingHints: { connectorId: "asana" },
  ...over,
});

const rec = (over: Partial<ConnectorRecord> = {}): ConnectorRecord => ({
  recordId: "task-1",
  contentHash: "hash-1",
  payload: { title: "a task" },
  ...over,
});

/** A fake dispatch that dedupes by workflowId (mirrors Temporal REJECT_DUPLICATE / Lesson 16). */
function fakeDispatch(opts: { fail?: boolean } = {}) {
  const calls: SourceIngestionInput[] = [];
  const started = new Set<string>();
  const dispatch = async (input: SourceIngestionInput): Promise<Result<DispatchOutcome, DispatchError>> => {
    calls.push(input);
    if (opts.fail) return err({ code: "temporal_unavailable", message: "temporal down" });
    const wid = input.run.workflowId as unknown as string;
    if (started.has(wid)) return ok({ workflowId: wid, dispatched: false, deduped: true });
    started.add(wid);
    return ok({ workflowId: wid, dispatched: true, deduped: false });
  };
  return { dispatch, calls, started };
}

/** seenContentHash defaults to false (register-level dedupe OFF) so tests isolate the Temporal dedupe. */
const registerDeps = (seen: (h: string) => boolean = () => false) => ({
  seenContentHash: async (h: string): Promise<boolean> => seen(h),
});

describe("createConnectorIngestionBridge (15.1 — the connector→ingestion bridge)", () => {
  it("poll_pass_bridges_records_to_dispatch: a page of valid records → each dispatched via registerSource → dispatch (trigger connector_event, key src:ws:hash) [spec(§19.2)]", async () => {
    const d = fakeDispatch();
    const bridge = createConnectorIngestionBridge({ binding: binding(), registerDeps: registerDeps(), dispatch: d.dispatch });
    const res = await bridge.onRecords([rec({ recordId: "t1", contentHash: "h1" }), rec({ recordId: "t2", contentHash: "h2" })]);
    expect(res.ok).toBe(true);
    expect(d.calls).toHaveLength(2);
    expect(d.calls[0]?.run.trigger).toBe("connector_event");
    expect(d.calls[0]?.run.idempotencyKey).toBe("src:ws-a:h1");
    expect(d.calls[0]?.run.workflowId as unknown as string).toBe("src:ws-a:h1");
    expect(d.calls[1]?.run.idempotencyKey).toBe("src:ws-a:h2");
    // the source envelope came through the registerSource gate (validated, workspace-bound).
    expect(d.calls[0]?.context.source.workspaceId as unknown as string).toBe("ws-a");
    expect(d.calls[0]?.context.source.contentHash).toBe("h1");
  });

  it("record_failing_registration_does_not_dispatch: a record rejected by registerSource (blank contentHash) does NOT dispatch; a valid record in the same page still does; the page is NOT held on a poison record [spec(§8)]", async () => {
    const d = fakeDispatch();
    const observed: string[] = [];
    const bridge = createConnectorIngestionBridge({
      binding: binding(),
      registerDeps: registerDeps(),
      dispatch: d.dispatch,
      onRecord: (o) => observed.push(o.kind),
    });
    const res = await bridge.onRecords([rec({ recordId: "bad", contentHash: "" }), rec({ recordId: "good", contentHash: "h-good" })]);
    expect(res.ok).toBe(true); // a permanently-malformed record is rejected, NOT an infinite hold
    expect(d.calls).toHaveLength(1); // ONLY the valid record dispatched — the gate was not bypassed
    expect(d.calls[0]?.run.idempotencyKey).toBe("src:ws-a:h-good");
    expect(observed).toContain("rejected"); // the rejection is observed, never a silent drop
    expect(observed).toContain("dispatched");
  });

  it("dedupe_hit_does_not_dispatch: a record whose contentHash is already registered (register-level Flow-4 dedupe) ⇒ NO dispatch, page ok (a benign skip, not a hold), observed dedupe_hit [spec(§8)]", async () => {
    const d = fakeDispatch();
    const observed: string[] = [];
    const bridge = createConnectorIngestionBridge({
      binding: binding(),
      registerDeps: registerDeps(() => true), // seenContentHash → true ⇒ registerSource returns dedupe_hit
      dispatch: d.dispatch,
      onRecord: (o) => observed.push(o.kind),
    });
    const res = await bridge.onRecords([rec({ recordId: "t1", contentHash: "already-seen" })]);
    expect(res.ok).toBe(true); // a dedupe_hit is a benign skip — NOT a hold (never re-fetches)
    expect(d.calls).toHaveLength(0); // already registered ⇒ never dispatched
    expect(observed).toEqual(["dedupe_hit"]);
  });

  it("duplicate_poll_dispatches_once: re-polling the SAME record ⇒ one FRESH run (same key = workflowId, AlreadyStarted → deduped no-op) — Lesson 16 [spec(§9)]", async () => {
    const d = fakeDispatch();
    // seenContentHash stays false so BOTH polls reach dispatch — isolating the Temporal-level dedupe.
    const bridge = createConnectorIngestionBridge({ binding: binding(), registerDeps: registerDeps(), dispatch: d.dispatch });
    await bridge.onRecords([rec({ recordId: "t1", contentHash: "dup" })]);
    await bridge.onRecords([rec({ recordId: "t1", contentHash: "dup" })]);
    expect(d.calls).toHaveLength(2); // both polls reached dispatch
    expect(d.calls[0]?.run.workflowId).toEqual(d.calls[1]?.run.workflowId); // same key = same workflowId
    expect(d.started.size).toBe(1); // …but only ONE fresh run stands (second deduped)
  });

  it("source_workspace_from_bound_instance_not_content: the dispatched source's workspaceId is the BOUND instance's, even when the record payload carries a different workspaceId (WS-8 / no-inference) [spec(§8)]", async () => {
    const d = fakeDispatch();
    const bridge = createConnectorIngestionBridge({ binding: binding({ workspaceId: "ws-a" }), registerDeps: registerDeps(), dispatch: d.dispatch });
    // A hostile payload tries to smuggle a different workspace.
    await bridge.onRecords([rec({ recordId: "t1", contentHash: "h1", payload: { workspaceId: "attacker-ws", body: "x" } })]);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.run.workspaceId).toBe("ws-a");
    expect(d.calls[0]?.context.source.workspaceId as unknown as string).toBe("ws-a"); // never "attacker-ws"
    expect(d.calls[0]?.run.idempotencyKey).toBe("src:ws-a:h1"); // key scoped by the bound ws
  });

  it("dispatch_failure_holds_the_page: a registered record whose dispatch fails (Temporal down) ⇒ onRecords returns err (HOLD — the gateway leaves the cursor; the record is retried, never silently dropped) — REQ-I-005 [spec(§9)]", async () => {
    const d = fakeDispatch({ fail: true });
    const bridge = createConnectorIngestionBridge({ binding: binding(), registerDeps: registerDeps(), dispatch: d.dispatch });
    const res = await bridge.onRecords([rec({ recordId: "t1", contentHash: "h1" })]);
    expect(res.ok).toBe(false); // held — the cursor stays at the last committed page
    expect(d.calls).toHaveLength(1); // dispatch WAS attempted (the source registered), then failed
  });

  it("bridge_uses_injected_deps_only_no_spurious_effect: an empty page ⇒ ok + zero dispatch/register (no real transport constructed — the whole path is fakes-only, pure/dormant) [spec(§19.2)]", async () => {
    const d = fakeDispatch();
    let seenCalls = 0;
    const bridge = createConnectorIngestionBridge({
      binding: binding(),
      registerDeps: { seenContentHash: async () => { seenCalls += 1; return false; } },
      dispatch: d.dispatch,
    });
    const res = await bridge.onRecords([]);
    expect(res.ok).toBe(true);
    expect(d.calls).toHaveLength(0);
    expect(seenCalls).toBe(0); // no record ⇒ no gate probe, no dispatch — no spurious effect
  });

  // NOT tested here — the meeting-closeout DISPATCH (a Granola meeting → the meeting machinery via
  // dispatchMeetingCloseout + correlateMeeting routing) is task 15.9: the meetingCloseout workflow
  // exists + is registered but has NO dispatch trigger, and routing a meeting through the generic
  // sourceIngestion path here would MIS-ROUTE it. Deferred to 15.9 (Step-2.5 Q1). not-tested-because.
});

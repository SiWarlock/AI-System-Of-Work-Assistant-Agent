// Task 15.1 — the connector→ingestion bridge (worker composition). "The missing spine."
//
// `createConnectorIngestionBridge` returns the poll driver's `onRecords` consumer seam: the §8
// Connector Gateway (`runConnectorSync`) hands it a fetched page of `ConnectorRecord`s, and the
// bridge maps each → a `RegisterSourceInput` → `registerSource` (the candidate-data gate) → on a
// clean `registered`, a `SourceIngestionInput` → the injected dispatch (`dispatchSourceIngestion`,
// which starts the §9 `sourceIngestion` workflow). This is the SECOND production trigger into the
// ingestion path alongside the local `.md` vault watcher.
//
// SAFETY:
//   - CANDIDATE-DATA GATE (safety rule 2): every record routes THROUGH `registerSource` — a record
//     that fails the schema gate does NOT dispatch, and the bridge never mints/dispatches around it.
//   - NO INFERENCE / WS-8 (safety rule 2 / REQ-F-017): every scoped field (workspaceId, origin,
//     type, sensitivity, routingHints base) comes from the BOUND connector-instance (14.2), NEVER
//     from the record's `payload` content. `sourceId` is derived from (workspace, connector,
//     recordId) — record METADATA, not content.
//   - IDEMPOTENT DISPATCH (safety rule 3 / worker Lesson 16): the content-versioned key
//     `src:${workspaceId}:${contentHash}` IS the Temporal workflowId under REJECT_DUPLICATE, so
//     re-polling the same record dedupes (AlreadyStarted → no-op no-fresh-run).
//   - NO SILENT DROP (REQ-I-005): a permanently-malformed record is rejected + OBSERVED then the
//     pass moves on (a poison record must never infinitely HOLD the connector); a TRANSIENT dispatch
//     fault (Temporal down) returns `err` so the gateway HOLDS the cursor (the page is retried, and
//     already-dispatched records dedupe at the workflowId on replay).
//
// PURE over injected deps — no real transport, no network, no tokenRef (Phase 16 binds the poll
// driver's `resolve → {port, syncDeps.onRecords}` + the schedule; Phase 18 the real extraction).
// This helper ships REACHABILITY-WAIVERED (its production caller is Phase 16's scheduled poll).
import { ok, err, type Result } from "@sow/contracts";
import { workflowId as brandWorkflowId } from "@sow/contracts";
import type { SourceIngestionInput, MeetingCloseoutInput } from "@sow/workflows";
import { registerSource } from "@sow/integrations";
import type { ConnectorRecord, OnRecordsError, RegisterSourceInput } from "@sow/integrations";
import type { DispatchOutcome, DispatchError } from "../temporal/dispatchSourceIngestion";

/**
 * The per-connector-instance binding (from the 14.2 connector-instance registry). Every scoped
 * field is POLICY-bound — never inferred from a record's content (WS-2 / REQ-F-017).
 */
export interface ConnectorIngestionBinding {
  readonly connectorId: string;
  /** The BOUND workspace (WS-8 anchor) — from the connector-instance, NEVER from record content. */
  readonly workspaceId: string;
  /** The source origin/locator string for this connector. */
  readonly origin: string;
  /** The source `type` (per-connector kind) — policy-bound, not content-inferred. */
  readonly type: string;
  /** The `sensitivity` posture — policy-bound (overridable at Flow-5 triage), not content-inferred. */
  readonly sensitivity: string;
  /** Base routing hints (connector metadata); the bridge adds connectorId + recordId. */
  readonly routingHints?: Record<string, unknown>;
  /**
   * The connector-instance KIND (from the 14.2 registry) — the WS-8-safe discrimination the bridge
   * routes on (15.9). A `"meeting"` connector (e.g. Granola completed-meetings) sends its records to
   * the meeting-closeout machinery; every other connector (default `"source"`) to source ingestion.
   * Derived from the BOUND instance, NEVER from a record content field (no-inference / WS-8).
   */
  readonly kind?: "source" | "meeting";
}

/** A typed, redaction-safe per-record outcome for the optional observer (never a raw payload). */
export type ConnectorIngestionRecordOutcome =
  | { readonly kind: "dispatched"; readonly workflowId: string; readonly deduped: boolean }
  | { readonly kind: "dedupe_hit" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "dispatch_failed"; readonly code: DispatchError["code"] };

/** The injected SOURCE dispatch (mirror the vault watcher's `VaultDispatch` — degraded-safe, idempotent). */
export type ConnectorIngestionDispatch = (
  input: SourceIngestionInput,
) => Promise<Result<DispatchOutcome, DispatchError>>;

/** The injected MEETING dispatch (dispatchMeetingCloseout — degraded-safe, idempotent-by-meeting-id, 15.9). */
export type ConnectorMeetingDispatch = (
  input: MeetingCloseoutInput,
) => Promise<Result<DispatchOutcome, DispatchError>>;

export interface ConnectorIngestionBridgeDeps {
  readonly binding: ConnectorIngestionBinding;
  /** The Flow-4 dedupe probe for `registerSource` (a real store backs it; a fake in tests). */
  readonly registerDeps: { readonly seenContentHash: (contentHash: string) => Promise<boolean> };
  /** The C3a dispatch entry, pre-bound to a Temporal Client (or degraded ⇒ fail-closed). */
  readonly dispatch: ConnectorIngestionDispatch;
  /**
   * The 15.9 MEETING dispatch entry (dispatchMeetingCloseout), pre-bound to a Temporal Client.
   * REQUIRED whenever `binding.kind === "meeting"`; a meeting binding with this ABSENT fails closed
   * (HOLD) — a completed meeting is never silently dropped nor misrouted to the source path.
   */
  readonly dispatchMeeting?: ConnectorMeetingDispatch;
  /** Observer for every per-record outcome (logging / test assertion). Faults swallowed. */
  readonly onRecord?: (outcome: ConnectorIngestionRecordOutcome, recordId: string) => void;
}

/** The bridge — the poll driver's `onRecords` consumer seam. */
export interface ConnectorIngestionBridge {
  onRecords(records: readonly ConnectorRecord[]): Promise<Result<void, OnRecordsError>>;
}

/**
 * Build the connector→ingestion bridge. The returned `onRecords` handles one page of records; a
 * dispatch failure HOLDS the page (returns `err` → the gateway leaves the cursor per REQ-I-005),
 * every other outcome moves on. Never throws.
 */
export function createConnectorIngestionBridge(deps: ConnectorIngestionBridgeDeps): ConnectorIngestionBridge {
  const { binding, registerDeps, dispatch } = deps;

  // Fail-fast WIRING invariant (15.9): a meeting binding MUST carry its meeting dispatch. A missing dep
  // is a composition bug — caught HERE at construction (a fail-fast, not a per-record runtime HOLD that
  // would wedge the connector forever with no §16 health item). A source binding needs no meeting dispatch.
  if (binding.kind === "meeting" && deps.dispatchMeeting === undefined) {
    throw new Error("createConnectorIngestionBridge: binding.kind='meeting' requires a dispatchMeeting dep");
  }

  // For a MEETING binding the `registerSource` contentHash dedupe is the WRONG axis: two DISTINCT meetings
  // can share an identical (empty/placeholder) transcript hash (Lesson 35), so a contentHash dedupe would
  // silently drop the second meeting. The meeting's recordId-keyed Temporal REJECT_DUPLICATE is the correct
  // AND sole idempotency (one closeout per meeting). So a meeting bridge validates THROUGH registerSource
  // (rule 2) but SKIPS its dedupe probe; the source bridge keeps its content-versioned dedupe (Lesson 16/34).
  const effectiveRegisterDeps: ConnectorIngestionBridgeDeps["registerDeps"] =
    binding.kind === "meeting" ? { seenContentHash: () => Promise.resolve(false) } : registerDeps;

  const observe = (outcome: ConnectorIngestionRecordOutcome, recordId: string): void => {
    try {
      deps.onRecord?.(outcome, recordId);
    } catch {
      // An observer fault must never break the bridge (§16).
    }
  };

  const bridgeRecord = async (record: ConnectorRecord): Promise<Result<void, OnRecordsError>> => {
    // Map the record → a candidate RegisterSourceInput. Scoped fields come from the BOUND
    // connector-instance (WS-8 / REQ-F-017); `contentHash` from the record; NOTHING from `payload`.
    const input: RegisterSourceInput = {
      sourceId: `connector:${binding.workspaceId}:${binding.connectorId}:${record.recordId}`,
      workspaceId: binding.workspaceId,
      origin: binding.origin,
      contentHash: record.contentHash,
      type: binding.type,
      sensitivity: binding.sensitivity,
      routingHints: { ...(binding.routingHints ?? {}), connectorId: binding.connectorId, recordId: record.recordId },
    };

    // Candidate-data gate (safety rule 2) — a rejected record NEVER dispatches.
    const registered = await registerSource(input, effectiveRegisterDeps);
    if (registered.outcome === "rejected") {
      // Permanently malformed — skip + observe; NOT an err (a poison record must not infinitely HOLD).
      observe({ kind: "rejected", message: registered.message }, record.recordId);
      return ok(undefined);
    }
    if (registered.outcome === "dedupe_hit") {
      observe({ kind: "dedupe_hit" }, record.recordId);
      return ok(undefined);
    }

    // Registered: the transcript/source cleared the candidate-data gate (rule 2). DISCRIMINATE on the
    // BOUND connector-instance kind (never a record content field, WS-8, 15.9): a completed-meeting
    // connector routes to the meeting-closeout machinery (correlate → agent → validate → propose);
    // every other connector to source ingestion. Both flow THROUGH `registerSource` above — the
    // discrimination happens on the CLEAN envelope, so the transcript never bypasses the gate.
    if (binding.kind === "meeting") {
      // `dispatchMeeting` is construction-guaranteed present for a meeting binding (fail-fast above).
      const dispatchMeeting = deps.dispatchMeeting as ConnectorMeetingDispatch;
      // The deterministic MEETING identity is the connector's canonical record id (NOT the contentHash)
      // → ONE closeout per meeting, STABLE across a re-poll / an edited transcript. WS-8: the workspace
      // is the BOUND instance's, never a record content field.
      const meetingKey = `meeting:${binding.workspaceId}:${record.recordId}`;
      const meeting: MeetingCloseoutInput = {
        run: {
          workflowId: brandWorkflowId(meetingKey),
          trigger: "connector_event",
          idempotencyKey: meetingKey,
          workspaceId: binding.workspaceId,
        },
        context: { source: registered.envelope, envelopes: [] },
      };
      const dispatchedMeeting = await dispatchMeeting(meeting);
      if (!dispatchedMeeting.ok) {
        observe({ kind: "dispatch_failed", code: dispatchedMeeting.error.code }, record.recordId);
        return err<OnRecordsError>({
          code: "downstream_rejected",
          message: `meeting dispatch failed: ${dispatchedMeeting.error.code}`,
        });
      }
      observe(
        { kind: "dispatched", workflowId: dispatchedMeeting.value.workflowId, deduped: dispatchedMeeting.value.deduped },
        record.recordId,
      );
      return ok(undefined);
    }

    // Registered: build the SourceIngestionInput. The content-versioned key IS the workflowId
    // (Lesson 16), so a re-poll of the same content dedupes at Temporal (REJECT_DUPLICATE).
    const key = `src:${binding.workspaceId}:${registered.envelope.contentHash}`;
    const ingestion: SourceIngestionInput = {
      run: {
        workflowId: brandWorkflowId(key),
        trigger: "connector_event",
        idempotencyKey: key,
        workspaceId: binding.workspaceId,
      },
      context: { source: registered.envelope, envelopes: [] },
    };

    const dispatched = await dispatch(ingestion);
    if (!dispatched.ok) {
      observe({ kind: "dispatch_failed", code: dispatched.error.code }, record.recordId);
      // A transient dispatch fault HOLDS the cursor (REQ-I-005) — the page is retried; the already-
      // dispatched records on that page dedupe at the workflowId on replay (Lesson 16).
      return err<OnRecordsError>({ code: "downstream_rejected", message: `dispatch failed: ${dispatched.error.code}` });
    }
    observe({ kind: "dispatched", workflowId: dispatched.value.workflowId, deduped: dispatched.value.deduped }, record.recordId);
    return ok(undefined);
  };

  return {
    async onRecords(records: readonly ConnectorRecord[]): Promise<Result<void, OnRecordsError>> {
      for (const record of records) {
        const result = await bridgeRecord(record);
        if (!result.ok) return result; // HOLD the whole page on a dispatch failure (REQ-I-005).
      }
      return ok(undefined);
    },
  };
}

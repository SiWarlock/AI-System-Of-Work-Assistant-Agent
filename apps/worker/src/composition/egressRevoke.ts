// Task 9.10-B ⚠ rule-5 SAFETY — the egress-ack REVOKE command IMPLEMENTATION (composition root). Pure over
// injected repos + a clock; binds the `EgressCommandPort` seam (declared in `api/procedures/egressCommands.ts`)
// to the real `WorkspaceConfigRepository` + `AuditRepository`. `revokeEgressAck` turns employer raw-cloud
// egress OFF for a workspace (the fail-SAFE direction — the inverse of the 9.10 FLIP): get-before-upsert
// (L30 immutable-binding, FAIL-CLOSED on any store fault), flip ack→false AND clear `acknowledgedAt` together
// (the `EgressPolicy.refine`), upsert, then append a summaries-only AuditRecord (§4 / rule-7). TOTAL
// never-throws (§16) — a thrown cause NEVER crosses. Mirrors `crossWorkspaceLink.revoke` + `provisionWorkspace`'s
// get-before-upsert guard.
import { ok, err, isErr } from "@sow/contracts";
import type { Result, Workspace } from "@sow/contracts";
import { isZeroEgressOnlyWorkspace, isRedactionSafe } from "@sow/policy";
import type { WorkspaceConfigRepository, AuditRepository } from "@sow/db";
import type { UiSafeEgressStatus } from "../api/procedures/systemHealth";
import type {
  EgressCommandPort,
  RevokeEgressAckInput,
  RevokeEgressAckError,
} from "../api/procedures/egressCommands";

/** Dependencies for {@link createEgressCommandPort} — the durable config store + the audit log + a clock. */
export interface EgressCommandDeps {
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly audit: AuditRepository;
  /** ISO-8601 now — injected so the audit timestamp stays deterministic/testable. */
  readonly now: () => string;
}

/**
 * Build the real egress command port over the injected repos + clock. `revokeEgressAck`:
 *   1. get-before-upsert (L30) — FAIL CLOSED: a not_found ⇒ `workspace_not_found`; any other get fault ⇒
 *      `store_fault`; NEVER upsert on an unknown/faulted prior state (preserve-fault, rule-5).
 *   2. flip `employerRawEgressAcknowledged`→false AND CLEAR `acknowledgedAt` together — the destructure-drop
 *      removes the key (not an undefined value), satisfying the `EgressPolicy.refine` (acknowledgedAt ABSENT
 *      ⇔ ack=false; a lingering timestamp would reject the upsert). Only the ack fields change (L30
 *      immutable-binding — id/type/dataOwner/name/matrix/binding-anchor untouched).
 *   3. upsert the fail-SAFE OFF state (durable).
 *   4. append a SUMMARIES-only AuditRecord (§4 / rule-7 — no raw content/policy dump). A sink fault fails
 *      CLOSED (the OFF state is already durable + the command is idempotent, so a retry completes the trail).
 *   5. return the NEW `UiSafeEgressStatus` — `zeroEgressOnly` DERIVED via {@link isZeroEgressOnlyWorkspace}
 *      over the just-written `revoked` state (not re-read, not asserted): revoking the ack does not by
 *      itself make a workspace local-only (9.22) — `providerMatrix`/`allowedProcessors` are untouched by
 *      this command, so a cloud-allowlisted workspace correctly stays `false` after a revoke.
 * TOTAL never-throws — the whole body is guarded; a thrown cause never crosses (rule-7, code+static msg only).
 */
export function createEgressCommandPort(deps: EgressCommandDeps): EgressCommandPort {
  return {
    async revokeEgressAck(
      input: RevokeEgressAckInput,
    ): Promise<Result<UiSafeEgressStatus, RevokeEgressAckError>> {
      try {
        const wsId = input.workspaceId;
        // (1) get-before-upsert (L30) — fail closed, never upsert on unknown/faulted prior.
        const existing = await deps.workspaceConfig.get(wsId as Workspace["id"]);
        if (isErr(existing)) {
          if (existing.error.code === "not_found") {
            return err({ code: "workspace_not_found", message: "workspace not found" });
          }
          // Task 9.36 — classify, don't collapse: a referentially-inconsistent stored row is
          // distinct from a generic store fault (permanently non-retryable, see egressCommands.ts).
          if (existing.error.code === "stored_row_schema_violation") {
            return err({ code: "stored_row_schema_violation", message: "workspace config read failed re-validation" });
          }
          return err({ code: "store_fault", message: "workspace config get failed" });
        }
        const ws = existing.value;
        const before = ws.egressPolicy.employerRawEgressAcknowledged;
        // (2) flip ack→false AND clear acknowledgedAt TOGETHER (refine-satisfying); only the ack fields change.
        const { acknowledgedAt: _cleared, ...restPolicy } = ws.egressPolicy;
        const revoked: Workspace = {
          ...ws,
          egressPolicy: { ...restPolicy, employerRawEgressAcknowledged: false },
        };
        // (3) upsert the durable fail-SAFE OFF state.
        const up = await deps.workspaceConfig.upsert(revoked);
        if (isErr(up)) return err({ code: "store_fault", message: "workspace config upsert failed" });
        // (4) audit — SUMMARIES only (rule-7). A sink fault fails closed (OFF is durable; retry completes it).
        //     Audit-fidelity carry-forward: a retry AFTER an audit fault re-reads the already-OFF state, so the
        //     completing row records before=false (loses the original true→false transition) — acceptable (the
        //     direction is fail-safe OFF + `egressStatus` disambiguates the actual state; a distinct code is deferred).
        //
        // Task 24.64 (worker leg B) — this constructs the audit record inline and calls
        // `deps.audit.append` DIRECTLY, so it never reached `isRedactionSafe`'s producer coverage
        // via `buildAuditSignal` (`packages/policy/src/audit-signal.ts:205-211` names this exact
        // site in its own retraction). Gated here. By-concept census of direct `audit.append(`
        // producers repo-wide in `src` (task 24.64's full scope): `dispositionDurable.ts:75` (the
        // sibling worker leg) and this site are the two gated by 24.64;
        // `packages/knowledge/src/knowledge-writer/writer.ts:603` and `tombstone.ts:306` are a
        // separate package's leg of the same task; `apps/worker/src/composition/buildActivities.ts:657`
        // and `apps/worker/src/boot.ts:736` take an ALREADY-BUILT record from their caller and are
        // EXPLICITLY SCOPED OUT of 24.64 — a named exclusion, not a miss. `AuditRecord` is a strict
        // superset of `AuditSignal` (actor/event/refs/payloadHash/beforeSummary/afterSummary), so
        // `isRedactionSafe` applies to this record's signal fields with no reshaping. Gate kept
        // IMMEDIATELY adjacent to the `append` call so a future edit cannot slip between them. The
        // rejection message NEVER echoes the offending value (rule 7) — a static string only.
        const auditRecord = {
          actor: "owner",
          event: "egress_ack_revoked",
          refs: [wsId],
          workspaceId: wsId,
          payloadHash: `egress-ack-revoked:${wsId}`,
          beforeSummary: `employerRawEgressAcknowledged=${before}`,
          afterSummary: "employerRawEgressAcknowledged=false; acknowledgedAt cleared",
          timestamps: { occurredAt: deps.now() },
        };
        if (!isRedactionSafe(auditRecord)) {
          return err({ code: "store_fault", message: "audit rejected by redaction gate" });
        }
        const audited = await deps.audit.append(auditRecord);
        if (isErr(audited)) return err({ code: "store_fault", message: "audit append failed" });
        // (5) the NEW UI-safe status — zeroEgressOnly DERIVED from the just-written `revoked` state via
        //     the SAME predicate the visibility reader uses (boot.ts `createSystemHealthQueryPort`), so
        //     the two producers cannot drift. `revoked` already carries the post-revoke providerMatrix +
        //     egressPolicy verbatim (only the ack fields changed above) — no second store read needed.
        return ok({
          workspaceId: wsId,
          employerRawEgressAcknowledged: false,
          zeroEgressOnly: isZeroEgressOnlyWorkspace(revoked),
        });
      } catch {
        // TOTAL never-throws — the thrown cause NEVER crosses (rule-7; code + static message only).
        return err({ code: "store_fault", message: "unexpected revoke fault" });
      }
    },
  };
}

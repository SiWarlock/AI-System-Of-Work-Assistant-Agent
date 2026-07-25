// @sow/integrations — dispatchExternalWrite: the ONLY external-write entry (§8
// Tool Gateway). This is the no-duplicate-write invariant core (safety rule 3,
// §5 fourth hard denial, §20.1 replay gate). It runs a FIXED-ORDER pipeline; each
// step is fail-closed, returns a typed Result, and NEVER throws across the
// boundary (§16):
//
//   1. candidate-gate — admitExternalWriteEnvelope(env, action). The envelope must
//      pass ajv→Zod→§3-keys AND the envelopeMatchesAction linkage pin (safety
//      invariant 3). A gate failure ⇒ {status:'rejected'} BEFORE any side effect.
//   2. approval — requireApproval(action). If approval is required AND not yet
//      granted (isApproved) ⇒ record a PENDING approval and RETURN
//      {status:'approval_pending'} WITHOUT dispatching (safety invariant 3 of the
//      slice brief: approval-before-dispatch). Proceed only when auto-allowed OR
//      already approved.
//   3. pre-write existence check — resolveExisting (safety invariant 2). A replay
//      hit OR an existing (prior-write receipt / live vendor object) hit ⇒ REUSE
//      the receipt/object, return {status:'reused'}, NO create — zero duplicate
//      write. A live-probe FAULT ⇒ {status:'held'} (fail-closed, never create on
//      an unreachable probe).
//   4. create — adapter.create(env, action.payload). On ok ⇒ persist the receipt
//      (indexed by both keys) + append an AuditRecord (summaries + payloadHash +
//      refs, NEVER the raw payload) + emit a safe redacted log ⇒ {status:'created'}.
//   5. create fault — 'conflict' ⇒ {status:'conflict'} (NEVER a blind overwrite);
//      'unreachable' ⇒ {status:'held'} (the outbox-hold signal for 6.5); 'rejected'
//      / 'unknown' ⇒ {status:'rejected'} (typed, never a silent drop). Nothing is
//      persisted on any fault.
import type {
  ProposedAction,
  ExternalWriteEnvelope,
  WriteReceipt,
  AuditRecord,
  Result,
} from "@sow/contracts";
import { admitExternalWriteEnvelope } from "../candidate-gate";
import { resolveExisting } from "./existence-check";
import { recordReceipt } from "./receipt-store";
import { buildSafeToolWriteLog, type SafeToolWriteLog } from "../redaction/gateway-log-redaction";
import type { ReceiptStore } from "../ports/persistence";
import type { TargetWriteAdapter } from "./adapter-port";
import { writeSecretRef, type WriteSecretsAccessor } from "./adapters/adapter-core";

/**
 * The approval-verdict value the gateway reads. Mirrors the §5 policy
 * `PolicyDecision.value` for `requiresApproval` — `{ requiresApproval, card? }`.
 * The gateway consumes only `requiresApproval`; `card` is opaque here.
 */
export interface GatewayApprovalDecision {
  readonly requiresApproval: boolean;
  readonly card?: unknown;
}

/**
 * Injected dependencies (§16 — no real network/clock/randomness in this module).
 * `requireApproval` is SYNCHRONOUS + PURE (the §5 predicate collapsed to its
 * verdict value); everything with a side effect is async + returns a typed
 * Result / void.
 */
export interface ExternalWriteDeps {
  readonly adapter: TargetWriteAdapter;
  readonly receiptStore: ReceiptStore;
  readonly requireApproval: (action: ProposedAction) => GatewayApprovalDecision;
  readonly recordPendingApproval: (
    action: ProposedAction,
    env: ExternalWriteEnvelope,
  ) => Promise<Result<unknown, unknown>>;
  readonly isApproved: (env: ExternalWriteEnvelope) => Promise<boolean>;
  readonly audit: (rec: AuditRecord) => Promise<void>;
  readonly clock: () => string;
  readonly logSink?: (rec: SafeToolWriteLog) => void;
  /**
   * 21.10 — the external-write CREDENTIAL SEAM. When BOUND, the write path resolves the
   * vendor auth token at DISPATCH-time (via the 17.4 `writeSecretRef`) and FAILS CLOSED on
   * an unavailable/throwing accessor — no unauthenticated write, token never read into a
   * sink (safety rule 7). OPTIONAL: absent ⇒ byte-equivalent (the dormant stub transport
   * needs no auth; the real accessor + real transport arm TOGETHER at §ARM-21 / 21.6).
   */
  readonly secrets?: WriteSecretsAccessor;
}

/** The closed, enumerable dispatch outcome set (§16). */
export type ExternalWriteResult =
  | { readonly status: "created"; readonly receipt: WriteReceipt }
  | { readonly status: "reused"; readonly receipt: WriteReceipt }
  | { readonly status: "approval_pending" }
  | { readonly status: "conflict"; readonly reason: string }
  | { readonly status: "held"; readonly reason: string }
  | { readonly status: "rejected"; readonly reason: string };

// --- helpers -----------------------------------------------------------------

// Build the redaction-safe audit + log for a committed create. NEVER carries the
// raw payload — only the payloadHash, the identity keys, and summaries.
function emitCommitDiagnostics(
  env: ExternalWriteEnvelope,
  receipt: WriteReceipt,
  deps: ExternalWriteDeps,
): Promise<void> {
  const audit: AuditRecord = {
    actor: "tool-gateway",
    event: "external_write.created",
    refs: [
      `ref:action:${env.actionId}`,
      `ref:object:${env.canonicalObjectKey}`,
      `ref:external:${receipt.externalObjectId}`,
    ],
    payloadHash: env.payloadHash,
    beforeSummary: "no external object recorded for this canonical key",
    afterSummary: "external object created; write receipt recorded",
    timestamps: { occurredAt: deps.clock(), recordedAt: deps.clock() },
  };
  if (deps.logSink !== undefined) {
    deps.logSink(
      buildSafeToolWriteLog({
        targetSystem: env.targetSystem,
        canonicalObjectKey: env.canonicalObjectKey,
        idempotencyKey: env.idempotencyKey,
        payloadHash: env.payloadHash,
        status: "created",
      }),
    );
  }
  return deps.audit(audit);
}

// Resolve the write auth token at dispatch-time — the fail-closed credential GATE
// (21.10, safety rule 7). Fails closed on unavailable / empty / throwing: a blank
// (whitespace-only) token is NOT proof of auth (mirrors `isRealVendorId` in the same
// core). The token value is read ONLY for the non-empty check and is then DISCARDED —
// never logged, never bound onward, never in a fault (rule 7). A throwing accessor is
// caught and held (§16 — never propagates). The held reason is CODE-ONLY (the closed-set
// unavailability code, never the token or the raw keychain ref).
async function resolveWriteCredentialFault(
  secrets: WriteSecretsAccessor,
  targetSystem: ExternalWriteEnvelope["targetSystem"],
): Promise<string | null> {
  try {
    const got = await secrets.getSecret(writeSecretRef(targetSystem));
    if (!got.ok) return `write credential unavailable: ${got.error.reason}`;
    if (got.value.trim().length === 0) return "write credential unavailable: empty";
    return null;
  } catch {
    return "write credential resolution faulted";
  }
}

// --- the entry point ---------------------------------------------------------

/**
 * The ONLY external-write entry (see module header for the fixed pipeline). Pure
 * apart from injected deps; never throws. Fail-closed at every step.
 */
export async function dispatchExternalWrite(
  env: ExternalWriteEnvelope,
  action: ProposedAction,
  deps: ExternalWriteDeps,
): Promise<ExternalWriteResult> {
  // 1. candidate-gate + linkage pin (safety invariant 1 + 3). Reject before any
  //    side effect, existence probe, or create.
  const admitted = admitExternalWriteEnvelope(env, action);
  if (!admitted.ok) {
    return { status: "rejected", reason: admitted.message };
  }

  // 2. approval-before-dispatch. If approval is required and not yet granted,
  //    record PENDING and return WITHOUT dispatching (no existence probe, no
  //    create).
  const verdict = deps.requireApproval(action);
  if (verdict.requiresApproval) {
    const approved = await deps.isApproved(env);
    if (!approved) {
      await deps.recordPendingApproval(action, env);
      return { status: "approval_pending" };
    }
  }

  // 2.5 CREDENTIAL SEAM (21.10, safety rule 7). Resolve the vendor write token at
  //     DISPATCH-time BEFORE any vendor call (the existence probe + create both need
  //     auth). An unavailable/throwing accessor HOLDS the write — no unauthenticated
  //     write, no existence probe, no create. DORMANT: absent accessor ⇒ skipped
  //     (byte-equivalent; the stub transport needs no auth — the real accessor arms
  //     with the real transport at §ARM-21). The token value is never read here.
  if (deps.secrets !== undefined) {
    const credentialFault = await resolveWriteCredentialFault(deps.secrets, env.targetSystem);
    if (credentialFault !== null) {
      return { status: "held", reason: credentialFault };
    }
  }

  // 3. MANDATORY pre-write existence check (safety invariant 2). Any hit ⇒ reuse,
  //    never a duplicate create. A live-probe fault ⇒ hold (fail-closed).
  const existing = await resolveExisting(env, deps.adapter, deps.receiptStore);
  if (existing.kind === "replay") {
    return { status: "reused", receipt: existing.receipt };
  }
  if (existing.kind === "existing") {
    if (existing.receipt !== undefined) {
      return { status: "reused", receipt: existing.receipt };
    }
    // A live vendor object with no local receipt: synthesize + persist a receipt
    // from the vendor identity so the next dispatch short-circuits on the object
    // key (still zero duplicate creates — no create was issued here).
    const vendorReceipt: WriteReceipt = {
      externalObjectId: existing.object!.externalObjectId,
      ...(existing.object!.externalUrl !== undefined
        ? { externalUrl: existing.object!.externalUrl }
        : {}),
      recordedAt: deps.clock(),
      ...(existing.object!.rawRef !== undefined ? { rawRef: existing.object!.rawRef } : {}),
    };
    await recordReceipt(deps.receiptStore, env, vendorReceipt, deps.clock);
    return { status: "reused", receipt: vendorReceipt };
  }
  if (existing.kind === "error") {
    // The existence probe could not confirm absence — NEVER create (would risk a
    // duplicate). Hold for the outbox / retry path.
    return { status: "held", reason: `existence-check ${existing.error.code}: ${existing.error.message}` };
  }

  // 3.5 RESERVE — atomically claim the exclusive right to create THIS object
  //     identity, closing the check-then-create race under concurrency / a second
  //     scheduler (safety invariant 2 / ARCHITECTURE §2.5: "a replayed Hermes
  //     automation produces no duplicate external action ... enforced by the
  //     gateways"). The existence check above is a fast-path reuse; this
  //     reservation is the real concurrency guard — only the WINNER may create.
  const reservation = await deps.receiptStore.reserve(env.targetSystem, env.canonicalObjectKey);
  if (reservation.kind === "committed") {
    // A concurrent dispatch created this object between our probe and our reserve.
    return { status: "reused", receipt: reservation.record.receipt };
  }
  if (reservation.kind === "in_progress") {
    // Another dispatch holds the reservation and is mid-create. Hold + retry;
    // NEVER issue a second create. The winner's receipt short-circuits the retry.
    return {
      status: "held",
      reason: "another dispatch holds the create reservation for this object (in progress)",
    };
  }

  // 4. create — we hold the reservation and the object does not exist. Issue
  //    EXACTLY ONE create. On success, recording the receipt commits the
  //    reservation; on fault, release it so a retry / outbox drain can re-claim.
  const created = await deps.adapter.create(env, action.payload);
  if (created.ok) {
    await recordReceipt(deps.receiptStore, env, created.value, deps.clock);
    await emitCommitDiagnostics(env, created.value, deps);
    return { status: "created", receipt: created.value };
  }

  // 5. create fault — release the reservation, then return a typed hold/conflict/
  //    rejected. Nothing persisted; NEVER a blind overwrite, NEVER a silent drop.
  await deps.receiptStore.release(env.targetSystem, env.canonicalObjectKey);
  switch (created.error.code) {
    case "conflict":
      return { status: "conflict", reason: created.error.message };
    case "unreachable":
      return { status: "held", reason: created.error.message };
    case "rejected":
    case "unknown":
    default:
      return { status: "rejected", reason: created.error.message };
  }
}

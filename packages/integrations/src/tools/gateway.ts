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
//      write. A live-probe FAULT never creates (fail-closed); its DISPOSITION
//      branches on the closed AdapterError code, the SAME switch step 5 uses:
//      'unreachable' ⇒ {status:'held'} (the retryable outbox-hold signal);
//      'conflict' ⇒ {status:'conflict'}; 'rejected'/'unknown'/'not_found' ⇒
//      {status:'rejected'} (permanent — terminal, never an infinite re-drive).
//      NOTE the retryable/terminal split is drawn at the TRANSPORT, by the code
//      it picks — 'unreachable' spans "never reached the vendor" AND "the vendor
//      said later" (408/425/429; transport.ts's `TransportFault`). This switch
//      only honours that choice; widening 'rejected' to retry would restore the
//      retry-forever bug, so a newly-retryable status is fixed upstream instead.
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
import type { TargetWriteAdapter, AdapterError } from "./adapter-port";
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

/**
 * `reason` is a redaction-safe OPERATOR DIAGNOSTIC for the held/conflict/
 * rejected arms, fed by two provenances:
 *
 *   (1) SAFE BY CONSTRUCTION — a closed code interpolated into a fixed
 *       template, or a Zod-issue summary built ONLY from `.code`/`.path`
 *       (never Zod's value-echoing `.message`): the candidate-gate rejection
 *       (`admitted.message` — see candidate-gate.ts's `safeZodIssueSummary`,
 *       which never touches raw Zod `.message`), the credential-fault reason
 *       (21.10 — the closed `"locked"`/`"empty"`/fault-code tokens, worker
 *       LESSONS §41), and the reservation-conflict literal.
 *   (2) SAFE BY CONTRACT — an adapter's own `AdapterError.message`
 *       (`existing.error.message` / `created.error.message`). adapter-port.ts's
 *       `AdapterError.message` doc comment REQUIRES every adapter to hand back
 *       a structured, SoW-authored diagnostic here — never a raw vendor body,
 *       URL, token, or driver/fs detail. This gateway forwards that message
 *       VERBATIM (paired with the closed `code`) rather than re-sanitizing it:
 *       sanitizing vendor-originated text is the ADAPTER's job, at the ONE
 *       boundary where that text enters the system. Discarding the message
 *       here instead would not add safety (the adapter already owns that
 *       duty) — it would only cost every operator the ability to tell WHICH
 *       fault occurred: a 401, a 403, an SSRF-blocked endpoint and a locked
 *       Keychain all carry the same `code` — `"rejected"` — and are separated
 *       ONLY by `message` (built from `httpStatus` for the first two, from the
 *       closed `faultDetail` token for the last two). A 429 is NOT in that list
 *       any more: it is `"unreachable"` and holds for retry.
 *
 * The closed `AdapterError.code` ALSO rides its own `adapterCode` field on
 * these three arms. A caller that must BRANCH on the failure kind (e.g.
 * notebooklm-sync.ts's per-slot `not_found` → reattach signal) reads
 * `adapterCode` — never parses `reason`, which is prose for a human, not a
 * control-flow token (a prior round broke exactly this by regex-matching
 * `reason`). `adapterCode` is absent when the failure did not originate from
 * an `AdapterError` (a candidate-gate rejection, a credential fault, a
 * reservation conflict).
 *
 * Temporal workflow history is a durable, replayed store (ARCHITECTURE.md:
 * 155/157) and `reason` is what an activity returns into it; every consumer
 * (a Temporal activity, a composition-root fold, a log sink) may forward it
 * verbatim — the redaction-or-safe-contract already happened here or one
 * layer down at the adapter boundary.
 */
export type ExternalWriteResult =
  | { readonly status: "created"; readonly receipt: WriteReceipt }
  | { readonly status: "reused"; readonly receipt: WriteReceipt }
  | { readonly status: "approval_pending" }
  | { readonly status: "conflict"; readonly reason: string; readonly adapterCode?: AdapterError["code"] }
  | { readonly status: "held"; readonly reason: string; readonly adapterCode?: AdapterError["code"] }
  | { readonly status: "rejected"; readonly reason: string; readonly adapterCode?: AdapterError["code"] };

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
/**
 * A credential fault plus its DISPOSITION.
 *
 * ⛔ Every verdict used to return `{status: "held"}`, which is the outbox
 * retry-with-backoff signal — so a permanently DENIED or entirely MISSING
 * credential was retried forever. Measured: twelve drain passes over a denied
 * credential left the entry `retry_queued`, and it can never become anything else
 * (`outbox-drain.ts` returns `backoffCfg.maxMs` on EXHAUSTED rather than a
 * terminal state), so the operator sees an entry that retries until someone looks.
 *
 * The split is whether RETRYING CAN HELP, which is a property of the reason:
 *   • `locked`  — the Keychain is locked. Unlocking it fixes this, and the retry
 *                 will then succeed on its own. RETRYABLE.
 *   • a THROW   — an accessor fault of unknown kind; a retry is cheap and may
 *                 succeed, so fail SAFE toward retrying. RETRYABLE.
 *   • `missing` / `denied` / `empty` — no credential is provisioned, or the ACL
 *                 refuses, or it is blank. No number of retries provisions a
 *                 secret; this needs an owner. TERMINAL.
 */
interface WriteCredentialFault {
  readonly reason: string;
  readonly retryable: boolean;
}

async function resolveWriteCredentialFault(
  secrets: WriteSecretsAccessor,
  targetSystem: ExternalWriteEnvelope["targetSystem"],
): Promise<WriteCredentialFault | null> {
  try {
    const got = await secrets.getSecret(writeSecretRef(targetSystem));
    if (!got.ok) {
      return {
        reason: `write credential unavailable: ${got.error.reason}`,
        // `locked` is the ONE reason an unattended retry can clear on its own.
        retryable: got.error.reason === "locked",
      };
    }
    if (got.value.trim().length === 0) {
      return { reason: "write credential unavailable: empty", retryable: false };
    }
    return null;
  } catch {
    return { reason: "write credential resolution faulted", retryable: true };
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
    // `admitted.message` is safe BY CONSTRUCTION (candidate-gate.ts builds it
    // from a Zod issue's `.code`/`.path` or a fixed literal — never Zod's
    // value-echoing `.message`; see the `ExternalWriteResult` doc comment).
    // There are only two `CandidateGateCode` values, so the code alone cannot
    // say WHICH field was bad — forward the message, not just the code.
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
      // Route on whether a retry CAN help (see WriteCredentialFault): a locked
      // Keychain holds for backoff; a missing/denied/empty credential is terminal
      // and needs an owner, so parking it in the outbox only hides it.
      return credentialFault.retryable
        ? { status: "held", reason: credentialFault.reason }
        : { status: "rejected", reason: credentialFault.reason };
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
    // duplicate). Every arm below is fail-closed in that sense; what differs is
    // the DISPOSITION, and it branches on the closed `AdapterError.code` with the
    // SAME switch the create-fault arm at step 5 uses.
    //
    // WHY THE SWITCH, not an unconditional hold. `held` is the outbox-hold signal
    // (step 5's comment), and `outbox-drain.ts`'s `computeNextAttemptAt`
    // deliberately never expires a held entry — an EXHAUSTED backoff still
    // returns a bounded `maxMs`. So mapping every probe fault to `held` put every
    // PERMANENT failure (a 401, a 404, an SSRF-blocked host) on a retry loop with
    // no terminal state, and made adapter-port.ts's `AdapterError` doc block —
    // "a caller must NOT treat `not_found` as an outbox-hold candidate ... never
    // 'retry later'" — false of its only caller. Only `unreachable` means "the
    // transport could not reach the vendor AT ALL"; only it is retryable.
    //
    // `reason` + `adapterCode` are IDENTICAL on every arm: `existing.error
    // .message` is safe BY CONTRACT (adapter-port.ts's `AdapterError.message`
    // doc comment), forwarded alongside the closed `code` (see the
    // `ExternalWriteResult` doc comment), and `adapterCode` lets a caller
    // (notebooklm-sync.ts's per-slot `not_found` → reattach) branch on the
    // failure kind without parsing this string. That reattach path reads
    // `adapterCode`, NOT `status`, so it is unaffected by the switch.
    //
    // ⛔ NO `default:` ARM. `AdapterError.code` is a CLOSED union, and a `default`
    // on a closed union is the `branch`/`stage` defect in another costume: it
    // makes the compiler accept a NEW member silently, and the member inherits
    // whichever disposition the catch-all happens to have. Here the catch-all
    // would be TERMINAL, so a future retryable code would be permanently
    // rejected. Listing every member instead — with the `never` binding below —
    // turns adding one into a COMPILE error at both fault arms.
    const existenceFaultReason = `existence-check ${existing.error.code}: ${existing.error.message}`;
    switch (existing.error.code) {
      case "unreachable":
        return { status: "held", reason: existenceFaultReason, adapterCode: existing.error.code };
      case "conflict":
        return { status: "conflict", reason: existenceFaultReason, adapterCode: existing.error.code };
      case "rejected":
      case "unknown":
      case "not_found":
        return { status: "rejected", reason: existenceFaultReason, adapterCode: existing.error.code };
    }
    // Unreachable by the type system (the switch is total over the union). Kept as
    // a runtime backstop because falling out of this `if` block would continue to
    // the RESERVE + CREATE path — i.e. an unhandled code would fail OPEN into the
    // one side effect this whole function exists to guard. Fail closed instead.
    const unhandledExistenceCode: never = existing.error.code;
    return { status: "rejected", reason: `existence-check ${String(unhandledExistenceCode)}` };
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
  // `created.error.message` is safe BY CONTRACT (adapter-port.ts's
  // `AdapterError.message` doc comment) — forwarded alongside the closed code
  // (see the `ExternalWriteResult` doc comment). This is the ONLY thing that
  // distinguishes, say, a 401 from a 403 from an SSRF-blocked endpoint from a
  // locked Keychain — all four share `code: "rejected"` and reach this arm as
  // {status:'rejected'}. (A 429 does NOT: it is `unreachable`, so it takes the
  // `held` arm above and is retried.) `adapterCode` also rides its own field for
  // callers that must branch (never parse `reason`).
  await deps.receiptStore.release(env.targetSystem, env.canonicalObjectKey);
  // No `default:` arm here either, for the reason given at the existence-probe
  // switch above: on a closed union it converts "a new code appeared" from a
  // compile error into a silent terminal classification.
  const createFaultReason = `create fault (${created.error.code}): ${created.error.message}`;
  switch (created.error.code) {
    case "conflict":
      return { status: "conflict", reason: createFaultReason, adapterCode: created.error.code };
    case "unreachable":
      return { status: "held", reason: createFaultReason, adapterCode: created.error.code };
    case "rejected":
    case "unknown":
    case "not_found":
      return { status: "rejected", reason: createFaultReason, adapterCode: created.error.code };
  }
  // Unreachable by the type system; a fail-closed runtime backstop (see above).
  const unhandledCreateCode: never = created.error.code;
  return { status: "rejected", reason: `create fault (${String(unhandledCreateCode)})` };
}

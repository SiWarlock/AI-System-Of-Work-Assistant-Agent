// KnowledgeWriter core — the SOLE autonomous writer of canonical Markdown
// (safety rule 1: one writer / no hidden brain, REQ-F-006 / KN-4 / KN-9), §6 /
// task 4.1. Every semantic mutation the whole system makes to a vault flows
// through `applyPlan`; this module exposes no raw-write export, so no other
// component can commit Markdown through this contract.
//
// Pipeline (each step fails closed with a typed variant, never a throw — §16):
//   1. idempotent-replay short-circuit (same idempotencyKey ⇒ prior revision)
//   2. COMPOSED candidate-data gate: ajv validate() ∘ Zod .parse ∘ ruleScopedMutation
//      (never ajv alone — ajv drops Zod .refine, so empty sourceRefs slips the
//      JSON-Schema layer; the Zod parse + §3 rule catch it — LESSONS §3)
//   3. compare-revision precondition (on-disk == expected base, else write_conflict)
//   4. project the plan into post-apply file bytes
//   4.4. already-present detection (task 24.77) — an EMPTY diff over a plan that DECLARES mutations
//        means the vault already holds this plan's projected end state; step 8's row must say so
//        rather than claim `revision-applied: 0 file(s) changed`
//   4.5. foreign-workspace path-consistency guard (task 24.12) — a note's path must carry its own
//        plan.workspaceId as prefix, unless it's a KN-12 structural surface or the one legacy-exempt
//        workspace the Copilot LegacyContentPolicy {mode:"assign"} bridge serves
//   5. ownership check hook (task 4.2) — BEFORE the secret scan and the commit
//   6. secret scan hook (task 4.3) — immediately BEFORE the atomic commit
//   7. atomic all-or-nothing commit (temp-write + rename)
//   8. record exactly one AuditRecord + one CommittedRevision (durable, replayable)
//
// No side effect (no Markdown write) happens before the gate passes (safety rule
// 2). The ownership + secret hooks are injected: task 4.1 ships pass-through
// defaults so the ORDERING and the typed variants exist now; tasks 4.2 / 4.3
// install the real predicates without touching the pipeline.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  KnowledgeMutationPlan,
  NoteCreate,
  NotePatch,
  LinkMutation,
  FrontmatterPatch,
  AuditRecord,
  WorkflowRunRef,
  FactIdentity,
  MdContentSha,
  RevisionId as ContractRevisionId,
} from "@sow/contracts";
import {
  KnowledgeMutationPlanSchema,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
} from "@sow/contracts";
import { validate, ruleScopedMutation } from "@sow/domain";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import type { AuditRepository } from "@sow/db";
import { atomicCommit } from "../markdown-vault/atomic-write";
import type { FileChange, VaultFs } from "../markdown-vault/atomic-write";
import {
  buildCommitAuditRecord,
  compareRevision,
  computeRevisionId,
  hashPayload,
  type CommittedRevision,
  type KnowledgeRevisionStore,
  type RevisionId,
  type VaultSnapshot,
} from "./revision";
// Secure-by-default: the REAL ownership + secret predicates are the applyPlan
// defaults (a caller may still override via deps). ownership.ts / secret-scan.ts
// import only TYPES from this module (erased at runtime) so these value imports
// create no runtime cycle.
import { enforceHumanOwnership } from "./ownership";
import { scanForSecrets } from "./secret-scan";
// The on-disk frontmatter format codec (§13.10a gate 2 + its inverse). Kept in one module so the
// forward serializer and its inverse cannot drift; the region/link projection stays here.
import {
  serializeScalar,
  parseNote,
  composeNote,
  KW_STAMP_FRONTMATTER_KEY,
} from "./frontmatter";
import {
  neutralizeNoteBody,
  neutralizeRegionMarkers,
} from "../markdown-vault/sections";
import { stampProvenance, serializeStampFieldValue } from "./provenance-stamp";
import type { StamperDeps } from "./provenance-stamp";
// The SHARED page-hash core (gate 4 G1d-1): the writer mints its stamp through the SAME function
// deriveCanonicalFacts uses, so the (factIdentity, mdContentSha) bound here == what the serving gate re-derives.
import { computePageProvenance } from "../gbrain/derive/canonical-fact-deriver";
import { buildRefusalSignal, type IssueCarryingRefusal, type RefusalIssue } from "../audit/validation-refusal";
import { isRedactionSafe, type AuditSignal } from "@sow/policy";

// ── injected hooks (tasks 4.2 / 4.3) ────────────────────────────────────────

export interface OwnershipCheckContext {
  readonly path: string;
  readonly priorContent: string | undefined;
  readonly nextContent: string;
  readonly plan: KnowledgeMutationPlan;
}
export interface OwnershipViolation {
  readonly code: "ownership_violation";
  readonly path: string;
  readonly regionId?: string;
  readonly reason?: string;
}
/** Human-owned-section guard (KN-7 / task 4.2). Default: pass. */
export type OwnershipCheck = (
  ctx: OwnershipCheckContext,
) => Result<void, OwnershipViolation>;

export interface SecretScanContext {
  readonly path: string;
  readonly content: string;
}
export interface SecretFound {
  readonly code: "secret_found";
  readonly path: string;
  readonly kind?: string;
}
/** Blocking pre-commit secret scan (reject-not-redact / task 4.3). Default: pass. */
export type SecretScan = (ctx: SecretScanContext) => Result<void, SecretFound>;

export interface WorkspacePathContext {
  readonly path: string;
  readonly plan: KnowledgeMutationPlan;
}
export interface WorkspacePathViolation {
  readonly code: "workspace_path_violation";
  /**
   * ⚠ rule 7: safe to return to the SAME in-process caller that submitted the plan (it already knows
   * its own path) — mirrors `OwnershipViolation`/`SecretFound`/`CommitFailed`'s own `.path` fields.
   * NOT safe to carry unredacted into any DURABLE log/health/audit sink a future caller might add; a
   * vault path can encode a workspace-adjacent slug — redact/gate it there, the way every other §16
   * surface in this codebase does, before this crosses that boundary.
   */
  readonly path: string;
}
/**
 * Foreign-workspace path-consistency guard (24.12 remedy — §5 WS-8, safety rule 4). The
 * `packages/policy` Copilot serving-time `LegacyContentPolicy` `{mode:"assign"}` bridge treats every
 * UNPREFIXED note in the combined gbrain brain as belonging to its one `toWorkspaceId` — sound only
 * while the brain holds a single workspace's unprefixed content. This guard makes a foreign-workspace
 * note landing unprefixed UNREPRESENTABLE at the one place every semantic write crosses (rule 1).
 * ⛔ NO DEFAULT (24.26 step 3). Build one with `makeEnforceWorkspacePathScope(<exempt workspace id>)`
 * from `./workspace-path-guard`, supplying the id from the composition root — see
 * `apps/worker/src/composition/legacy-workspace.ts`, which is that id's single home.
 */
export type WorkspacePathCheck = (
  ctx: WorkspacePathContext,
) => Result<void, WorkspacePathViolation>;

// ── command / deps / result shapes ──────────────────────────────────────────

/**
 * One KnowledgeWriter apply request. `plan` is CANDIDATE DATA (`unknown`) — the
 * writer runs the composed gate itself; nothing is trusted pre-validation.
 */
export interface KnowledgeWriteCommand {
  readonly plan: unknown;
  /** The revision the apply is computed against (compare-revision precondition). */
  readonly expectedBaseRevision: RevisionId;
  readonly actor: string;
  readonly sourceEventRef: string;
  readonly workflowRunRef: WorkflowRunRef;
  readonly idempotencyKey: string;
}

export interface KnowledgeWriterDeps {
  readonly vault: VaultFs;
  readonly revisions: KnowledgeRevisionStore;
  readonly audit: AuditRepository;
  /** Injected clock (ISO-8601). Keeps the writer deterministic under test. */
  readonly now: () => string;
  readonly ownershipCheck?: OwnershipCheck;
  readonly secretScan?: SecretScan;
  /**
   * 24.12 remedy — foreign-workspace path-consistency guard (safety rule 4 / WS-8).
   *
   * ⛔ REQUIRED (24.26 step 3 of 3). There is no default: the exempt workspace id must be supplied
   * by the composition root, so the "which workspace may commit unprefixed" fact has ONE home
   * (`apps/worker/src/composition/legacy-workspace.ts`) instead of a module constant here that
   * silently duplicated it. Omitting this field is a TYPE error — pinned in `writer.test.ts`.
   * ⚠ `?` is load-bearing by its absence: restoring it re-creates the default this task deleted.
   */
  readonly workspacePathCheck: WorkspacePathCheck;
  /** Schema-registry override (tests); defaults to the process registry. */
  readonly registry?: SchemaRegistry;
  /**
   * Gate 4 (G1d-2) provenance-signing seam. When PRESENT, the writer mints a `SignedProvenanceStamp` for each
   * changed page note and embeds it under the reserved `kwStamp` frontmatter key at commit — the authorship
   * proof the serving gate re-verifies. When ABSENT (the default / dormant case), the commit is BYTE-IDENTICAL
   * to today: no stamp is minted or embedded. Provisioned only once a real Keychain signing key exists.
   */
  readonly signing?: StamperDeps;
}

export interface WriteSuccess {
  readonly revisionId: RevisionId;
  readonly auditRecord: AuditRecord;
  /** True when returned via idempotent replay (no new write / no new audit). */
  readonly replayed: boolean;
}

/**
 * ⛔ SAFETY RULE 1 SURFACE — this is the LIVE member of `### 24.103`'s population (production caller:
 * `packages/workflows/src/activities/commitKnowledge.ts`). It extends the shared
 * `IssueCarryingRefusal`, so `audit` is REQUIRED and the compiler enumerates every construction site
 * in `runGate`. See `src/audit/validation-refusal.ts` for why the shape is shared but the unions are
 * NOT merged, and for what breaks if `audit` is made optional again.
 * ⚠ `stage` keeps THREE members here (`### 24.98`'s GCL helper accepts only two) — the `scoped` stage
 * is this gate's §3 universal-rule layer and has no counterpart on the projection gate.
 */
export interface SchemaRejected extends IssueCarryingRefusal {
  readonly code: "schema_rejected";
  readonly stage: "ajv" | "zod" | "scoped";
}
export interface WriteConflict {
  readonly code: "write_conflict";
  readonly expectedBaseRevision: RevisionId;
  readonly onDiskRevision: RevisionId;
}
export interface CommitFailed {
  readonly code: "commit_failed";
  readonly path: string;
  readonly cause: unknown;
}

/**
 * 24.72 — the two POST-COMMIT recording faults. ⛔ READ THE NAME AS WRITTEN: the commit did NOT fail.
 * The Markdown is durable at `revisionId`; what did not land is the RECORD of it.
 *
 * ⛔ WHY NOT `commit_failed`: that code says the commit failed, and here it succeeded. Reporting one of
 * these as `commit_failed` would tell a caller to treat a durable write as absent — the report
 * inversion this task exists to remove, preserved under a typed shape instead of a throw.
 * ⛔ WHY NOT any semantic/policy code: a store being unreachable did not earn a verdict about the
 * plan. A config/infra fault must never be reported as a policy judgement it did not earn.
 * ⭐ WHY TWO MEMBERS AND NOT ONE: a caller that cannot tell WHICH record is missing cannot remediate
 * either — re-deriving an AuditRecord and re-recording a CommittedRevision are different operations
 * against different stores. Collapsing them is the same absorption an exhaustive mapper exists to
 * prevent, performed deliberately in a `case` instead of accidentally in a `default`.
 * ⚠ `revisionId` is carried because the commit STANDS: without it the caller knows a recording failed
 * but not which revision is durable, which is most of the remediation problem left in place.
 */
export interface AuditRecordFailed {
  readonly code: "audit_record_failed";
  /** The revision that IS durable in the vault. The commit stands; only its audit row is missing. */
  readonly revisionId: RevisionId;
  readonly cause: unknown;
}
export interface RevisionRecordFailed {
  readonly code: "revision_record_failed";
  /** The revision that IS durable in the vault. The commit stands; only its store record is missing. */
  readonly revisionId: RevisionId;
  readonly cause: unknown;
}

/**
 * Enumerable, never-silent failure surface (§16). The four semantic/policy
 * variants (schema_rejected | write_conflict | ownership_violation | secret_found)
 * are the ones the brief pins; `commit_failed` is the typed infrastructure-fault
 * route (a filesystem fault mid-commit) — still typed, still routable to System
 * Health, never a swallowed throw. `workspace_path_violation` (24.12) is the fifth
 * semantic/policy variant: a foreign-workspace note whose path does not carry its
 * own workspace's prefix.
 * `audit_record_failed` / `revision_record_failed` (24.72) are POST-COMMIT infrastructure faults —
 * the only two members that describe a state in which the Markdown write SUCCEEDED. Every other
 * member means nothing was committed.
 */
export type WriteFailure =
  | SchemaRejected
  | WriteConflict
  | OwnershipViolation
  | SecretFound
  | WorkspacePathViolation
  | CommitFailed
  | AuditRecordFailed
  | RevisionRecordFailed;

// ── 24.64 (knowledge leg) — commit AuditRecord redaction sanitiser ──────────
//
// ⭐ THE BY-CONCEPT ENUMERATION (24.64's full scope, restated from the worker leg's own copy at
// `apps/worker/src/composition/egressRevoke.ts` so a reader of EITHER package's leg sees the whole
// picture): the task's census of direct `audit.append(` producers repo-wide in `src` (i.e. producers
// that construct an `AuditRecord`-shaped object INLINE and call `deps.audit.append` directly,
// bypassing `buildAuditSignal` — `packages/policy/src/audit-signal.ts:205-211` names this exact
// producer shape in its own retraction) found FOUR sites, split two-and-two by package:
//   • worker leg (CA-5A, not this file): `apps/worker/src/composition/dispositionDurable.ts:75` and
//     `egressRevoke.ts:80` — disposition-BEARING triage steps, not the sole-writer path, so THEIR
//     disposition is gate-and-fail-closed (`isRedactionSafe` check that REJECTS the operation on
//     failure — see `egressRevoke.ts:105`).
//   • knowledge leg (HERE): `writer.ts:603` (below) and `tombstone.ts:306` — the KnowledgeWriter
//     COMMIT path itself (safety rule 1: the sole autonomous Markdown writer). A gate that can REJECT
//     here can BLOCK a semantic write that already committed durably to disk, so the disposition
//     inverts: VALIDATE-OR-OMIT, never fail-closed-on-commit. On failure this sanitiser replaces only
//     the individual `refs` entries that themselves fail the check with a bounded opaque placeholder,
//     and the SANITISED record is what gets appended — the audit is never dropped (nothing silent)
//     and the commit never fails because of this check.
//   • explicitly SCOPED OUT of 24.64 (a named exclusion, not a miss): `buildActivities.ts:657` and
//     `boot.ts:736` take an ALREADY-BUILT record from their caller — there is no local construction
//     for a gate to sit next to.
// `secret-scan.ts:90`'s `buildSecretScanRejectionAudit` is a FIFTH direct-append-adjacent producer but
// is OUT of this census on a different axis: it already goes through `buildAuditSignal` (never
// bypasses it), so it is not a "direct construction" site at all — see its own doc comment for the
// explicit ACCEPTED-WITH-REASON disposition (already covered, nothing to gate).
//
// WHY ONLY `refs` — and not `beforeSummary`/`afterSummary`/`payloadHash`/`actor`/`event` — IS EVER
// REWRITTEN: every one of those other fields is built here from a FIXED template or an internal
// counter (`summarize`/`summarizeAlreadyApplied`, `hashPayload`, the literal `"KnowledgeWriter"`
// actor, the literal `"knowledge_writer.commit"` event) — never from candidate-controlled text. `refs`
// is the one field that folds in `plan.planId`: `PlanIdSchema` (`packages/contracts`) validates only
// non-emptiness, not content SHAPE, so a schema-valid plan can still carry a credential-shaped planId.
// That is the representable violation this sanitiser exists to catch — not a second copy of the
// secret-scan content gate (which scans rendered Markdown BODIES, a disjoint surface).
export const KW_AUDIT_REF_REDACTED_PLACEHOLDER = "kw-audit-ref-redacted" as const;

/** Fixed, keyword-free placeholder fields so ONLY the probed `ref` drives the per-entry verdict. */
const REF_PROBE_ACTOR = "kw-ref-probe";
const REF_PROBE_EVENT = "kw-ref-probe";
const REF_PROBE_HASH = "kw-ref-probe";

/** True iff this single `refs` entry, scanned in isolation, is redaction-safe. */
function isRefRedactionSafe(ref: string): boolean {
  return isRedactionSafe({
    actor: REF_PROBE_ACTOR,
    event: REF_PROBE_EVENT,
    payloadHash: REF_PROBE_HASH,
    beforeSummary: "",
    afterSummary: "",
    refs: [ref],
  });
}

/**
 * VALIDATE-OR-OMIT sanitiser for a constructed commit `AuditRecord`, immediately before
 * `deps.audit.append` (writer.ts) / the tombstone's equivalent (tombstone.ts). Never rejects, never
 * drops the audit, never touches `payloadHash` or either summary — see the block comment above for
 * why `refs` is the only field in scope. Returns the SAME object (no new allocation) when the record
 * is already redaction-safe, so the byte-identical-on-the-safe-path guarantee holds by construction,
 * not by a downstream equality check.
 */
function sanitizeCommitAuditRecordForAppend(record: AuditRecord): AuditRecord {
  const signal: AuditSignal = {
    actor: record.actor,
    event: record.event,
    refs: record.refs,
    payloadHash: record.payloadHash,
    beforeSummary: record.beforeSummary,
    afterSummary: record.afterSummary,
  };
  if (isRedactionSafe(signal)) return record;
  const refs = record.refs.map((ref) =>
    isRefRedactionSafe(ref) ? ref : KW_AUDIT_REF_REDACTED_PLACEHOLDER,
  );
  return { ...record, refs };
}

// ── the writer ───────────────────────────────────────────────────────────────

// (The former pass-through no-op defaults were a fail-OPEN hole — an uninjected
// caller got NO ownership/secret enforcement. Defaults are now the real predicates.)

/**
 * Apply one KnowledgeMutationPlan atomically. See the module header for the
 * pipeline + invariants. Returns the committed revision + its AuditRecord, or a
 * typed `WriteFailure`.
 *
 * ⛔ (`### 24.116`) `applyPlan` CONTAINS EXACTLY TWO `try` BLOCKS, NOT ZERO — stated as a CHECKABLE
 * claim, not the blanket zero-`try` universal this docblock asserted here once and got wrong,
 * falsified by this same function's own body 300+ lines below: `validation-refusal.ts` copied that
 * universal, security review caught it there ("an auditor greps `try`, finds hits inside `applyPlan`,
 * and concludes the whole argument is stale"), and the copy got fixed while the original stayed
 * wrong. Named so a future `try` addition without a comment update is checkable,
 * not merely re-assertable: both wrap a POST-COMMIT recording write (24.72 — typed, not thrown) — the
 * `try` at `:708` wraps `deps.audit.append`, folding a throw to `audit_record_failed`; the `try` at
 * `:730` wraps `deps.revisions.record`, folding a throw to `revision_record_failed`. ⚠ THESE TWO
 * NUMBERS ARE THE CHECKABLE PART, NOT DECORATION: `writer.test.ts`'s
 * `applyPlan_docblock_makes_no_false_universal_try_claim` extracts them from this very paragraph and
 * cross-checks them against a live scan of the function body, so a future `try` block added — or
 * these two moved — without updating this comment reds the suite rather than going silently stale
 * the way the sentence this replaces did.
 * The candidate-data GATE CALL (`runGate`, step 2, long before either try block opens) sits OUTSIDE
 * both — not because it was overlooked, but because it runs structurally EARLIER, before the commit
 * even begins: a throw from deep inside it (e.g. `structuralPathOnly`/`cutWithCompiled` while
 * assembling a refusal's `AuditSignal`) propagates out of `applyPlan` UNCAUGHT, which is exactly why
 * `structuralPathOnly`'s own never-throw property (`src/audit/validation-refusal.ts`) is a measured
 * constraint there, not a style choice. So the §16 never-throw promise is not total AT THIS FUNCTION,
 * and the old "for well-typed deps" qualifier did not save it (measured, 24.67). Every OTHER `await`
 * on injected substrate — i.e. every one NOT inside the two try blocks named above — can still reject
 * out of it:
 *   PRE-COMMIT (nothing written yet) — `deps.revisions.getByIdempotencyKey` (step 1); `readSnapshot`
 *     → `deps.vault.list`/`.read` (step 3); and inside `atomicCommit` the priors-capture `fs.read`
 *     (`../markdown-vault/atomic-write.ts`), which sits OUTSIDE both of that function's try blocks.
 *   POST-COMMIT (Markdown already durable), NOT covered by either try block above — `deps.now()`.
 *     `deps.audit.append`/`deps.revisions.record` are NOT on this list any more: the two try blocks
 *     above are precisely what now catches them (24.72), which is the correction this note makes.
 *   ⚠ A deps object cast past the type system with a required field missing is the SAME class
 *     reached the same way — not a separate mechanism.
 *
 * ⭐ BUT IT DOES NOT ESCAPE PRODUCTION UNTYPED, AND AN EARLIER DRAFT OF THIS COMMENT CLAIMED IT DID.
 * `createCommitActivity` (`packages/workflows/src/activities/commitKnowledge.ts`) wraps this call in
 * try/catch and folds ANY throw to a typed `commit_failed` — for precisely this reason, in its own
 * words ("its INJECTED substrate … could THROW on an infra fault") — pinned by
 * `commit-activity-base-revision.test.ts`, and all three production compositions funnel through it.
 * ⛔ THE RESIDUAL IS NARROWER AND SHARPER THAN "IT THROWS" (`### 24.72`): on a POST-COMMIT fault the
 * Markdown mutation IS durable, the caller is told `commit_failed`, and NO AuditRecord lands ⇒ a
 * DURABLE SEMANTIC MUTATION REPORTED AS A FAILURE, WITH NO AUDIT ROW. A REPORT INVERSION, not an
 * uncaught escape. ⚠ Step 8's comment ("a recording fault is a System-Health concern, not a
 * rollback — the commit stands") is right that the commit stands; what it does not say is that the
 * recording never happens and the caller is told the opposite.
 * ⚠ GRADED (lead, 24.67): NOT safety rule 1 — KN-4 governs WHO WRITES, and KnowledgeWriter did the
 * write through a validated plan; this is §16 plus an audit-trail/observability defect. Same class
 * found independently in `packages/policy`'s `validateProjectionVisibility` (a `### 24.65` finding).
 *
 * ── 24.67 — WHY A NON-FUNCTION `workspacePathCheck` IS *NOT* GUARDED HERE ──────────────────────
 *
 * ⛔ DO NOT RE-DERIVE FROM THE ORIGINAL REASON. It was "a guard would be the deleted `??` fallback
 * wearing a different hat"; that is FALSE and was WITHDRAWN by its author. The deleted fallback
 * ADMITTED writes under a hardcoded exempt id; a fail-closed `err` ADMITS NOTHING. Opposites, not
 * variants (contracts L120 — a sound conclusion on an unsound reason gets inherited). The decision
 * stands on these instead:
 *
 * 1. ORDERING — `workspacePathCheck` is the SAFEST of the required deps, not the most exposed.
 *    Omitted via cast, `vault` / `revisions` / `workspacePathCheck` throw with the vault EMPTY;
 *    `now` and `audit` throw with the vault ALREADY COMMITTED. A guard on this one field hardens a
 *    member that is ALREADY fail-closed and leaves the two that already wrote — partial coverage
 *    reading as "§16 is robust at applyPlan" (contracts L137 — a check narrower than its own prose).
 *    ⚠ QUALIFIED: "throws with the vault empty" holds only for a NON-EMPTY change set. With zero
 *    changes the step-4.5 loop is never entered and `applyPlan` returns `ok` — making this also the
 *    only pre-write dep whose omission can be entirely SIGNAL-FREE.
 *    ⭐ PINNED, BECAUSE THE DECISION RESTS ON IT: `workspace-path-guard.test.ts`'s
 *    `workspace_path_check_is_invoked_before_any_byte_is_committed` — which reds if the step-4.5
 *    loop moves PAST the step-7 commit. ⚠ It does NOT red if the loop moves anywhere earlier within
 *    steps 1-6; the pin is narrower than "reorder applyPlan and it reds."
 * 2. NO EXISTING `WriteFailure` MEMBER IS TRUTHFUL FOR A MISCONFIGURED DEPS OBJECT.
 *    • `workspace_path_violation` asserts THIS PLAN violated workspace path scope. It is the ONLY
 *      member of the downstream `KnowledgeCommitFailureCode` union that is an isolation breach (that
 *      union's own doc says so) and maps to `FailureClass "isolation_breach"` — and
 *      `commitKnowledge.ts` propagates `cause: result.error`, so a SYNTHESIZED violation would
 *      inject a FABRICATED `.path` into durable health/audit sinks, the field `WorkspacePathViolation`
 *      documents (above) as unsafe for exactly those sinks. A config fault durably recorded as a
 *      rule-4 isolation breach poisons the signal rule 4 depends on (contracts L106).
 *    • `commit_failed` would NOT poison rule 4 (it maps to `write_through_failed`), but it asserts a
 *      commit was ATTEMPTED that never was. Milder, still false.
 * 3. AND A `commit_failed`-SHAPED GUARD IS REDUNDANT — `createCommitActivity` ALREADY catches the
 *    throw and folds it to exactly that at the port boundary, test-pinned. The typed-error outcome a
 *    guard here would produce ALREADY EXISTS one layer out, without touching this function.
 * 4. COST OF A TRUTHFUL VARIANT — a NEW `WriteFailure` member is a deliberate compile error in THREE
 *    areas, every one `assertNever`-guarded (24.23 / contracts L134): `packages/workflows`'
 *    `mapWriteFailure` + `commitFailureClass`/`commitFailureState`, and `apps/worker`'s
 *    `commitFailureToVariant`. ⚠ `KnowledgeCommitFailureCode` is declared in
 *    `packages/workflows/src/ports/meetingCloseout.ts`, NOT in `packages/contracts` — an earlier
 *    draft of this comment said contracts, and a reader checking "is it really three areas?" there
 *    would find nothing and conclude they had misread. Per contracts L103 the required field IS the
 *    mechanism; this belt would be mislabelled as one.
 *
 * ⚠ WHAT WOULD CHANGE THIS ANSWER (contracts L106 — an accepted residual owes its invalidating
 * condition). Any of:
 *   (i)   `WriteFailure` gains a misconfiguration-class member for ANY other reason ⇒ reason 4
 *         collapses; add the guard THEN — and for EVERY required dep, never this one alone, which is
 *         what reason 1 is for. ⚠ Do not hardcode the dep count: it was five at 24.67, and `signing`
 *         is one promotion away from six.
 *   (ii)  `applyPlan` acquires a caller that builds deps on a JOB PATH rather than at a composition
 *         root ⇒ the cast class stops being hypothetical.
 *   (iii) ⭐ `applyPlan` acquires a caller that does NOT wrap it in a §16 catch, or that catch is
 *         removed/narrowed. Reason 3, and reason 1's "already fail-closed", are SYSTEM-level claims
 *         resting on `createCommitActivity`'s try/catch — which lives in another package, and
 *         nothing links its pin to this decision.
 * ⛔ NO remedy may re-introduce a default check or an exempt id. The only admissible remedy is a
 * REJECTION; a substitution re-opens `### 24.26`.
 * ⚠ The `as`-cast and a genuinely-absent field are the SAME runtime state (`undefined`) and are
 * deliberately not distinguished — different intents, identical behaviour, nothing to branch on.
 * ⚠ AND THE CAST-ONLY THROW IS PINNED, which the pre-24.67 version of this comment said and this one
 * must not drop: `workspace-path-guard.test.ts`'s
 * `omitted_workspacepathcheck_runtime_behaviour_is_pinned_not_inferred`.
 *
 * ⭐ RE-RUN, DO NOT BELIEVE (contracts L143 — a finding with no falsification command rots): the dep
 * table above reproduces by deleting one required key at a time from an otherwise complete deps
 * literal, casting it to `KnowledgeWriterDeps`, calling `applyPlan` with a plan whose `creates` is
 * NON-EMPTY (load-bearing — see reason 1's qualifier), and recording the thrown error against
 * `vault.snapshot()`. Hold the vault handle OUTSIDE the deps literal (the `vault`-deleted row has
 * nothing to call `.snapshot()` on otherwise), and start from an empty vault + fresh revision store
 * or step 1 replays instead.
 */
export async function applyPlan(
  command: KnowledgeWriteCommand,
  deps: KnowledgeWriterDeps,
): Promise<Result<WriteSuccess, WriteFailure>> {
  const ownership = deps.ownershipCheck ?? enforceHumanOwnership;
  const scan = deps.secretScan ?? scanForSecrets;
  // 24.26 step 3: no `??` fallback. A default here would be a second home for the exempt workspace
  // id — the duplication this three-step sequence exists to remove — so the check is supplied or the
  // code does not compile.
  const workspaceScope = deps.workspacePathCheck;

  // 1 — idempotent replay: a prior commit for this key returns without any new
  // write or second AuditRecord (§6 idempotency).
  const prior = await deps.revisions.getByIdempotencyKey(
    command.idempotencyKey,
  );
  if (prior !== undefined) {
    return ok({
      revisionId: prior.revisionId,
      auditRecord: prior.auditRecord,
      replayed: true,
    });
  }

  // 2 — composed candidate-data gate (ajv → Zod → §3 scoped rule). No filesystem
  // touch happens before this passes (safety rule 2).
  const gated = runGate(command.plan, deps.registry);
  if (!gated.ok) {
    return gated;
  }
  const plan = gated.value;

  // 3 — compare-revision precondition against the live on-disk state.
  const snapshot = await readSnapshot(deps.vault);
  const onDisk = computeRevisionId(snapshot);
  if (!compareRevision(onDisk, command.expectedBaseRevision)) {
    return err({
      code: "write_conflict",
      expectedBaseRevision: command.expectedBaseRevision,
      onDiskRevision: onDisk,
    });
  }

  // 4 — project the plan into post-apply bytes; derive the changed file set.
  const projected = projectPlan(snapshot, plan);
  const changes = diffChanges(snapshot, projected);

  // 4.4 — 24.77: AN EMPTY DIFF OVER A PLAN THAT DECLARES MUTATIONS MEANS THE PLAN IS ALREADY APPLIED.
  // ⚠ NUMBERED 4.4, NOT 4.6, DELIBERATELY: it runs HERE — after step 4's diff, before step 4.5's
  // guard loop — and this file's step vocabulary is load-bearing (the 24.67 block above reasons about
  // "the step-4.5 loop" moving relative to "the step-7 commit" to justify a rule-4 decision). A step
  // number that does not match execution order damages the one thing that block needs to stay readable.
  // The vault already contains what this plan asks for, so step 8's audit row must NOT claim
  // `revision-applied: 0 file(s) changed` — a row that names a non-zero declared mutation count while
  // reporting an empty diff CONTRADICTS ITSELF, and (measured, 24.76) it is written against a base
  // that ALREADY INCLUDES the mutation.
  // ⛔ THE PREDICATE IS DELIBERATELY RETRY-BLIND — it reads only this call's diff and this plan's own
  // declared counts. It does NOT rest on the exactly-once approval CAS or on `createCommitActivity`'s
  // §16 catch, which are what block the retry in production TODAY and which `### 24.72`'s natural
  // remedy would remove. Assume both gone: this still fires, because its inputs are local.
  // ⚠ DISCRIMINATOR, and it is the load-bearing half: `changes.length === 0` ALONE is not the
  // condition. A legitimately empty plan (declares nothing, changes nothing) is an honest zero-change
  // commit and keeps its ordinary row — widening this to "any empty diff" would suppress that too.
  // ⭐ PRECEDENT, cited by what it DID and where (contracts L124): `tombstone.ts`'s step 5 recognises
  // the same STATE — "idempotent content no-op: the vault is already in the tombstoned end state …
  // no new revision/audit" — so the sibling writer answered this question and `applyPlan` never got
  // the answer (contracts L134's shape: the correct posture already in use in the same subsystem).
  // ⛔⛔ BUT DO NOT COMPLETE THE PARALLEL — IT DIVERGES HERE IN BOTH RESPECTS THIS GUARD TURNS ON,
  // and a reader who mirrors it would undo this slice (reviewer-caught; contracts L105):
  //   (1) CONDITION — tombstone tests `changes.length === 0` ALONE. That is the widening the
  //       DISCRIMINATOR paragraph above forbids. It is sound THERE because a tombstone command
  //       always targets a removal, so an empty diff cannot mean "declared nothing"; `applyPlan`
  //       accepts plans that legitimately declare nothing, so it must test BOTH conjuncts.
  //   (2) DISPOSITION — tombstone SUPPRESSES (early `ok({changed:false})`: no commit, no revision,
  //       NO audit row). This function does the opposite on purpose: it writes a TRUTHFUL row (see
  //       step 8).
  //       ⛔ CORRECTED (`### 24.80`, measured). This paragraph used to read: *"Suppression is honest
  //       THERE only because tombstone moves the signal into its RETURN TYPE via `changed: false`;
  //       `WriteSuccess` has no such field, so suppressing here would delete the fact rather than
  //       relocate it."* ⚠ TECHNICALLY TRUE AND MATERIALLY OVERSTATED — and it is the sentence that
  //       motivated a whole task to mirror the field, so it is corrected rather than left.
  //       MEASURED: `changed` has ONE declaration (`tombstone.ts`) and THREE reads, all three in
  //       `tombstone.test.ts`. Its own port type (`TombstoneCommitSuccess`) does not declare it.
  //       ⇒ tombstone DECLARES the fact on its success value; it does NOT get the fact to a
  //       consumer. "Moves the signal into the return type" is true; "therefore observability" is
  //       not — the signal stops at the first port, exactly as this function's would.
  //       ⚠ THIS IS NOT A CLAIM THAT TOMBSTONE IS WRONG. A return-type honesty field is a
  //       defensible thing to have; what was false is that it SOLVED the observability problem and
  //       could therefore be mirrored as a solution here.
  //       ⇒ THE SURVIVING REASON, which is narrower and does hold: writing a truthful row is the
  //       option that is honest WITHOUT a new field. Suppression needs a discriminator that reaches
  //       someone, and no writer in this subsystem has one yet.
  // ⚠ ACCEPTED RESIDUAL + its invalidating condition (contracts L106): the applied/already-applied
  // distinction currently lives ONLY in `afterSummary` free text — `ui-safe.ts` deliberately drops
  // that field from both UI projections, no production code parses it, and the `Result` is
  // programmatically indistinguishable from an ordinary commit (`replayed` stays `false`). A
  // machine-readable discriminator on `WriteSuccess` is TRACKED AS `### 24.80` rather than added
  // here, because a field no consumer reads is itself an L106 defect; adding it owes a named consumer.
  // ⛔ AND IT IS WORSE THAN "no consumer reads it" (reviewer-established): `createCommitActivity`
  // returns `ok({revisionId, replayed})` and DROPS `auditRecord` entirely, so no downstream caller can
  // even READ this summary. The distinction currently cannot cross the port at all.
  // ⇒ INVALIDATING CONDITION: the moment any caller needs to BRANCH on already-applied, this row is
  // not enough and the discriminator is owed.
  const alreadyApplied = changes.length === 0 && planDeclaresMutations(plan);

  // 4.5 — foreign-workspace path-consistency guard (24.12 remedy, safety rule 4). BEFORE ownership +
  // secret scan (cheapest/structural check first) and BEFORE the commit — a foreign-workspace note
  // landing unprefixed is what let the Copilot serving-time LegacyContentPolicy `{mode:"assign"}`
  // bridge (packages/policy) silently sweep it into another workspace's served content; that
  // precondition was previously enforced only by an operator-discipline comment (contracts L123).
  for (const change of changes) {
    const decision = workspaceScope({ path: change.path, plan });
    if (!decision.ok) {
      return err(decision.error);
    }
  }

  // 5 — ownership check (task 4.2), BEFORE the secret scan and the commit.
  for (const change of changes) {
    const decision = ownership({
      path: change.path,
      priorContent: snapshot.get(change.path),
      nextContent: change.content,
      plan,
    });
    if (!decision.ok) {
      return err(decision.error);
    }
  }

  // 6 — blocking secret scan (task 4.3), immediately BEFORE the commit. Runs over the SEMANTIC changes; the
  // gate-4 provenance stamp embedded below is machine-generated writer metadata (an HMAC of public fields),
  // not secret-bearing content, so it is deliberately not re-scanned.
  for (const change of changes) {
    const decision = scan({ path: change.path, content: change.content });
    if (!decision.ok) {
      return err(decision.error);
    }
  }

  // 6b — gate 4 (G1d-2): embed a KnowledgeWriter authorship stamp into each changed page note. DORMANT unless a
  // signing key is provisioned (absent ⇒ committedProjected === projected, committedChanges === changes ⇒
  // byte-identical to today). Runs AFTER ownership + secret (the stamp is the writer's OWN provenance, not a
  // semantic mutation subject to the human-ownership gate, and not secret-bearing) and BEFORE the commit so the
  // committed bytes + recorded revision carry it. The stamp binds the page hash over BASE bytes; kwStamp is
  // carved out of that hash (G1b), so embedding it never perturbs what it signs (⇒ no next-commit conflict).
  const committedProjected =
    deps.signing !== undefined
      ? await embedProvenanceStamps(snapshot, projected, plan, deps.signing, {
          sourceEventRef: command.sourceEventRef,
          baseRevision: command.expectedBaseRevision,
          now: deps.now,
        })
      : projected;
  const committedChanges =
    deps.signing !== undefined
      ? diffChanges(snapshot, committedProjected)
      : changes;

  // 7 — atomic all-or-nothing commit (temp-write + rename). The new revision id
  // is the deterministic staging token — no clock/random enters the primitive.
  const newRevision = computeRevisionId(committedProjected);
  const committed = await atomicCommit(
    deps.vault,
    committedChanges,
    tokenOf(newRevision),
  );
  if (!committed.ok) {
    // Both atomic phases (stage_failed / commit_failed) roll the vault back to the
    // prior revision; surface either as the single typed infra-fault variant.
    return err({
      code: "commit_failed",
      path: committed.error.path,
      cause: committed.error.cause,
    });
  }

  // 8 — record exactly one AuditRecord + one CommittedRevision. Markdown is now
  // durable (safety rule 1: committed_to_markdown never rolls back), so a recording
  // fault is a System-Health concern, not a rollback — the commit stands.
  const occurredAt = deps.now();
  const auditRecord = buildCommitAuditRecord({
    actor: command.actor,
    sourceEventRef: command.sourceEventRef,
    workflowRunRef: command.workflowRunRef,
    idempotencyKey: command.idempotencyKey,
    planId: plan.planId,
    baseRevisionId: command.expectedBaseRevision,
    newRevisionId: newRevision,
    beforeSummary: `revision ${command.expectedBaseRevision}`,
    // 24.77: the already-applied case gets a TRUTHFUL summary rather than a false `revision-applied`.
    // ⛔ A truthful row, not a SUPPRESSED one (orchestrator ruling): suppression would trade a wrong
    // row for an absent one, and `### 24.72` is separately about restoring observability — the
    // asymmetry "a missing row is investigated, a wrong one is believed" does not license
    // manufacturing absences.
    afterSummary: alreadyApplied
      ? summarizeAlreadyApplied(plan)
      : summarize(plan, changes.length),
    payloadHash: hashPayload(plan),
    occurredAt,
    // WS-8 scope for the §9.5 recent-changes projector — the plan always carries a workspaceId (KN gate).
    workspaceId: plan.workspaceId,
  });
  // 24.72 — the recording faults are TYPED, not thrown. Step 8's own note says a recording fault is a
  // System-Health concern rather than a rollback; that was true as an intention and unimplemented as
  // behaviour.
  // ⛔ STATE THE DEFECT PRECISELY — IT IS MISREPORTING, NOT ESCAPE, and an earlier draft of THIS
  // comment said "escaped", 266 lines below the paragraph where I had already corrected exactly that
  // claim (see the §16 note above). `applyPlan` rejected UNTYPED; `createCommitActivity`'s §16 catch
  // then folded EVERY rejection to `commit_failed` — so a post-commit record fault was reported as a
  // COMMIT THAT FAILED while the Markdown was durable. Caught, and caught wrongly.
  // ⭐ WHICH IS WHY A TYPED, DISTINGUISHABLE FAILURE HERE IS THE FIX AND A THROW COULD NEVER BE: a
  // rejection carries no discriminant for that catch to preserve, and `commit_failed` discards the
  // one thing a remediator needs. Only a member originating HERE survives the fold.
  // ⚠ VERIFIED, not inherited: all three production bindings (`semanticApprovalDispatch.ts:90`,
  // `buildActivities.ts:613`/`:1104`) reach `applyPlan` through that one catch, so there is no
  // uncaught-escape path to claim.
  // ⛔ NO ROLLBACK, DELIBERATELY. The Markdown is durable and stays durable: returning `err` here
  // reports what is missing (the record), never undoes what landed (the commit). A rollback would
  // repair the typed-failure surface by destroying a committed write — strictly worse.
  // ⚠ `catch` covers BOTH escapes: an async rejection AND a synchronous throw from the adapter before
  // its first await. Both were measured; an adapter can do either.
  // 24.64 (knowledge leg) — sanitise IMMEDIATELY before the append call (kept adjacent so a future
  // edit cannot slip a new append in between): validate-or-omit, never fail-closed-on-commit — see
  // the block comment above `sanitizeCommitAuditRecordForAppend`. `record` (below) and this function's
  // `WriteSuccess`/replay-path `auditRecord` deliberately still carry the UNSANITISED value — this
  // gate's scope is the append call only (§16 log-sink surface), not the in-process return/idempotency
  // shapes, which are never a log/redaction sink themselves.
  try {
    await deps.audit.append(sanitizeCommitAuditRecordForAppend(auditRecord));
  } catch (cause) {
    return err({ code: "audit_record_failed", revisionId: newRevision, cause });
  }

  const record: CommittedRevision = {
    revisionId: newRevision,
    baseRevisionId: command.expectedBaseRevision,
    idempotencyKey: command.idempotencyKey,
    planId: plan.planId,
    actor: command.actor,
    sourceEventRef: command.sourceEventRef,
    workflowRunRef: command.workflowRunRef,
    auditRecord,
    committedAt: occurredAt,
  };
  // 24.72 — same posture as the audit write above: typed, never thrown, and the commit still stands.
  // ⚠ Reached only when the audit row DID land, so the two members describe genuinely different
  // recovery states: `audit_record_failed` ⇒ neither record exists; `revision_record_failed` ⇒ the
  // audit row exists and only the revision record is missing. A caller cannot remediate without
  // knowing which, which is why these are two members rather than one.
  try {
    await deps.revisions.record(record);
  } catch (cause) {
    return err({
      code: "revision_record_failed",
      revisionId: newRevision,
      cause,
    });
  }

  return ok({ revisionId: newRevision, auditRecord, replayed: false });
}

// ── the composed candidate-data gate ─────────────────────────────────────────

// ── `### 24.103` — the KnowledgeWriter gate's refusal signal ─────────────────
// ⛔ THE LIVE CHANNEL. Every `runGate` refusal now carries an `AuditSignal` built from structural
// material ONLY — the closed `stage` literal, issue PATHS cut at this schema's free-form-key regions,
// and counts. `issues[].message` is EXCLUDED CATEGORICALLY; the predicate and the reason it is not
// negotiable live in `src/audit/validation-refusal.ts`, stated once rather than copied here.
// ⚠ CONSUMER STATUS, STATED SCOPED BECAUSE THE UNQUALIFIED VERSION WOULD BE FALSE, AND `### 24.109`
// DISPOSITIONS IT AGAINST THE OTHER THREE SITES RATHER THAN REPEATING THEIR SENTENCE: this is the
// LIVE sole-writer gate's own `KnowledgeMutationPlan` candidate — the highest-traffic of the four
// `### 24.109` channels (router.ts/generative-proposal-intake.ts/provenance-stamp.ts are dormant or
// lower-traffic). Signal is produced and gated; NO ADAPTER PERSISTS IT. This gate is not "now
// audited". A future consumer would key by the candidate's `planId` — present on every rejected
// plan, even an invalid one, since `planId` sits outside every free-form-key region and so is never
// cut. `provenance-stamp.ts`'s `stamp_invalid` is the one of the four that refuses
// INTERNALLY-MINTED data instead of a row — never conflate the two.
const KW_GATE_ACTOR = "knowledge:kw-gate" as const;
// A payloadHash-shaped decision marker — a fixed constant, never a hash of the candidate.
const KW_SCHEMA_REJECTED_PAYLOAD_MARKER = "knowledge:kw-schema-rejection" as const;

/**
 * @internal EXPORTED FOR PINNING, not for callers. The `scoped` stage is measured unreachable
 * end-to-end, so its only honest pin drives THIS function — the real producer — rather than a
 * hand-copied duplicate of its literals, which would stay green if the producer's `refPrefix`,
 * `beforeSummary` or region cut changed.
 */
export function kwSchemaRejectedSignal(
  stage: SchemaRejected["stage"],
  issues: readonly RefusalIssue[],
): AuditSignal {
  return buildRefusalSignal({
    actor: KW_GATE_ACTOR,
    event: `knowledge.writer.schema_rejected.${stage}`,
    refPrefix: "kw-issue-path",
    payloadHash: KW_SCHEMA_REJECTED_PAYLOAD_MARKER,
    beforeSummary: `knowledge mutation plan candidate refused at the ${stage} schema stage`,
    schemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
    issues,
  });
}

function runGate(
  candidate: unknown,
  registry: SchemaRegistry | undefined,
): Result<KnowledgeMutationPlan, SchemaRejected> {
  // (a) ajv structural gate (REQ-S-006).
  const structural =
    registry === undefined
      ? validate(candidate, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID)
      : validate(candidate, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, registry);
  if (!structural.ok) {
    const issues: readonly RefusalIssue[] = structural.error.errors ?? [
      { path: structural.error.schemaId, message: structural.error.code },
    ];
    return err({
      code: "schema_rejected",
      stage: "ajv",
      issues,
      audit: kwSchemaRejectedSignal("ajv", issues),
    });
  }

  // (b) Zod parse — recovers the `.refine` rules ajv/JSON-Schema drop (LESSONS §3),
  // e.g. the non-empty sourceRefs requirement.
  const parsed = KnowledgeMutationPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues: readonly RefusalIssue[] = parsed.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return err({
      code: "schema_rejected",
      stage: "zod",
      issues,
      audit: kwSchemaRejectedSignal("zod", issues),
    });
  }
  const plan = parsed.data;

  // (c) §3 universal scoped-mutation rule (REQ-F-006): workspaceId + ≥1 sourceRef.
  // ⚠ MEASURED UNREACHABLE VIA THIS FUNCTION, AND DELIBERATELY RETAINED (`### 24.103` Step 9):
  // `ruleScopedMutation` refuses on exactly two conditions and the Zod model at (b) enforces a
  // SUPERSET of both, so every candidate this stage would reject is already rejected above. It is
  // kept as a fail-closed layer that fires if the Zod model ever loosens — ⛔ "unreachable" is not a
  // licence to delete it, and its signal is pinned directly rather than through a synthetic driver.
  const scoped = ruleScopedMutation(plan);
  if (!scoped.ok) {
    const issues: readonly RefusalIssue[] = (scoped.error.fields ?? []).map((f) => ({
      path: f,
      message: scoped.error.code,
    }));
    return err({
      code: "schema_rejected",
      stage: "scoped",
      issues,
      audit: kwSchemaRejectedSignal("scoped", issues),
    });
  }

  return ok(plan);
}

// ── plan projection (interim; region/link byte-semantics firm up in task 4.2) ─

async function readSnapshot(vault: VaultFs): Promise<VaultSnapshot> {
  const paths = await vault.list();
  const snapshot = new Map<string, string>();
  for (const path of paths) {
    const content = await vault.read(path);
    if (content !== undefined) {
      snapshot.set(path, content);
    }
  }
  return snapshot;
}

/**
 * Read the current whole-vault revision id LIVE from `vault` — `computeRevisionId ∘ readSnapshot`, the SAME
 * pair `applyPlan`'s compare-revision precondition uses (step 3 above). The COMMIT-ON-APPROVAL path resolves
 * its expected base revision to THIS at commit time: a Copilot semantic plan is approved long after propose,
 * so a FIXED base would spuriously `write_conflict` on any unrelated vault change between the two. Resolving
 * head-at-commit makes the whole-vault compare a no-op and delegates TARGET integrity to the executor's
 * gate-1 (`readNoteProjectId` / `noteExists`) — the precise, per-target check. Read-only; never mutates.
 */
export async function readVaultHeadRevision(
  vault: VaultFs,
): Promise<RevisionId> {
  return computeRevisionId(await readSnapshot(vault));
}

/**
 * Gate 4 (G1d-2) — embed a KnowledgeWriter authorship stamp into each CHANGED page note, returning a stamped
 * copy of the projected vault. Called only when a signing key is provisioned. For each note whose projected
 * content differs from the snapshot (a create/update — deletes are absent from `projected`) and ends in `.md`,
 * mints a stamp binding the SHARED page provenance (identity + hash over the BASE, unstamped bytes via
 * `computePageProvenance`) and embeds it under the reserved `kwStamp` frontmatter key.
 *
 * FAIL-SAFE + never throws: a note with no safe page slug, a mint that errs, or a SecretsPort that throws is
 * left UNSTAMPED — it commits normally (safely UNTRUSTED at serving). The stamp is best-effort provenance that
 * NEVER blocks a semantic write and NEVER falsely trusts. `kwStamp` is carved out of the page hash (G1b), so
 * embedding it does not perturb what it signs (⇒ the committed note re-derives to the SAME hash the gate checks).
 */
async function embedProvenanceStamps(
  snapshot: VaultSnapshot,
  projected: VaultSnapshot,
  plan: KnowledgeMutationPlan,
  signing: StamperDeps,
  meta: {
    readonly sourceEventRef: string;
    readonly baseRevision: RevisionId;
    readonly now: () => string;
  },
): Promise<VaultSnapshot> {
  const stamped = new Map(projected);
  for (const [path, content] of projected) {
    if (snapshot.get(path) === content) continue; // unchanged — nothing to stamp
    if (!path.endsWith(".md")) continue; // only Markdown notes carry a page fact
    const page = computePageProvenance(path, content);
    if (page === null) continue; // no safe slug ⇒ not a servable page ⇒ leave unstamped
    let minted: Awaited<ReturnType<typeof stampProvenance>>;
    try {
      minted = await stampProvenance(
        {
          workspaceId: plan.workspaceId,
          factIdentity: page.pageIdentity as FactIdentity,
          originPath: path,
          mdContentSha: page.pageSha as MdContentSha,
          // kwRevision is UNSIGNED informational (G1a) — the base revision the note is committed against; the
          // writer's RevisionId is an unbranded string, so brand it for the StampInputs shape.
          kwRevision: meta.baseRevision as unknown as ContractRevisionId,
          sourceEventRef: meta.sourceEventRef,
          committedAt: meta.now(),
        },
        signing,
      );
    } catch {
      continue; // an unexpected SecretsPort throw ⇒ fail-safe (commit this note unstamped)
    }
    if (!minted.ok) continue; // key-unresolved / mint failure ⇒ fail-safe (commit this note unstamped)
    const { frontmatter, body } = parseNote(content);
    const nextFrontmatter = new Map(frontmatter);
    nextFrontmatter.set(
      KW_STAMP_FRONTMATTER_KEY,
      serializeStampFieldValue(minted.value),
    );
    stamped.set(path, composeNote(nextFrontmatter, body));
  }
  return stamped;
}

/**
 * Fold every mutation kind (creates / frontmatterUpdates / patches / linkMutations)
 * into the post-apply vault. Returns the WHOLE next snapshot so one revision id
 * covers the plan atomically. The precise region-marker + wikilink byte-format is
 * an interim convention here — task 4.2 (`sections.ts`) owns the stable-ID,
 * human-ownership-preserving version; this task pins the atomic/gate/revision core.
 */
function projectPlan(
  snapshot: VaultSnapshot,
  plan: KnowledgeMutationPlan,
): Map<string, string> {
  const next = new Map<string, string>(snapshot);

  for (const create of plan.creates) {
    next.set(create.path, renderCreate(create));
  }
  for (const patch of plan.frontmatterUpdates) {
    next.set(patch.path, applyFrontmatter(next.get(patch.path) ?? "", patch));
  }
  for (const patch of plan.patches) {
    next.set(patch.path, applyRegionPatch(next.get(patch.path) ?? "", patch));
  }
  for (const link of plan.linkMutations) {
    next.set(link.srcPath, applyLink(next.get(link.srcPath) ?? "", link));
  }

  return next;
}

function renderCreate(create: NoteCreate): string {
  const fm = new Map<string, string>();
  for (const [key, value] of Object.entries(create.frontmatter ?? {})) {
    fm.set(key, serializeScalar(value));
  }
  if (create.title !== undefined) {
    // Route the title through the SAME YAML-safe serializer (it is model-authored — an unsafe title
    // must not land as a raw frontmatter value; it formerly bypassed serialization).
    fm.set("title", serializeScalar(create.title));
  }
  // Security (13.8d ii, L9/L14): neutralize embedded region markers in the create body so a
  // content-embedded `kw:region`/`@generated`/`@user` marker can never forge/plant a region
  // boundary — region-AWARE, so a legit planner `renderGeneratedRegion` wrapper is preserved.
  return composeNote(fm, neutralizeNoteBody(create.body));
}

function applyFrontmatter(content: string, patch: FrontmatterPatch): string {
  const { frontmatter, body } = parseNote(content);
  frontmatter.set(patch.key, serializeScalar(patch.value));
  return composeNote(frontmatter, body);
}

function applyRegionPatch(content: string, patch: NotePatch): string {
  const { frontmatter, body } = parseNote(content);
  const open = `<!-- kw:region:${patch.regionId} -->`;
  const close = `<!-- /kw:region:${patch.regionId} -->`;
  // Security (13.8d ii / L9): neutralize embedded region markers in the patch inner body so a
  // `<!-- /kw:region:id -->` (or any family marker) in newBody can never prematurely close/forge a
  // region boundary — the create+patch pair both route content through the ONE neutralizer (L9).
  const region = `${open}\n${neutralizeRegionMarkers(patch.newBody)}\n${close}`;
  const start = body.indexOf(open);
  const end = body.indexOf(close);
  let nextBody: string;
  if (start !== -1 && end !== -1 && end > start) {
    nextBody = body.slice(0, start) + region + body.slice(end + close.length);
  } else {
    nextBody = body.length === 0 ? region : `${body}\n\n${region}`;
  }
  return composeNote(frontmatter, nextBody);
}

function applyLink(content: string, link: LinkMutation): string {
  const { frontmatter, body } = parseNote(content);
  const wikilink = `[[${link.dstSlug}]]`;
  if (link.op === "add") {
    if (body.includes(wikilink)) {
      return content;
    }
    const nextBody = body.length === 0 ? wikilink : `${body}\n${wikilink}`;
    return composeNote(frontmatter, nextBody);
  }
  // remove: strip every occurrence and tidy the whitespace it leaves behind.
  const nextBody = body
    .split("\n")
    .map((line) => line.replace(wikilink, "").replace(/[ \t]+$/u, ""))
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
  return composeNote(frontmatter, nextBody);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function diffChanges(
  snapshot: VaultSnapshot,
  projected: ReadonlyMap<string, string>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, content] of projected) {
    if (snapshot.get(path) !== content) {
      changes.push({ path, content });
    }
  }
  return changes;
}

/** Staging-token form of a revision id (strip the `rev:` prefix / non-word chars). */
function tokenOf(revisionId: RevisionId): string {
  return revisionId.replace(/[^a-zA-Z0-9]/gu, "");
}

function summarize(plan: KnowledgeMutationPlan, changedFiles: number): string {
  return (
    `revision-applied: ${changedFiles} file(s) changed; ` +
    `${plan.creates.length} create(s), ${plan.patches.length} patch(es), ` +
    `${plan.linkMutations.length} link(s), ${plan.frontmatterUpdates.length} frontmatter update(s)`
  );
}

/**
 * Does this plan ASK for any mutation? (24.77's discriminator.) Deliberately counts every declared
 * mutation kind `summarize` reports, so the two can never disagree about what "declares nothing"
 * means — a plan counted as empty here but non-empty there would re-open the contradiction.
 */
function planDeclaresMutations(plan: KnowledgeMutationPlan): boolean {
  return (
    plan.creates.length +
      plan.patches.length +
      plan.linkMutations.length +
      plan.frontmatterUpdates.length >
    0
  );
}

/**
 * 24.77 — the honest summary for "the vault already contains this plan's projected end state."
 * Deliberately does NOT begin `revision-applied:`, because nothing was applied by THIS call; that
 * prefix is what made the old row self-contradictory when paired with a non-zero declared count.
 * ⚠ AND DELIBERATELY NOT `already-applied:` EITHER (reviewer-caught): that would imply THIS PLAN was
 * applied earlier, which the guard CANNOT establish — byte-identical content may have been authored
 * by a human, by an Obsidian/iCloud sync, or by a different plan. `already-present:` is a claim about
 * the vault's STATE, which is exactly what was measured. Keeps the declared counts so the row still
 * says WHAT is already present rather than degrading into a bare "no-op".
 */
function summarizeAlreadyApplied(plan: KnowledgeMutationPlan): string {
  return (
    `already-present: 0 file(s) changed; the vault already contains this plan's projected end state — ` +
    `${plan.creates.length} create(s), ${plan.patches.length} patch(es), ` +
    `${plan.linkMutations.length} link(s), ${plan.frontmatterUpdates.length} frontmatter update(s)`
  );
}

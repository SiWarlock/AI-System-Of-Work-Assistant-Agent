// @sow/workflows — slice 7.14 ACTIVITY: verify EXPLICIT owner intent (REQ-F-013)
// and DERIVE the deletion plan FROM the verified intent + retention policy (REQ-F-018
// / RET-3 governance seam — the human-owned-preservation + derive-from-validated
// guard).
//
// These are ACTIVITIES, NOT workflow code — they run worker-side and MAY use
// node:crypto (via @sow/domain `buildIdempotencyKey`) to compute the plan + per-step
// idempotency keys that drive the driver's idempotent replay (inv-4). They implement
// {@link VerifyIntentPort} + {@link BuildDeletionPlanPort}.
//
// WHY THIS EXISTS (the governance fix, identical to the 7.6/7.7/7.12 lesson): the
// deletion PLAN is NEVER caller-supplied. If a caller could hand in the plan, it could
// (a) tombstone a HUMAN-OWNED region (REQ-F-018 / RET-3 theater) or (b) redirect the
// tombstone to another workspace (WS-2/WS-4 theater). By DERIVING the plan HERE, from
// the VerifiedIntent + the injected human-owned-region classifier + the retention
// policy:
//   • a human-owned region can NEVER enter the tombstone plan — the deriver
//     EXCLUDES it (and records it in `preservedRegions` as proof), and refuses the
//     whole deletion if EVERY region is human-owned (`human_owned_only`);
//   • `plan.workspaceId` is stamped from the intent's BOUND workspace, so the
//     tombstone can never target another workspace;
//   • a subject still inside its retention window is REFUSED (`retention_blocked`),
//     so automated pruning honors the RET-3 window (raw audio only after an audited
//     synthesis; other raw only after the configurable window).
//
// The preservation guard runs over the ACTUAL regions the deriver would tombstone —
// NOT a decoy descriptor field. The plan handed downstream contains ONLY the
// non-human-owned, prune-eligible regions, so the guard reads exactly what flows to
// the KnowledgeWriter commit.
//
// §16: returns a typed Result — never throws. A subject the deriver cannot make
// preservation-safe / retention-safe folds to a typed {@link BuildDeletionPlanFailure}
// the driver maps to plan_rejected with NO commit.
import { createHash } from "node:crypto";
import { ok, err, planId } from "@sow/contracts";
import type { Result, KnowledgeMutationPlan, SourceRef, NotePatch, ProvenanceOrigin } from "@sow/contracts";
import { buildIdempotencyKey } from "@sow/domain";
import type {
  VerifyIntentPort,
  VerifyIntentError,
  VerifiedIntent,
  DeletionSubject,
  BuildDeletionPlanPort,
  BuildDeletionPlanFailure,
  DerivedDeletionPlan,
  RetentionPolicy,
} from "../workflows/deletionSaga";

// ---------------------------------------------------------------------------
// (1) VerifyIntentPort activity
// ---------------------------------------------------------------------------

/**
 * A record of the explicit deletion intent the owner submitted. The activity checks
 * it is genuinely EXPLICIT + owner-authorized (REQ-F-013) — never inferred. `explicit`
 * MUST be true (an implicit request is rejected); `authorizedBy` MUST match the
 * subject's data owner (an unauthorized actor is rejected).
 */
export interface DeletionIntentRecord {
  /** True ONLY when the owner explicitly asked to delete (never an inferred flag). */
  readonly explicit: boolean;
  /** The actor who authorized the deletion (must be the data owner). */
  readonly authorizedBy: string;
}

/**
 * The pure authority check the verify activity is configured with: given the subject
 * + the submitted intent record, is the actor authorized to delete this subject? It is
 * PURE (no clock / I/O) and returns true/false; the activity turns a false into a
 * typed `intent_unauthorized`. Injected so the real @sow/policy owner-authority check
 * lands at the worker seam while the activity stays unit-testable.
 */
export interface OwnerAuthorityCheck {
  isAuthorized(subject: DeletionSubject, authorizedBy: string): boolean;
}

/** Injected deps for the verify-intent activity. */
export interface VerifyIntentActivityDeps {
  /** The submitted intent record (resolved at the worker seam from the trigger). */
  readonly intent: DeletionIntentRecord;
  /** The owner-authority check (real @sow/policy at the worker seam). */
  readonly authority: OwnerAuthorityCheck;
}

/**
 * Build a {@link VerifyIntentPort} that enforces the EXPLICIT owner-intent gate
 * (REQ-F-013 / inv-1). An implicit request (`explicit !== true`) fails closed with
 * `no_explicit_intent`; an unauthorized actor fails with `intent_unauthorized`. Only
 * an explicit, authorized intent produces a {@link VerifiedIntent}. Never throws.
 */
export function createVerifyIntentActivity(
  deps: VerifyIntentActivityDeps,
): VerifyIntentPort {
  return {
    verify(
      subject: DeletionSubject,
    ): Promise<Result<VerifiedIntent, VerifyIntentError>> {
      // REQ-F-013: an implicit / inferred deletion is REFUSED — no durable step.
      if (deps.intent.explicit !== true) {
        const failure: VerifyIntentError = {
          code: "no_explicit_intent",
          message: "REQ-F-013: deletion requires EXPLICIT owner intent (implicit request refused)",
        };
        return Promise.resolve(err(failure));
      }
      // The actor must be authorized over this subject/workspace.
      if (!deps.authority.isAuthorized(subject, deps.intent.authorizedBy)) {
        const failure: VerifyIntentError = {
          code: "intent_unauthorized",
          message: `deletion actor '${deps.intent.authorizedBy}' is not authorized to delete this subject`,
        };
        return Promise.resolve(err(failure));
      }
      const verified: VerifiedIntent = {
        verified: true,
        subject,
        authorizedBy: deps.intent.authorizedBy,
      };
      return Promise.resolve(ok(verified));
    },
  };
}

// ---------------------------------------------------------------------------
// (2) BuildDeletionPlanPort activity
// ---------------------------------------------------------------------------

/**
 * A candidate Markdown region of the deletion subject the deriver considers. `regionId`
 * is the named region (KN-8 region-bounded); `humanOwned` marks a region a human
 * authored/owns (REQ-F-018 — NEVER pruned by automation); `contentClass` classifies
 * it for retention (e.g. "raw_audio" / "raw" / "derived"); `path` is the note the
 * region lives in.
 */
export interface SubjectRegion {
  readonly path: string;
  readonly regionId: string;
  readonly humanOwned: boolean;
  readonly contentClass: string;
  /**
   * A deterministic identity of the region's CURRENT LIVE body — the hash of exactly
   * what is being DELETED. Supplied by the {@link SubjectRegionSource}, which enumerates
   * regions from the live Markdown, so a re-materialized region under the SAME
   * `regionId` (new live content) yields a DIFFERENT `contentHash`. This is the
   * load-bearing input to the content discriminator (see
   * {@link computeContentDiscriminator}): a tombstone patch always sets `newBody = ""`,
   * so the discriminator MUST fold in this live-content identity — NOT the empty
   * tombstone body — to distinguish a same-region-id/different-content re-deletion from
   * a crash-replay of identical content.
   */
  readonly contentHash: string;
  /** True IFF an audited synthesis over this subject's raw audio already exists (RET-3). */
  readonly auditedSynthesisExists?: boolean;
  /** Age of the region's content in days (drives the configurable-window check). */
  readonly ageDays?: number;
}

/**
 * The pure projection the buildPlan activity is configured with: it enumerates the
 * subject's Markdown regions (the automated + human-owned regions). It is PURE (no
 * clock / I/O) and receives ONLY the verified subject, so it can never surface a
 * caller-injected region set. The activity applies the human-owned + retention filter
 * over what it returns.
 */
export interface SubjectRegionSource {
  regions(intent: VerifiedIntent): readonly SubjectRegion[];
}

/**
 * Injected deps for the buildPlan activity: the pure {@link SubjectRegionSource}, the
 * SourceRef the tombstone plan cites (REQ-F-006: ≥1 sourceRef — the evidence the
 * deletion was authorized from, i.e. the intent audit ref), and the plan-identity seed
 * (→ a stable planId + per-step keys, so the derived plan + downstream steps replay to
 * the SAME keys across restarts — inv-4). `provenanceOrigin` classifies the plan
 * (defaults `human`, the Flow-7 owner-authorized-deletion origin — the deletion was
 * explicitly authorized by the data owner, REQ-F-013).
 */
export interface BuildDeletionPlanActivityDeps {
  readonly regionSource: SubjectRegionSource;
  /** REQ-F-006: the evidence the deletion was authorized from (the intent audit ref). */
  readonly sourceRef: SourceRef;
  readonly provenanceOrigin?: ProvenanceOrigin;
}

/**
 * True IFF a region is PRUNE-ELIGIBLE under the retention policy (RET-3). Raw audio is
 * eligible only once an audited synthesis exists; other raw content only after the
 * configurable window; derived content is always eligible. Human-owned is handled
 * SEPARATELY (never pruned) — this predicate is only the retention-window gate.
 */
function isRetentionEligible(region: SubjectRegion, retention: RetentionPolicy): boolean {
  if (region.contentClass === "raw_audio") {
    // Raw audio: only after an audited synthesis (RET-3 default). If the policy does
    // not require it, fall through to the window check.
    if (retention.rawAudioRequiresAuditedSynthesis) {
      return region.auditedSynthesisExists === true;
    }
  }
  if (region.contentClass === "raw" || region.contentClass === "raw_audio") {
    // Other raw content: only after the configurable window (default 30d).
    return (region.ageDays ?? 0) >= retention.rawRetentionDays;
  }
  // Derived semantic content is prune-eligible without a window (the tombstone
  // supersedes it; human-owned derived notes are still excluded by the humanOwned gate).
  return true;
}

/**
 * Compute a deterministic CONTENT DISCRIMINATOR over the derived deletion content —
 * the CURRENT LIVE CONTENT of the region set that will ACTUALLY be tombstoned. This is
 * the load-bearing fix for the content-blindness finding.
 *
 * FIRST-FIX GAP (what this repairs): the discriminator hashed each tombstone PATCH as
 * `[path, regionId, newBody]`, but a tombstone patch ALWAYS sets `newBody = ""`. So the
 * discriminator was a pure function of the {path, regionId} region-ID SET only — BLIND
 * to the actual live content of the regions being deleted. Two deletions of the SAME
 * {path, regionId} after the subject was re-materialized (same region id, NEW live
 * content C2) produced the SAME discriminator → SAME planId + purgeKey. Because the
 * tombstone/purge ports are idempotent BY key, run #2 REPLAYED run #1's revision (C2
 * was never tombstoned) and the purge no-op'd (the re-indexed GBrain entry survived) —
 * yet the saga reported `deleted`. The first fix only caught region-SET changes.
 *
 * THE FIX: hash each ELIGIBLE region by `[path, regionId, contentHash]` — the region's
 * CURRENT live-content identity (see {@link SubjectRegion.contentHash}), NOT the
 * hard-coded empty tombstone body. Result: identical live content → identical
 * discriminator → identical keys → correct idempotent replay (crash-mid-saga retry
 * stays safe); DIFFERENT live content under the SAME region id → DIFFERENT
 * discriminator → DIFFERENT planId + purgeKey → the tombstone AND purge RE-RUN (region
 * C2 is tombstoned; the re-indexed GBrain entry is purged) — no survival, no
 * resurrection, no silent discard.
 *
 * The hash is order-INDEPENDENT + replay-STABLE: each region is canonicalized to its
 * (path, regionId, contentHash) identity, the set is SORTED, and the sorted,
 * JSON-encoded preimage is SHA-256'd. `node:crypto` is permitted here (this is an
 * ACTIVITY, not the pure driver). Note: `input.run.idempotencyKey` is DELIBERATELY NOT
 * folded in — that would break a legitimate re-run's dedupe; the content discriminator
 * is the sole scoping the finding calls for.
 */
function computeContentDiscriminator(regions: readonly SubjectRegion[]): string {
  const canonical = regions
    .map((r) => [r.path, r.regionId, r.contentHash] as const)
    .sort((a, b) => {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
      return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0;
    });
  const preimage = JSON.stringify(canonical);
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

/**
 * Build a {@link BuildDeletionPlanPort} that DERIVES the tombstone plan from the
 * verified intent + retention policy (inv-2 / REQ-F-018 / RET-3). It:
 *   • partitions the subject's regions into human-owned (PRESERVED — never in the
 *     plan) vs automated;
 *   • refuses the deletion if EVERY region is human-owned (`human_owned_only`);
 *   • drops automated regions still inside their retention window, and refuses if
 *     NOTHING is prune-eligible after the window filter (`retention_blocked`);
 *   • builds a region-bounded tombstone NotePatch per prune-eligible region, stamps
 *     `plan.workspaceId` from the BOUND workspace, and computes the per-step
 *     idempotency keys via the §8 key builder (node:crypto) so replay is a no-op.
 * Never throws.
 */
export function createBuildDeletionPlanActivity(
  deps: BuildDeletionPlanActivityDeps,
): BuildDeletionPlanPort {
  return {
    build(
      intent: VerifiedIntent,
      retention: RetentionPolicy,
    ): Promise<Result<DerivedDeletionPlan, BuildDeletionPlanFailure>> {
      const workspaceId = intent.subject.workspaceId;
      const regions = deps.regionSource.regions(intent);

      // inv-2 / REQ-F-018: partition human-owned (PRESERVED) vs automated. Human-owned
      // regions are NEVER pruned — they are recorded in `preservedRegions` as proof
      // and EXCLUDED from the plan entirely.
      const humanOwned = regions.filter((r) => r.humanOwned);
      const automated = regions.filter((r) => !r.humanOwned);
      const preservedRegions = humanOwned.map((r) => r.regionId);

      // If EVERY region is human-owned there is nothing the automated saga may prune —
      // refuse the whole deletion (never a partial human-owned prune).
      if (automated.length === 0 && regions.length > 0) {
        const failure: BuildDeletionPlanFailure = {
          code: "human_owned_only",
          message: "REQ-F-018/RET-3: every region is human-owned — automated pruning refused (preserved, not deleted)",
        };
        return Promise.resolve(err(failure));
      }

      // Retention filter (RET-3): drop automated regions still inside their window.
      const eligible = automated.filter((r) => isRetentionEligible(r, retention));
      if (eligible.length === 0) {
        // Nothing is prune-eligible yet — the subject is still inside its retention
        // window. Refuse (never prune inside the window).
        const failure: BuildDeletionPlanFailure = {
          code: "retention_blocked",
          message: "RET-3: subject still inside its retention window (raw audio needs audited synthesis; other raw needs the window)",
        };
        return Promise.resolve(err(failure));
      }

      // Region-bounded tombstone: replace each prune-eligible region's body with the
      // tombstone marker (KN-8: named-region patch, never a free-form file edit).
      // Human-owned regions are provably absent (they are not in `eligible`).
      const patches: NotePatch[] = eligible.map((r) => ({
        path: r.path,
        regionId: r.regionId,
        newBody: "",
      }));

      // Stable planId + per-step keys: derived from the subject identity BOUND to the
      // workspace, PLUS a CONTENT DISCRIMINATOR over the CURRENT LIVE CONTENT of the
      // eligible region set (each region's contentHash — NOT the empty tombstone body),
      // so a re-drive over IDENTICAL live content replays to the SAME keys (inv-4) while
      // a LEGITIMATELY-different derived plan (regions added/removed, OR the SAME region
      // id re-materialized with new live content) produces DIFFERENT keys — no silent
      // discard of a changed patch set, no resurrected GBrain entry. A different
      // workspace can never share a key.
      const contentDiscriminator = computeContentDiscriminator(eligible);
      const identity = {
        subject: intent.subject.subjectRef,
        workspace: String(workspaceId),
        content: contentDiscriminator,
      };
      const planKey = buildIdempotencyKey({ operation: "deletion.tombstone.plan", identity });
      const purgeKey = buildIdempotencyKey({ operation: "deletion.gbrain.purge", identity });
      const eventTombstoneKey = buildIdempotencyKey({ operation: "deletion.event.tombstone", identity });
      const reconcileKey = buildIdempotencyKey({ operation: "deletion.refs.reconcile", identity });

      const plan: KnowledgeMutationPlan = {
        planId: planId(planKey),
        // WS-2/WS-4: the tombstone targets the BOUND workspace, never a caller value.
        workspaceId,
        // REQ-F-006: the tombstone cites the evidence the deletion was authorized from.
        sourceRefs: [deps.sourceRef],
        creates: [],
        // The ONLY mutations are region-bounded tombstones of prune-eligible,
        // non-human-owned regions.
        patches,
        linkMutations: [],
        frontmatterUpdates: [],
        externalActionProposals: [],
        confidence: 1,
        requiresApproval: false,
        provenanceOrigin: deps.provenanceOrigin ?? "human",
      };

      const derived: DerivedDeletionPlan = {
        plan,
        preservedRegions,
        contentDiscriminator,
        purgeKey,
        eventTombstoneKey,
        reconcileKey,
      };
      return Promise.resolve(ok(derived));
    },
  };
}

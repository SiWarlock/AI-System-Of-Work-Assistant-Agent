// @sow/workflows — task 7.19 ACTIVITY: the retention-prune SELECTION decision
// (RET-3 / REQ-F-018 / §16.4).
//
// This is an ACTIVITY (the {@link PrunePolicyPort} implementation), NOT the pure driver.
// It enumerates candidate assistant-held records through an injected pure
// {@link PrunableRecordSource} (the real adapter reads the operational store; only real
// producer today is `SourceDispositionRow.sourceEnvelope.body`, so the concrete binding is
// thin/deferred to §19.12) and partitions them into the DUE set vs the deliberately-
// RETAINED set under the retention policy.
//
// WHY THIS EXISTS (the governance seam, identical to the 7.14 deletionPlan lesson): the
// prune decision is NEVER caller-supplied. By DERIVING selection HERE — from the record set
// + the injected retention policy + the clock reading — an externally-authoritative link
// (§10.1), a human-owned/derived note (RET-3), an undispositioned parked source (re-entry
// guard), or a record still inside its retention window is provably never in the due set.
//
// The retention predicate mirrors the 7.14 `isRetentionEligible` (deletionPlan.ts): raw
// audio is eligible only once an audited synthesis exists (RET-3), other raw content only
// after the configurable window (default 30d). Derived semantic content is NEVER pruned by
// the automated retention sweep (distinct from the owner-INTENT-driven 7.14 deletion, which
// may tombstone derived regions) — retention pruning removes raw assistant-held capture
// while preserving the derived synthesis + human content.
//
// §16: returns a typed Result — never throws.
import { ok } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { RetentionPolicy } from "../workflows/deletionSaga";
import type {
  PrunableRecord,
  PrunePolicyPort,
  PruneSelectionRequest,
  PruneSelection,
  PruneSkip,
  PruneSkipReason,
  PrunePolicyError,
} from "../workflows/retentionPrune";

const DAY_MS = 86_400_000;

/**
 * The pure projection the prune-policy activity is configured with: it enumerates the
 * candidate assistant-held records for the request's workspace. PURE (no clock of its own —
 * the request carries the clock reading) — the real adapter reads the operational store; a
 * test injects a fake. The activity applies the RET-3 exclusion + window filter over what it
 * returns.
 */
export interface PrunableRecordSource {
  candidates(request: PruneSelectionRequest): readonly PrunableRecord[];
}

/** Injected deps for the prune-policy activity. */
export interface PrunePolicyActivityDeps {
  readonly source: PrunableRecordSource;
}

/** Whole-day age of `capturedAt` relative to `now`. Absent/malformed/negative ⇒ 0 (fail-safe: not eligible). */
function ageDays(capturedAt: string | undefined, now: string): number {
  if (capturedAt === undefined) return 0;
  const captured = Date.parse(capturedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(captured) || !Number.isFinite(current) || current <= captured) return 0;
  return Math.floor((current - captured) / DAY_MS);
}

/**
 * Classify a candidate: `undefined` ⇒ DUE for prune; a {@link PruneSkipReason} ⇒ retained.
 * The exclusions run BEFORE the window predicate so a human-owned / derived / external /
 * parked / already-pruned record is provably never window-eligible (RET-3 / §10.1). Only
 * raw + raw_audio content is prune-eligible; an unknown class fails safe (not pruned).
 */
function skipReason(
  r: PrunableRecord,
  retention: RetentionPolicy,
  now: string,
): PruneSkipReason | undefined {
  // The most-specific "never touch" reasons take precedence over the generic
  // not-assistant-held check (an external link / human-owned region is, by nature, not an
  // assistant-held copy — but §10.1 / RET-3 is the meaningful retain reason to surface).
  // §10.1: externally-authoritative sources are kept as LINKS — never re-stored or pruned.
  if (r.externallyAuthoritative === true) return "externally_authoritative";
  // RET-3: human-owned content is NEVER pruned by automation.
  if (r.humanOwned === true) return "human_owned";
  // RET-3: derived semantic notes are preserved (retention pruning removes RAW capture only).
  if (r.contentClass === "derived") return "derived_note";
  // Prune touches assistant-held copies ONLY.
  if (r.assistantHeld !== true) return "not_assistant_held";
  // Re-entry guard: an undispositioned parked source is still needed for triage re-entry.
  if (r.dispositionState === "queued_for_review") return "undispositioned_parked";
  // Idempotence: an already-pruned record is a no-op on a re-run.
  if (r.alreadyPruned === true) return "already_pruned";

  if (r.contentClass === "raw_audio") {
    // RET-3 (Q1): raw audio uses the audited-synthesis predicate, NOT the window. If the
    // policy does not require it, fall through to the window check.
    if (retention.rawAudioRequiresAuditedSynthesis) {
      return r.auditedSynthesisExists === true ? undefined : "inside_window";
    }
    return ageDays(r.capturedAt, now) >= retention.rawRetentionDays ? undefined : "inside_window";
  }
  if (r.contentClass === "raw") {
    // Other raw content: prune-eligible only after the configurable window (default 30d).
    return ageDays(r.capturedAt, now) >= retention.rawRetentionDays ? undefined : "inside_window";
  }
  // Unknown content class: fail-safe — do NOT prune.
  return "unknown_class";
}

/**
 * Build a {@link PrunePolicyPort} that SELECTS the due assistant-held records under the
 * retention policy (RET-3 / REQ-F-018). It partitions the injected candidate set into the
 * DUE set (window-eligible, non-excluded) and the SKIPPED set (each with its retain reason
 * — proof the guard ran over the real records, not a decoy). Never throws.
 */
export function createPrunePolicyActivity(deps: PrunePolicyActivityDeps): PrunePolicyPort {
  return {
    select(request: PruneSelectionRequest): Promise<Result<PruneSelection, PrunePolicyError>> {
      const candidates = deps.source.candidates(request);
      const due: PrunableRecord[] = [];
      const skipped: PruneSkip[] = [];
      for (const r of candidates) {
        const reason = skipReason(r, request.retention, request.now);
        if (reason === undefined) due.push(r);
        else skipped.push({ recordId: r.recordId, reason });
      }
      return Promise.resolve(ok({ due, skipped }));
    },
  };
}

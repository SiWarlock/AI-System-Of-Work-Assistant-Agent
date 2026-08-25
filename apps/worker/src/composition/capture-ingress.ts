// 13.6 / 24.22 — "capture as I work" INGRESS (worker composition root): the two TRUSTED local
// triggers wired to a real ingestion dispatch. `buildCaptureSource` (§13.6 PROTOTYPE, G4) and its
// 23.6 git-hook siblings (`buildCodingSessionCapture`, `createRepoWorkspaceResolver`,
// `createCodingSessionOriginVerifier`) have existed with ZERO consumers in `apps/worker/src` —
// VERIFIED with two positive controls: `dispatchMeetingCloseout` (a real consumer, for contrast)
// returns hits at `apps/worker/src/temporal/dispatchMeetingCloseout.ts:57`, and `buildCaptureSource`
// itself (`packages/integrations/src/connectors/adapters/capture-source.ts:95`) returns zero
// `apps/worker/src` hits repo-wide. This module is the first consumer.
//
// ⛔ SCOPE — ONLY the two TRUSTED triggers named in the plan:
//   1. captureGitCommit  — a local git post-commit hook invocation.
//   2. captureSessionEnd — a loopback-API session-end hook invocation (Claude Code's own
//      session-end lifecycle, posted to the local loopback API — never a network peer).
// The `/capture` command and the Telegram bot are §ARM-23 ARMING and are OUT OF SCOPE — this module
// never builds a `TelegramCapture` (its `isAllowedTelegramSender` binding below is a permanent deny,
// defense-in-depth: even if a future caller mistakenly reached this ingress with telegram-shaped
// input, `buildCaptureSource` would refuse it before any dispatch).
//
// BOTH triggers reuse the SAME `GitHookEvent` fact shape + the SAME `buildCodingSessionCapture`
// mapper — a "session end" is, from this module's perspective, just another instant at which the
// repo's current git state (HEAD commit + accumulated diff shape) is worth capturing; inventing a
// SEPARATE capture-building path for it would duplicate `buildCodingSessionCapture`'s reviewed,
// no-inference-safe digesting logic (subject/changedFileCount/insertions/deletions — never raw diff
// content or file names, §16) for no behavioral difference. The two entry points differ only in
// their `WorkflowTrigger` tag (observability / audit) — never in how a capture is built or gated.
//
// 24.22 — `routingHints.trustLevel` (STAMPED by `buildCaptureSource` from the injected
// `verifyCodingSessionOrigin`, capture-source.ts:115,132) is the genuinely-unread channel the plan
// named (NOT `AgentJob.trustLevel`, which IS read — at `packages/policy/src/admission.ts:33`; the
// plan's Files line should be corrected to `capture-source.ts:115,132`, a doc fix, not a code one).
// This module is its REAL CONSUMER: a capture built through EITHER of these two TRUSTED-labeled
// triggers whose `trustLevel` comes back anything other than `"trusted"` (the sanctioned
// `createCodingSessionOriginVerifier` refuses an unknown repo OR an unverified commit — 24.14) is
// surfaced as a DISTINCT `origin_unverified` outcome and is NEVER dispatched — a "trusted trigger"
// that failed its own trust check is not silently treated as if it had passed. This does NOT touch
// the fail-safe `"untrusted"` default `apps/worker/src/composition/source-extraction.ts` stamps on
// every EXTRACTION `AgentJob` regardless of envelope (ING-7 / safety rule 6) — that posture is
// UNCHANGED and stays the extraction-admission layer's own concern, not this ingress's.
//
// Candidate-data gate (safety rule 2): every capture routes THROUGH `buildCaptureSource` (emit-only)
// THEN `registerSource` (the schema/Zod gate + Flow-4 contentHash dedupe) BEFORE any dispatch — never
// around it. WS-2/WS-8: `workspaceId` is resolved from the STATIC repo→workspace map (never inferred
// from event content) and fails CLOSED (`repo_unmapped`) on an unknown repo. PURE over injected
// deps + the two @sow/integrations pure builders — no child_process, no real fs, no clock; never
// throws (§16).
import { ok, err, type Result } from "@sow/contracts";
import { workflowId as brandWorkflowId } from "@sow/contracts";
import { registerSource } from "@sow/integrations";
import type { RegisterSourceInput } from "@sow/integrations";
import { buildCaptureSource } from "@sow/integrations/connectors/adapters/capture-source";
import type { CaptureDeps, CodingSessionCapture } from "@sow/integrations/connectors/adapters/capture-source";
import {
  buildCodingSessionCapture,
  createRepoWorkspaceResolver,
} from "@sow/integrations/connectors/adapters/coding-session-capture";
import type { GitHookEvent, CaptureBuildError } from "@sow/integrations/connectors/adapters/coding-session-capture";
import type { SourceIngestionInput } from "@sow/workflows";
import type { DispatchOutcome, DispatchError } from "../temporal/dispatchSourceIngestion";

/** One repo→workspace binding (the "repo→workspace map" the plan names). Fed to
 *  `createRepoWorkspaceResolver` (23.6) — matching is exact-segment, lexically-normalized,
 *  fail-closed on anything not listed (never a prefix/substring guess). */
export interface CaptureRepoBinding {
  readonly repoPath: string;
  readonly workspaceId: string;
}

/** Injected deps for the capture ingress. */
export interface CaptureIngressDeps {
  readonly repoWorkspaceMap: readonly CaptureRepoBinding[];
  /** 24.14 — the sanctioned `verifyCodingSessionOrigin` binding (built by
   *  `createCodingSessionOriginVerifier`, or an equivalent real verifier). REQUIRED, no
   *  permissive default — mirrors `capture-source.ts`'s own no-default posture. */
  readonly verifyCodingSessionOrigin: CaptureDeps["verifyCodingSessionOrigin"];
  /** Policy-bound sensitivity applied to every capture this ingress builds (arch_gap: the
   *  sensitivity taxonomy is unspecified upstream — capture-source.ts's own comment — so this
   *  stays a single caller-supplied value rather than an invented per-repo taxonomy). */
  readonly sensitivity: string;
  /** The Flow-4 dedupe probe `registerSource` consults (a real store backs it; a fake in tests). */
  readonly registerDeps: { readonly seenContentHash: (contentHash: string) => Promise<boolean> };
  /** The C3a dispatch entry, pre-bound to a Temporal Client (or degraded ⇒ fail-closed), the SAME
   *  shape `connectorIngestionBridge.ts`'s `ConnectorIngestionDispatch` uses. */
  readonly dispatch: (input: SourceIngestionInput) => Promise<Result<DispatchOutcome, DispatchError>>;
  /** Observer for every capture outcome (logging / test assertion). Faults swallowed (§16). */
  readonly onCapture?: (outcome: CaptureIngressOutcome, sourceId: string) => void;
}

/** A typed, redaction-safe outcome for the optional observer (never a raw payload/diff/file name). */
export type CaptureIngressOutcome =
  | { readonly kind: "dispatched"; readonly workflowId: string; readonly deduped: boolean }
  | { readonly kind: "dedupe_hit" }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "repo_unmapped" }
  /** 24.22 — a designated-TRUSTED trigger whose origin verification did NOT come back trusted
   *  (unknown repo, or an unverified commit). Never silently treated as verified; never dispatched. */
  | { readonly kind: "origin_unverified" };

export type CaptureIngressError = { readonly code: "dispatch_failed"; readonly cause: DispatchError["code"] };

export interface CaptureIngress {
  captureGitCommit(event: GitHookEvent): Promise<Result<CaptureIngressOutcome, CaptureIngressError>>;
  captureSessionEnd(event: GitHookEvent): Promise<Result<CaptureIngressOutcome, CaptureIngressError>>;
}

const TELEGRAM_NEVER_ALLOWED: CaptureDeps["isAllowedTelegramSender"] = () => false;

/**
 * Build the capture ingress over the two trusted local triggers. Both entry points run the SAME
 * pipeline (`buildCodingSessionCapture` → resolve repo→workspace → `buildCaptureSource` → 24.22's
 * trust check → `registerSource` → dispatch), differing only in the `WorkflowTrigger` tag their
 * dispatched run carries. Never throws (§16); every fault is a typed outcome/err.
 */
export function createCaptureIngress(deps: CaptureIngressDeps): CaptureIngress {
  const resolveWorkspace = createRepoWorkspaceResolver(
    deps.repoWorkspaceMap.map((b) => ({ repoPath: b.repoPath, workspaceId: b.workspaceId })),
  );
  const captureDeps: CaptureDeps = {
    isAllowedTelegramSender: TELEGRAM_NEVER_ALLOWED,
    verifyCodingSessionOrigin: deps.verifyCodingSessionOrigin,
  };

  const observe = (outcome: CaptureIngressOutcome, sourceId: string): void => {
    try {
      deps.onCapture?.(outcome, sourceId);
    } catch {
      /* an observer fault must never break the ingress (§16). */
    }
  };

  const runCapture = async (
    event: GitHookEvent,
  ): Promise<Result<CaptureIngressOutcome, CaptureIngressError>> => {
    const built = buildCodingSessionCapture(event);
    if (!built.ok) {
      const outcome: CaptureIngressOutcome = { kind: "rejected", message: built.error.message };
      observe(outcome, `git:unresolved:${event.repoPath}`);
      return ok(outcome);
    }
    const capture: CodingSessionCapture = built.value;

    const resolved = resolveWorkspace(capture.repo);
    if (!resolved.ok) {
      const outcome: CaptureIngressOutcome = { kind: "repo_unmapped" };
      observe(outcome, `git:unmapped:${capture.repo}`);
      return ok(outcome);
    }
    const workspaceId = resolved.value;
    // Deterministic per-commit identity (WS-8: derived from the BOUND workspace + the repo/commit —
    // never invented, never a nonce) so the SAME commit re-observed by either trigger is the SAME
    // candidate sourceId, independent of `registerSource`'s own contentHash dedupe.
    const sourceId = `git:${workspaceId}:${capture.repo}:${capture.commit ?? "uncommitted"}`;

    const source = buildCaptureSource(
      { sourceId, workspaceId, sensitivity: deps.sensitivity, capture },
      captureDeps,
    );
    if (!source.ok) {
      const outcome: CaptureIngressOutcome = { kind: "rejected", message: source.error.message };
      observe(outcome, sourceId);
      return ok(outcome);
    }
    const candidate: RegisterSourceInput = source.value;

    // 24.22 — the REAL consumer: a designated-TRUSTED trigger whose stamped trustLevel is not
    // "trusted" is surfaced distinctly and NEVER dispatched. Read once, from the built candidate's
    // OWN routingHints (never re-derived) so this can never disagree with what `buildCaptureSource`
    // actually stamped.
    if (candidate.routingHints["trustLevel"] !== "trusted") {
      const outcome: CaptureIngressOutcome = { kind: "origin_unverified" };
      observe(outcome, sourceId);
      return ok(outcome);
    }

    const registered = await registerSource(candidate, deps.registerDeps);
    if (registered.outcome === "rejected") {
      const outcome: CaptureIngressOutcome = { kind: "rejected", message: registered.message };
      observe(outcome, sourceId);
      return ok(outcome);
    }
    if (registered.outcome === "dedupe_hit") {
      const outcome: CaptureIngressOutcome = { kind: "dedupe_hit" };
      observe(outcome, sourceId);
      return ok(outcome);
    }

    // Content-versioned dispatch key (Lesson 16/34): the SAME contentHash re-observed dedupes at
    // the Temporal workflowId, independent of `sourceId`.
    const key = `src:${workspaceId}:${registered.envelope.contentHash}`;
    const ingestion: SourceIngestionInput = {
      run: {
        workflowId: brandWorkflowId(key),
        // "owner_action" (the closed §9 WorkflowRunRef.trigger taxonomy, operational.ts) — a LOCAL,
        // human-initiated event (a commit/session-end on the OPERATOR's own machine), never a
        // connector poll ("connector_event"), a cron ("schedule"), or Hermes automation.
        trigger: "owner_action",
        idempotencyKey: key,
        workspaceId,
      },
      context: { source: registered.envelope, envelopes: [] },
    };

    const dispatched = await deps.dispatch(ingestion);
    if (!dispatched.ok) {
      observe({ kind: "rejected", message: `dispatch failed: ${dispatched.error.code}` }, sourceId);
      return err({ code: "dispatch_failed", cause: dispatched.error.code });
    }
    const outcome: CaptureIngressOutcome = {
      kind: "dispatched",
      workflowId: dispatched.value.workflowId,
      deduped: dispatched.value.deduped,
    };
    observe(outcome, sourceId);
    return ok(outcome);
  };

  return {
    captureGitCommit: (event) => runCapture(event),
    captureSessionEnd: (event) => runCapture(event),
  };
}

export type { CaptureBuildError };

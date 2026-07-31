# 139 — worker: three slices — 9.41 leg B audit-drill resolver, 13.8g-B attendee threading, 13.8i PROPOSE-tier §9.8 Approvals ⚠SAFETY

**Date:** 2026-07-31
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/138-2026-07-30-worker-three-slices-egress-notice-corruption-surfacing-meeting-keystone.md`
**Successor session:** `docs/sessions/144-2026-07-31-meeting-sibling-plans-and-13.8i-b-premise-defect.md`

---

## Why this session existed

Fresh respawn continuing doc 138's queue: 9.41 leg B (head of queue, unblocks desktop's leg C) → 9.37(b) (folded as a rider into 13.8g-B) → 13.8g-B → 13.8i (re-scoped ahead of 13.8f-C, which it unblocks). All four items landed. The third slice (13.8i) is the one worth reading closely — it's a §9.8 Approvals-gate safety slice with a mid-slice finding that reshaped its own scope, and it's the reason this doc exists as `139` rather than folding into a lighter recap.

---

## What was built

### 9.41 leg B — the audit drill-down resolver (worker)

**Files modified:**
- `apps/worker/src/api/projections/recentChanges.ts` — `deriveChangeId` exported (was module-private); `RECENT_CHANGES_AUDIT_SCAN_BOUND` relocated here from `recentChangesProducer.ts` (Step-2.5 TWEAK, avoids a 2-file module import cycle since the producer already imports this file for `deriveChangeId`).
- `apps/worker/src/api/procedures/queries.ts` — `AuditDrillInput`/`parseAuditDrillInput`, `resolveAuditDrillDown` (mirrors `resolveGlobalDrillDown`'s fetch-then-match shape over a hashed identity instead of a field-equality tuple), `auditEvents` on `ReadModelQueryPort`, the `auditDrill` query procedure.
- `apps/worker/src/api/adapters/readModel.ts` — `DbReadModelQueryDeps` gains `audit: AuditRepository`; real `auditEvents` implementation, gated by `resolveKnownWorkspace` (a code-quality-review fix — my first draft skipped this gate citing the wrong precedent).
- `apps/worker/src/boot.ts` — threads `audit: backends.repos.audit`.
- `apps/worker/src/composition/recentChangesProducer.ts` — imports the relocated constant instead of defining it.
- 9 files got one-line mechanical `auditEvents`/`audit:` stub additions to keep typechecking — 7 of these were **not** on the brief's own file list and were found only via full-graph `tsc`, not the brief's grep-based estimate.

**Commit:** `aa949ee70a4ef2f1b85fee0236a4353b98e60c95`.

### 13.8g-B — carry meeting attendees into the living-vault rewrite, + 9.37(b) rider

**Files modified:**
- `packages/workflows/src/ports/meetingCloseout.ts` — `MeetingVaultRewritePort.rewrite` gains additive-optional `attendees?: unknown`.
- `packages/workflows/src/activities/buildOutputs.ts` — passes `frontmatterValue(validated.fields["attendees"])` through unexamined (the workflows layer must not import `@sow/knowledge`).
- `apps/worker/src/composition/meeting-vault.ts` — calls `normalizeAttendees` (13.8g-A, already shipped), populates `entityRefs`/`identifierOnlyRefs`; corrects a docstring that wrongly claimed entity refs come "from correlation signals" (structurally impossible — correlate runs before extraction).
- `apps/worker/src/api/projections/ingestionInboxProjection.ts` — 9.37(b) rider: header corrected from a stale "Ships DORMANT" claim to describe the wiring 9.16 already bound live.

**Mid-slice finding, resolved before GREEN:** the real, production-wired meeting-extraction schema gate (`apps/worker/src/composition/meeting-extraction.ts`'s `isPrimitiveOrTbd`) admits only `string | number | boolean | "TBD"` — an array can never reach a validated extraction. `normalizeAttendees` requires `Array.isArray`. So the wiring is correct but **yields zero refs today** against any realistic (scalar) attendee value. Escalated the fork (split a delimited string here, vs. widen the normalizer's own contract in `packages/knowledge`) rather than picking; orchestrator ruled **ship the mechanical wiring, pin the inertness with an explicit characterization test, track the real fix as its own task** — **13.8g-C** (`f9a67093`), deliberately two-sided (scalar-only-gate-plus-convention vs. widen-the-gate), not pre-decided.

**Commit:** `661a720cf42c0134c1ec29355df23c59307a493e`.

### 13.8i — route the withheld PROPOSE tier into §9.8 Approvals + fix the batch-undo unit ⚠SAFETY

**Files modified:**
- `packages/workflows/src/ports/sourceIngestion.ts` — new `ProposeKnowledgeApprovalPort`/`ProposeKnowledgeApprovalResult`/`ProposeKnowledgeApprovalError` (closed `mint_failed` code only); `SourceIngestionDeps.proposeKnowledgeApproval?` (optional, mirrors `livingVault`'s own optionality); `SourceIngestionOutcome.livingVaultPlanIds` (required).
- `packages/workflows/src/workflows/sourceIngestion.ts` — the withhold branch (step 7b) now attempts a mint via the injected port, on ANY outcome (unbound / throws / err / ok) ends in an unconditional `continue`, and surfaces one of two mutually-exclusive health items; `livingVaultPlanIds` accumulates only after a commit succeeds.
- `apps/worker/src/composition/living-vault.ts` — `createProposeKnowledgeApprovalPort`, a thin wrapper reusing the existing `CopilotKnowledgeProposeSink` verbatim.

**Commit:** `a7d4ae9dd45351a0d4fc86964b1ec9862e8db8a3` (one commit, not two — see "Decisions made").

#### Why the withhold branch is unconditional-continue (for 13.8f-C's author, and whoever arms this next)

The failure direction this slice was built to protect is: **nothing about routing to Approvals may make it easier for a `requiresApproval !== false` plan to reach `deps.commit.commit(...)`.** The mint attempt is therefore structured so that *every* branch of `if (livingVaultPlan.requiresApproval !== false) { ... }` ends in `continue`, with no exception:

```
port unbound            → proposed = undefined → health-surface(mint_failed-ish) → continue
port throws (sync/async) → caught, proposed = undefined → same → continue
port resolves err(...)   → isOk false → health-surface with .error.code → continue
port resolves ok(...)    → queuedForApproval += 1 → continue
```

The `continue` is not inside any of those four sub-branches individually — it is the **last statement of the outer `if` block**, after the mint attempt regardless of its outcome. This is deliberate: a mint failure must never be tempting to "recover" by falling through to commit (the safe direction is always "stays withheld, operator told" — see the brief's own explicit statement of the failure direction that matters). `deps.commit.commit(livingVaultPlan)` sits textually and control-flow-wise **only** in the code path that exits the `if` without hitting `continue` — i.e. only for `requiresApproval === false` plans.

This was **mutation-verified two ways**, not merely asserted:
1. Relaxing the strict `!== false` check to a truthy check (`if (livingVaultPlan.requiresApproval)`) reds `unknown_approval_flag_fails_closed` (an absent flag becomes falsy and wrongly auto-commits) — but does **not** red `a_propose_tier_plan_never_reaches_commit` (an explicit `true` stays truthy either way). This is the exact vacuity gap the brief's Step-2.5 ADD anticipated: the absent-flag fixture is *what makes that specific mutation discriminate at all*.
2. Inverting the check to `=== false` reds `a_propose_tier_plan_never_reaches_commit` directly (the propose-tier plan's id shows up in the committed set).

Both mutations were reverted; `git diff --stat` confirmed no leftover both times. Both results are documented **in the test file itself** (not only in a chat transcript), specifically to survive past this session.

#### The committed-only planIds reasoning (why this is NOT `receipt.planIds` forwarded verbatim)

The task's own wording said "restore `IngestRewriteReceipt.planIds` through the worker seam that drops it" — implying: widen `SourceLivingVaultPort.rewrite`'s return shape to also carry the producer's `receipt.planIds` field through. I did **not** do that. Three reasons, in order of how much weight they should carry (per the orchestrator's own sharpening — reason 3 is the load-bearing one, 1 and 2 are secondary):

1. `receipt.planIds` is *definitionally* `plans.map(p => p.planId)` (`packages/knowledge/src/synthesis/ingest-rewrite.ts:157`) — zero information beyond what `plans` already carries.
2. Widening the port's return shape would have forced every one of the 7 pre-existing tests in `source-living-vault-binding.test.ts` to change (`SpyLivingVaultPort.rewrite` returns a bare array today; an object-shaped Ok value breaks `.push(...rewritten.value)` and every fake construction) — a large blast radius for a field carrying no new information.
3. **Semantically, "the one-action batch-undo unit" (`ingest-rewrite.ts`'s own doc: "the worker binding maps each planId → its CommittedRevision") means what actually committed, not what the producer merely emitted.** A withheld PROPOSE plan produces no revision — including its id in "the batch to undo" would be wrong, not just redundant, once §9.8 routing exists as an alternative outcome for that plan. **This is the sharper framing the orchestrator gave it: 13.8d's own tier split silently made `receipt.planIds` diverge from the committed set the moment it shipped, and nobody noticed because nothing consumed the field yet.** The task's wording was written when every emitted plan committed; the split changed what the concept means and the wording never caught up. Forwarding it verbatim now would have been a correct-looking fix that is actually wrong.

So `SourceIngestionOutcome.livingVaultPlanIds` is accumulated **locally**, inside the existing step-7b loop, pushed only in the `else` branch of `if (!isOk(extra))` — i.e. only immediately after `deps.commit.commit` returns `ok` for an AUTO-tier plan. Zero port/type widening; zero existing-test breakage; the property is *more* correct than the literal ask.

**⚠ Known drift this created, not yet closed:** `packages/contracts/LESSONS.md#40` states in plain language that the producer's `planIds` list "IS the one-action batch-undo unit" — that claim is now superseded by the reasoning above and was never amended to say so (code-quality review caught this; routed to the orchestrator, not mine to edit).

---

## Decisions made

- **9.41 leg B — TWEAK accepted:** relocate `RECENT_CHANGES_AUDIT_SCAN_BOUND` to `recentChanges.ts` rather than importing it from `recentChangesProducer.ts` (which would have created a 2-file module cycle).
- **9.41 leg B — the real `auditEvents` adapter gets the same `resolveKnownWorkspace` fail-closed gate every sibling method in `readModel.ts` has**, closing a code-quality medium finding (my first draft cited the wrong precedent).
- **13.8g-B — Q1/Q3 sharpened, both adopted verbatim by the orchestrator into the doc comments:** the security property `entityRefs`'s doc protects is *independence-from-the-synthesizing-call* (not literally "no model anywhere"), and `MAX_ENTITY_REFS` vs `MAX_MODEL_ENTITY_REFS` stay separate (different threat shapes, per worker L88).
- **13.8g-B — `withheld` dropped deliberately**, in-code note naming 13.8m as the eventual consumer; no new channel minted with nobody reading it (L106).
- **13.8i — reuse `copilotProposeKnowledgeSink` in place, no extraction** — the WORKER composition root gets a thin adapter (`createProposeKnowledgeApprovalPort`); `packages/workflows` gets only a pure, closed-error-vocabulary port type. Matches "reuse it, never a second sink" to the letter.
- **13.8i — idempotency inherits an unverified-but-shared assumption, disclosed rather than silently absorbed:** `plan.planId`'s stability across a re-drive cannot be verified from source today (no real `newPlanId()` binding exists anywhere — the whole living-vault leg is dormant). Relied on it anyway because the AUTO-tier commit path this slice does not touch already makes the identical assumption (`CommitKnowledgePort`'s own doc comment: "IDEMPOTENT by plan's idempotencyKey"). This is a 13.8d **arming-time** gap affecting both tiers symmetrically, not a risk 13.8i introduces — routed to the lead as a one-line note for wherever the living-vault armer will meet it.
- **13.8i — one commit, not two.** The brief's safety-critical rule wants (a) [Approvals routing] and (b) [planIds fix] in separate commits. Checked the actual diff: both concerns share the withhold loop's `if/else` and all 3 `SourceIngestionOutcome` return sites in `sourceIngestion.ts` — genuinely one contiguous hunk, not safely separable without interactive `git add -p`. Orchestrator's own escape hatch ("if they don't split cleanly, say so and take (a) whole") applied; shipped as one commit with a merged message covering both.

## Decisions explicitly NOT made

- **9.41 leg B — no renderer caller was built by this slice** (leg C, desktop, was already tracked separately — and has since landed, per the task list, closing that loop).
- **13.8g-B — the actual fix for the attendees-shape inertness was NOT decided.** 13.8g-C is deliberately two-sided (delimited-string convention parsed by the normalizer alone, vs. widening the meeting-extraction schema gate to admit arrays of scalars) and explicitly forbids being settled inside a wiring slice.
- **13.8i — no composition-root binding was added for `ProposeKnowledgeApprovalPort`.** `apps/worker/src/boot.ts`/`buildActivities.ts`/`temporal/workflows.ts` have zero construction sites for it (confirmed by the security reviewer via grep). Even if the separately-gated `livingVault` leg were armed, a PROPOSE plan today degrades to the unbound/health-surfaced path, never a live Approval card. This is intentional — the brief's own Step 7.5 said to ship "behind the same existing dormancy" — but it means "completes 13.8d's tier split" should not be read as "is live end-to-end." A composition-root wiring slice (activity + workflow-wrapper binding) is the real remaining follow-up, same shape as the still-open 13.8f-D.
- **13.8i — `packages/contracts/LESSONS.md#40` was NOT amended**, though it's now superseded (see above). Contracts territory; flagged to the orchestrator, not edited here.

## TDD compliance

Clean across all three slices. Every test confirmed RED for the right reason before implementation. Two disclosed non-standard-RED cases, both intentional and both handled per this project's established discipline rather than skipped:
- 9.41 leg B's structural pin (`resolveAuditDrillDown_reuses_the_single_sourced_derivechangeid`) had no natural RED (queries.ts never had `createHash` to regress from) — mutation-verified instead (temporarily inserted the literal string, confirmed the test failed, reverted).
- 13.8i's `a_propose_tier_plan_never_reaches_commit` — mutation-verified twice, documented in this session (see above).

No TDD violations. No safety-critical work shipped without a pin proven to fail.

## Reachability

- **9.41 leg B (`auditDrill`)** — `bootWorker` → `createDbReadModelQueryPort({...,audit})` (real, wired) → `server.ts:127` `buildQueryRouter({readModel,...})` → `appRouter.query.auditDrill`. Resolvable at the authenticated tRPC boundary. Leg C (desktop's Recent Changes drill affordance) is the consumer — landed this same round, per the task list.
- **13.8g-B (attendee threading)** — dormant by both flag (`gateMeetingVaultRewrite` strict `=== true`) and absence (no `MeetingRewriteDeps` construction), unchanged from 13.8f-B. The 9.37(b) rider's wiring was already live pre-existing (9.16); this slice only corrected the header describing it.
- **13.8i (§9.8 routing)** — `runSourceIngestion` step 7b is already reachable (not a new entry point); the NEW mint-routing code inside it is real, but `deps.proposeKnowledgeApproval` has no production binding — confirmed zero construction sites in `boot.ts`/`buildActivities.ts`/`temporal/workflows.ts`. ⛔ **This slice builds the mechanism and leaves the binding — do not read the subject line "route the PROPOSE tier into §9.8 Approvals" as "PROPOSE plans now reach Approvals." They do not, and would not even if the living-vault leg were armed, because arming and binding are two separate, independent absences.** What shipped: the routing mechanism, the fail-closed withhold (mutation-verified), and the pins. A composition-root wiring slice (**13.8i-B**, numbered by the orchestrator) is required before any PROPOSE plan reaches a human — tracked, not a silent gap (both reviewers confirmed the absence explicitly).

## Open follow-ups

1. **13.8g-C** (`f9a67093`) — decide how attendee strings actually reach `normalizeAttendees` given the real extraction schema gate admits only scalars. Two-sided; not pre-decided.
2. **A composition-root binding for `ProposeKnowledgeApprovalPort`** — needs numbering (flagged to the orchestrator at Step 9; same shape as 13.8f-D, an arming-time wiring follow-up, not a 13.8i defect).
3. **`packages/contracts/LESSONS.md#40`** needs amending or a cross-reference — its "the producer's planIds list IS the batch-undo unit" claim is superseded by 13.8i's committed-only semantics. Contracts/orchestrator territory.
4. **The `newPlanId()` stability question** (13.8d arming-time, affects AUTO and PROPOSE symmetrically) — routed to the lead per the orchestrator's instruction; not a 13.8i risk, but whoever arms living-vault needs to either verify it or design around it before going live.
5. **13.8f-C** is now unblocked (13.8i landed) — next in queue per the plan, sequenced with-or-after 13.8i as already established.

## How this was built

Three `/tdd` cycles. 13.8g-B and 13.8i each needed a Step-2.5 design-scoping exchange before proceeding (13.8g-B: the attendees-shape finding, escalated mid-slice rather than silently absorbed or unilaterally fixed; 13.8i: Q3's planIds deviation, flagged explicitly and accepted). Mandatory security + code-quality reviewers ran on all three; 13.8i's security review was mandatory-by-safety-posture (not just policy) and came back 0 critical/high after tracing all four withhold-branch outcomes by hand. One reviewer dispatch hit a transient API 529 mid-session (both Agent calls for 13.8i's Step 8 failed simultaneously) — work on disk was unaffected (verified via `git diff --stat` + a live `grep` for mutation leftovers before resuming), and both reviews were retried and completed rather than skipped or self-substituted, per the orchestrator's explicit pre-statement that "reviewers unavailable" must never be recorded as equivalent to "reviewers clean."

**Reviewer independence (asked explicitly by the lead, via the orchestrator):** both the security-reviewer and code-quality-reviewer for 13.8i were dispatched from THIS session (via the `Agent` tool, by this implementer), not by the orchestrator, which dispatched zero reviewer agents this round. The 529/model-unavailable errors hit two of my own dispatch attempts (the first parallel pair, and a solo retry of the security-reviewer specifically); both eventually ran to completion from this session and their output above is what's reported. This is full independence, not a reduced-independence substitute — the Step-8 obligation is discharged at full weight.

**On the contracts L40 supersession** (routed to the orchestrator, now amended per their reply): the divergence between L40's "the receipt's `planIds` list IS the batch-undo unit" and this slice's committed-only semantics had existed since 13.8d itself — the tier split silently changed what "the batch to undo" means the moment a plan could be withheld rather than always committed. Nobody noticed for the same reason a field with no reader never gets checked against the lesson describing it: nothing consumed `planIds` until this slice, so the divergence had no occasion to surface. The lesson wasn't wrong when written; the code moved and the lesson didn't move with it.

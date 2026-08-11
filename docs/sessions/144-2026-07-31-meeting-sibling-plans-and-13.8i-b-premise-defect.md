# 144 — worker: 13.8f-C shipped (meeting-path sibling entity-page plans); 13.8i-B stopped at Step 1 on a false brief premise ⚠SAFETY-adjacent

**Date:** 2026-07-31
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/139-2026-07-31-audit-drill-attendee-threading-propose-tier-approvals.md`
**Successor session:** `docs/sessions/150-2026-08-11-propose-approval-binding-and-cross-workspace-ceiling-gate.md`

---

## Why this session existed

Dispatched mid-round (predecessor cycled at 89% after three slices) to continue the queue: 13.8f-C (brief 239, precondition 13.8i confirmed landed) → 13.8i-B (brief 241). The first slice shipped clean. The second stopped at its own hard-line guard, before Step 1 — the brief's central premise ("wrap the existing sink") did not survive contact with the code, and rebuilding it in place rather than assuming it is the substance of this session.

---

## What was built

### 13.8f-C — commit sibling entity-page plans on the meeting path

**Files modified (10):**
- `packages/workflows/src/ports/meetingCloseout.ts` — `MeetingVaultRewriteResult` widens to carry `plans` (previously structurally forbidden); `MeetingBuiltOutputs` gains `siblingPlans` + optional `meetingVaultRewriteFault?: "rewrite_threw"`; added a shared-type header note naming all three construction sites (meeting-closeout, source-ingestion, hermes-automation) so a future widening's blast radius is stated, not rediscovered.
- `packages/workflows/src/activities/buildOutputs.ts` — carries `plans`/the fault signal out of the meeting-vault rewrite call, without committing them.
- `packages/workflows/src/workflows/meetingCloseout.ts` — new step 5b: commits AUTO-tier siblings through the existing `CommitKnowledgePort` after the meeting note's own commit; PROPOSE-tier siblings withheld and routed to a §9.8 Approval via 13.8i's `ProposeKnowledgeApprovalPort`, reused directly (not re-declared); `livingVaultPlanIds` accumulates commit-success only, mirroring 13.8i's ruling; imports `commitFailureClass` from `sourceIngestion.ts` (exported there, one shared taxonomy) instead of a second copy.
- `packages/workflows/src/workflows/sourceIngestion.ts` — one-line: `export` added to `commitFailureClass`. Zero logic change (security-reviewer confirmed byte-identical switch body).
- `apps/worker/src/composition/meeting-vault.ts` — stops discarding `receipt.plans`; forwards it alongside `meetingNoteLinkMutations`.
- `apps/worker/src/composition/buildActivities.ts` — the source-path binding (a different, pre-existing construction site of the now-shared `MeetingBuiltOutputs` type) gets a byte-equivalent `siblingPlans: []` — the source path's own sibling mechanism (`deps.livingVault`) is unrelated and untouched.
- Test files: `apps/worker/test/composition/meeting-vault.test.ts`, `packages/workflows/test/{meeting-activities,meeting-closeout,support/meeting-fakes}.test.ts`.

**Commit:** `8199a61ff17dab467880304d3e03f81947fbd426`.

**Companion mechanical fix (separate commit, cross-track, orchestrator-authorized):** `packages/evals/suites/hermes-standalone/hermes-gateway-routing.test.ts` — one-line `siblingPlans: []` added to its fake `buildOutputs`, the third construction site the full-graph typecheck surfaced. Landed as its own commit (`08340160bcc690fb6a846fd4023ef7106919680b`) per contracts **L121**'s ruling (a shared-type widening's own compile-break in another area is part of the change, not a crossing) — pathspec-limited, message names the upstream slice, zero eval-security logic touched.

**Tests:** 9 new + 4 extended/replaced (renamed one whose old assertion — "structurally cannot carry plans" — this slice deliberately makes false). Full-package runs (not just touched files): `@sow/workflows` 601/601, `@sow/worker` 2063/2102 (39 skipped, unrelated), `@sow/knowledge` 672/673 (1 skipped, unrelated) — confirms the dormancy pins (`no_production_caller` etc.) by RUNNING, not reasoning.

**Reviews:** security-reviewer (mandatory, invariant-touching) — **0 findings**, explicit PASS on all 6 checks (withhold predicate, propose-port degrade uniformity, no candidate-data leak in health messages, commit ordering / no partial-commit hazard, no-second-writer + no groundedPaths/refusals leak, commitFailureClass export is zero-logic-change). code-quality-reviewer — 2 findings, both resolved in-slice: [low] unnecessary `as unknown as {...}` test casts removed; [medium, per orchestrator's stronger rationale] `livingVaultRewriteFault` renamed to `meetingVaultRewriteFault` repo-wide (5 files, confirmed via `grep -rn` including a stale comment I'd have missed — orchestrator's own catch, banked as their L93 self-note) — the `livingVault` prefix implied a source-path counterpart that doesn't exist, unlike `livingVaultPlanIds` which genuinely mirrors a real source-path field.

**Mutation-verified** the load-bearing safety pin both directions: inverted `!== false`→`=== false` reds `a_propose_tier_sibling_never_reaches_commit` (+3 collateral); relaxed to truthy reds only `an_absent_flag_sibling_is_withheld_AND_minted`, confirming the absent-flag fixture is what makes that mutation discriminate — mirroring 13.8i's own documented result exactly. Both reverted, confirmed via `grep -n` on live code, not only `git diff --stat`.

**Reachability:** `runMeetingCloseout` has a real production call site (`apps/worker/src/temporal/workflows.ts:300`, inside `meetingCloseoutWorkflow`). Scoped claim: "sibling entity-page plans commit on the meeting path; the leg remains dormant" — the whole feature is dormant by absence (`meetingVaultRewrite`/`proposeKnowledgeApproval` both unbound at the composition root), not by an unreachable code path.

**Ticked by the orchestrator:** `IMPLEMENTATION_PLAN.md` (commit `07b16c3d`) — 13.8f-C ticked, 13.8f-D closed (the silent-degrade finding this slice's `meetingVaultRewriteFault` signal discharges).

---

### 13.8i-B — bind `ProposeKnowledgeApprovalPort` on both paths: STOPPED at Step 1, zero code written

**No files changed.** This is the session's other half, and it is a Finding + a resolved premise-verification, not an implementation.

**What happened, in order:**
1. Dispatched against brief `docs/briefs/241-…` v1 (`@effb6c9b`), which asserted the slice was "wrap the existing sink with the existing factory once, thread it to both deps objects" — a 2-file composition slice.
2. Per the brief's own hard-line guard ("if binding alone could mint a live Approval card, or completing this requires flipping an arming flag — STOP before Step 1, don't assume the premise, establish it"), I verified rather than assumed. Traced `boot.ts:1756`'s cited `knowledgeProposeSink` and found it **unreachable as described**: nested inside `agentSynthesisFactory` (`boot.ts:1735-1839`), a lazy factory for an unrelated Copilot-chat feature (§13.10a/C5.3), gated on `copilotRealModel && copilotAgentMode`, only constructed per-ask when invoked. Repo-wide grep confirmed one call site, this one. Also traced the actual cross-sandbox threading precedent (`livingVault`, per `apps/worker/src/temporal/workflows.ts:436-443`'s own comment: "the delegate is ALWAYS bound because the sandbox cannot read boot config; the ARMING decision lives in the ACTIVITY") — the real shape is 3 layers (new `ProofSpineParams` field → new always-bound Temporal activity → both workflows in `temporal/workflows.ts`), not 2.
3. Sent this as a Finding. The orchestrator independently verified all three claims from source and routed to the lead. **Upheld in full** — one sub-claim of mine corrected in the process (`buildAutoIngestProofSpineParams` DOES have a production caller, `apps/desktop/worker-host/index.ts:234`; my grep had scoped to `apps/worker`+`packages` and missed `apps/desktop` — the same "not in my area" → "does not exist" shape banked as contracts **L93**, now recorded as its own instance).
4. Brief rewritten as v2 (`@03cd449e`, commit `9d6bc19b`), citing **contracts L59** as the governing precedent and naming the premise failure as **contracts L122** ("an unresolved premise must not be written as a premise" — v1 had asked "is `boot.ts:1756` conditionally scoped?" in its own Step-2.5 section while asserting the sink "already exists," which is the tell). v2 confirms: my option (a) — a fresh sink object over the same repos, wrapped by the existing factory — is approved (the "never a second sink" wording was aimed at the wrong noun: it forbids a second *minting path*, not a second *object*); NOT an arming crossing (recorded as the guard working, not being waived); 3 items left explicitly UNVERIFIED for the next reader to establish rather than assume.
5. I then independently resolved all three of v2's own UNVERIFIED items (dispatched a research pass + spot-checked its key claims myself, per contracts **L81** — don't trust a subagent's or a brief's claim without checking): confirmed `buildAutoIngestProofSpineParams` (`boot.ts:1215`) is the sole live `ProofSpineParams` constructor (`registerWorker.ts`'s own same-named function is dead code, zero callers anywhere); confirmed the meeting path's *rewrite* leg has no separate Temporal activity (it's embedded in the existing `meetingBuildOutputs` activity, per my own 13.8f-C work) while the *propose* leg needs its own new activity per path, mirroring the `meetingCommit`/`sourceCommit` "separate name per path even for identical delegation" convention; confirmed the exact registration template (`createLivingVaultActivity`, `living-vault.ts:222-233` — a pure factory returning the port's own safe-identity value when unarmed). Sent this to the orchestrator with one open design question (whether the new activity's unarmed branch reuses the existing closed `"mint_failed"` error code or needs a distinguishing one) and held for a go-ahead.
6. Before that landed, the orchestrator sent a team-wide **STOP — do not start 13.8i-B, cycle down for a machine restart, go straight to `/session-end`.** This message may have crossed with my premise-verification report in flight. Complied immediately: zero code was ever written for 13.8i-B, so nothing was lost by stopping, and starting a 3-layer composition-root slice minutes before a teardown was correctly judged worse than holding.

**Bottom line:** 13.8i-B is fully re-scoped and ready to dispatch to the next worker-implementer. Everything needed is committed (brief 241 v2, contracts L59/L93/L121/L122) — plus my own follow-up resolution of the three items v2 still marked UNVERIFIED, captured below since it exists only in a chat message right now (contracts **L51**: durable close-out debt goes in a file).

---

## Decisions made

- **13.8f-C: reuse 13.8i's `ProposeKnowledgeApprovalPort` directly** (not a meeting-path analog) — one propose sink, one mechanism, per the brief's own default vote and mirroring precedent.
- **13.8f-C: export `commitFailureClass` from `sourceIngestion.ts` rather than duplicate it** — chose a same-directory sibling import over a new shared module, since `ports/*.ts` must stay types-only and `runtime/*.ts` is mechanism-infra, not failure-taxonomy; the function is a pure switch, no purity/sandbox violation.
- **13.8f-C: `meetingVaultRewriteFault` is a NEW signal, not the brief's own list** — necessary because the meeting path's rewrite call lives inside the buildOutputs *activity* (not the workflow, unlike the source path), so the workflow has no visibility into a throw there without a signal crossing that boundary. Flagged as a possible side-effect closure of 13.8f-D at Step 2.5; confirmed and the orchestrator closed 13.8f-D on it.
- **13.8i-B: stop before Step 1 rather than build past an established lesson (L59) the brief itself didn't cite** — the hard-line guard was written for a *permission* hazard (owner authorization) and caught a *premise* defect instead; cheap because it fired before any RED was written.

## Decisions explicitly NOT made

- **13.8i-B's exact activity-registration shape is proposed, not yet ruled on** — my premise-verification report proposed two new activities (`sourceProposeKnowledgeApproval`/`meetingProposeKnowledgeApproval`) sharing one port instance, plus inline construction in `buildAutoIngestProofSpineParams` (vs. a third `with*` post-processor wrapper like `withDurableRevisions`). Not confirmed by the orchestrator before the team cycled down.
- **13.8i-B's unarmed-error-code question is open** — reuse the existing closed `"mint_failed"` code for "never bound" (my default vote — no consumer needs the distinction today, would be a fresh L106 capability-not-guarantee), or widen the enum to distinguish "unbound" from "sink genuinely rejected." Needs Step-2.5 sign-off before Step 4.
- **Whether `boot.ts`'s two post-processor wrappers (`withDurableRevisions`, `withSubscriptionExtractionArming`) are the right home for a third `proposeKnowledgeApproval` binding, vs. inline in `buildAutoIngestProofSpineParams`** — deferred; I lean inline (the port has no arming gate of its own, so a whole wrapper function for an unconditional merge seems like unneeded indirection) but didn't get confirmation.

## TDD compliance

**13.8f-C: clean.** RED written and confirmed failing for the right reason (10 assertion mismatches in `packages/workflows`, 1 in `apps/worker`) before any implementation. GREEN confirmed after. Load-bearing pin mutation-verified both directions post-GREEN, per protocol. No violations.

**Hermes fixture fix (`08340160`):** not new behavior — a mechanical type-conformance fix to an existing, already-tested fixture (the file's 11 pre-existing tests exercise real hermes-gateway-routing behavior; my one-line change only supplies the newly-required field with a byte-equivalent empty default). Verified by re-running the existing suite (11/11 green, unchanged) + `tsc --noEmit` clean. No new RED owed — nothing new to pin.

**13.8i-B: N/A — zero code written.** Stopped at Step 1, before any test or implementation existed.

## Cross-doc invariant audit

Checked every model in `packages/contracts/CLAUDE.md`'s Cross-doc invariants table (29 frozen Appendix-A models) against this session's changes. **None touched.** `MeetingVaultRewriteResult`/`MeetingBuiltOutputs`/`MeetingCloseoutOutcome`/`MeetingCloseoutDeps` are all port-internal or workflow-internal types — 13.8f-B's own established precedent ("new port types are port-internal, absent from `ARCHITECTURE.md` and the cross-doc table ⇒ no snapshot owed"), confirmed at Step 9 and not contested by review. `KnowledgeMutationPlan` (an Appendix-A model) was *used*, not modified. No violation; no doc edit owed.

## Reachability

- **13.8f-C:** `runMeetingCloseout` ← `meetingCloseoutWorkflow` ← real Temporal registration (`apps/worker/src/temporal/workflows.ts:300`). Confirmed at Step 7.5, unchanged since (no later slice this session touched that file).
- **13.8i-B:** N/A — nothing built.

## Open follow-ups

1. **13.8i-B is the primary handoff.** Brief 241 v2 (`docs/briefs/241-…`, `@03cd449e`) is current and ready. **In addition to v2's own three UNVERIFIED items, the next worker-implementer should read this session's "What happened" §13.8i-B step 5 above** — I resolved all three with file:line evidence (sole `ProofSpineParams` constructor confirmed at `boot.ts:1215`; the meeting path's asymmetric activity shape — rewrite embedded in `meetingBuildOutputs`, propose needs its own new activity per path; the `createLivingVaultActivity` template at `living-vault.ts:222-233`) — but **this resolution was never confirmed by the orchestrator** before the team cycled down. Treat it as a strong candidate, not a ruling — re-verify or get sign-off before building on it.
2. **One open design question for 13.8i-B, unresolved:** does the new propose-approval activity's unarmed branch reuse the existing closed `ProposeKnowledgeApprovalErrorCode = "mint_failed"`, or does the enum need widening to distinguish "never bound" from "sink genuinely rejected"? My default vote is reuse (no consumer needs the distinction; widening would be an unowed capability, L106's shape) — needs a Step-2.5-equivalent sign-off.
3. **13.8i-B's activity-registration shape is proposed, not ruled on:** two new activities (`sourceProposeKnowledgeApproval`/`meetingProposeKnowledgeApproval`, mirroring the `meetingCommit`/`sourceCommit` per-path-naming convention) sharing one port instance; inline construction in `buildAutoIngestProofSpineParams` rather than a third `with*` post-processor. Confirm at Step 1/2.5 rather than assuming.
4. **13.8i-B blocks the living-vault arming crossing** (§ARM-RESEARCH), which itself is sequenced after task 24.6 (the pre-go-live safety audit, in progress per the orchestrator's own fan-out — task #17 on the shared list as of this session).
5. Nothing outstanding from 13.8f-C's own Step 9 — the naming nit, the shared-type doc note, and the Cross-doc invariant check were all routed and closed within this session (see "What was built" above); no carry-forward there.

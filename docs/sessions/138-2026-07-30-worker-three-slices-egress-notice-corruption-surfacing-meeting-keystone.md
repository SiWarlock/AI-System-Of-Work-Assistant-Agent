# 138 — worker: three slices — 9.38 corruption surfacing, 9.27 egress-notice fail-open closed, 13.8f-B the meeting keystone

**Date:** 2026-07-30
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/134-2026-07-29-workspace-read-boundary-regate.md`
**Successor session:** `docs/sessions/139-2026-07-31-audit-drill-attendee-threading-propose-tier-approvals.md`

---

## Why this session existed

Fresh respawn after the prior team's full teardown (handoff 019). Carry-forward queue was #38/9.37(b)/9.38/§DEC-CANDGATE-leg-3, but two of those dissolved on inspection before dispatch (§DEC-CANDGATE leg 3 had zero real import sites; #38 turned out to be a finding closeable by a pin, not new code) — the orchestrator scoped and dispatched three real slices instead: **9.38** (System Health corruption surfacing, closing #38 as a rider), **9.27** (rule-5 egress-notice fail-open), and **13.8f-B** (the meeting-closeout keystone). 9.37(b) did not get dispatched this session — it's still queued.

---

## What was built

### 9.38 — surface the stored-row corruption code to System Health (+ the #38 pin)

**Files modified:**
- `apps/worker/src/boot.ts` — `createSystemHealthQueryPort`'s `egressStatus` now mints a System-Health item on `stored_row_schema_violation` (keyed-upsert on `subjectRef`, code-only per rule 7), while its RETURNED posture stays byte-identical to `failClosedEgress` on every branch (absent/corrupt/outage). New `WORKSPACE_CONFIG_CORRUPTION_AUDIT_REF` constant.

**Files created:**
- `apps/worker/test/composition/systemHealthCorruptionSurfacing.test.ts` — 6 tests (distinguishable-from-absent, distinguishable-from-outage, fail-closed-unchanged across 3 branches, no-policy-content-leak with two planted markers incl. one inside `egressPolicy` itself, no-unbounded-accumulation-on-repeat-poll).
- `apps/worker/test/composition/egressRevoke-read-gate.test.ts` — 2 tests closing the long-open `#38` finding: a non-vacuity control (an ungated fake repo lets the same corrupt fixture pass silently) + the real pin (the same fixture over the REAL dual-store adapter surfaces `stored_row_schema_violation`). Test-only; `egressRevoke.ts` already handled this correctly.

**Commits:** `abf648c6` (9.38) · `64b682e5` (the #38 pin, separate for bisectability).

### 9.27 — the Employer-Work egress notice cannot be omitted (rule-5)

**Files modified:**
- `apps/worker/src/api/procedures/copilot.ts` — `toUiSafeCopilotAnswer`'s optional `egressProcessor?: string` replaced by a required `EgressNotice = {kind:"none"} | {kind:"processor", value:string}`. The one production call site converts the still-optional `EgressDecision.egressProcessor` into the union inline. Wire format (`UiSafeCopilotAnswer.egressProcessor` staying optional) is unchanged — only the authoring requirement.
- `apps/worker/test/api/procedures/copilot.test.ts` — 6 mechanical call-site updates + 4 new tests (`notice_cannot_be_omitted`, `declining_is_explicit_and_distinct_from_forgetting`, `declined_notice_yields_no_key`, and an absent-direction end-to-end mirror of the existing present-direction test — employer-work + ack ON + LOCAL route ⇒ no notice, isolating the `:496` conversion as a single-variable comparison).
- `packages/evals/test/conformance/copilot-governance.test.ts` — exactly the 2 owner-authorized lines, `isErr`/`isOk` assertions unchanged in meaning.

**Commit:** `c7a1e21a`.

### 13.8f-B — give `rewriteVaultForMeeting` its first (gated, dormant) worker call site

**Files modified:**
- `apps/worker/src/boot.ts` — new `gateMeetingVaultRewrite` (byte-mirror of `gateLivingVaultRewrite`'s shape), `meetingVaultRewrite?: boolean` on `BootConfig`.
- `apps/worker/src/composition/buildActivities.ts` — `ProofSpineParams` gains `meetingVault?: MeetingVaultRewritePort`, threaded into `createBuildOutputsActivity`.
- `packages/workflows/src/activities/buildOutputs.ts` — `BuildOutputsActivityDeps` gains optional `meetingVaultRewrite?: MeetingVaultRewritePort`; `build()` calls it (reusing the already-computed `notePath`, never re-deriving) and folds `meetingNoteLinkMutations` into `linkMutations` at the old `:242`. `frontmatterUpdates: []` stays untouched and unread from the result.
- `packages/workflows/src/ports/meetingCloseout.ts` — new `MeetingVaultRewritePort`/`MeetingVaultRewriteResult` (additive; `MeetingBuiltOutputs`/`BuildOutputsPort` untouched — no cross-doc invariant).
- `packages/workflows/test/meeting-activities.test.ts` — a new fixture with a concrete title (the pre-existing `validatedFixture()` has none, so `notePath` is always `null` there — would have made the new tests pass vacuously) + 4 new tests.

**Files created:**
- `apps/worker/src/composition/meeting-vault.ts` — `createMeetingVaultPort`, the real adapter over `rewriteVaultForMeeting` (read-only import; nothing in `packages/knowledge/src/**` touched). Carries `dormancy-waiver(13.8f-B): ...`. No realpath-containment layer, deliberately — see "Decisions made."
- `apps/worker/test/composition/meeting-vault.test.ts` — 2 tests (input-threading, output-narrowing) mocking `@sow/knowledge` at the module boundary (the underlying function is already extensively tested in `packages/knowledge`).
- `apps/worker/test/boot-meeting-vault-gating.test.ts` — 3 tests mirroring `boot-living-vault-gating.test.ts` exactly.

**Commit:** `9afc2eaf`.

---

## Decisions made

- **9.38 — mint inline in `egressStatus`'s own corrupt branch, not deferred to a `healthItems()` query.** Deferring would reproduce the task's own defect one layer out (corruption surfaces only if someone thinks to look at a different surface).
- **9.38 — reused the existing `schema_rejection` `FailureClass`** rather than adding a new enum member, keeping the slice worker-only (no `packages/contracts` touch).
- **9.27 — `EgressNotice` discriminated union over a required `string | null`.** `null` is what a caller reaches for reflexively, so "genuinely needs no notice" and "didn't think about it" would collapse into one token again (9.24's three-meanings-of-absence). A named `{kind:"none"}` cannot be typed by accident.
- **9.27 — no reason field on the decline; compile pin as primary verification, mutation-verified by hand** (three separate mutations — widen the param optional, add `| undefined` to the union, add `| null` — each confirmed exactly one `@ts-expect-error` directive flipped to "unused," proving the three pins are independent rather than one double-counted).
- **13.8f-B — Q1 resolved to the narrowest possible cut**, smaller than either proposal I raised: the rewrite call lives entirely inside `createBuildOutputsActivity`'s `build()` via an optional constructor dep — no `packages/workflows/src/workflows/meetingCloseout.ts` touch, no `BuildOutputsPort` signature change. The partial-commit hazard is specifically about *committing* sibling plans, never about *calling* the rewrite (which is pure, no durable write).
- **13.8f-B — no realpath-containment layer in `meeting-vault.ts`**, unlike its sibling `living-vault.ts`. `meetingNoteLinkMutations`' `srcPath` is, by construction, always the meeting note itself (`meeting-rewrite.ts:272`'s hard `===` gate) — never synthesized — and `dstSlug` is never treated as a raw filesystem path anywhere in the precedent (`living-vault.ts`'s own `touchedPaths()` never reads it; confirmed independently by the security reviewer against `writer.ts`).
- **13.8f-B — dormant stated as BOTH by-absence and by-flag**, in `living-vault.ts`'s own voice: `gateMeetingVaultRewrite` requires strict `=== true`, but nothing in `bootWorker` constructs the real `MeetingRewriteDeps` either.

## Decisions explicitly NOT made

- **9.38 — the outage-still-invisible gap is not fixed.** A thrown/transient store fault still mints no health item, so "no item" continues to conflate *healthy* with *outage*. Not worsened, not fixed here — there is no reliable outage signal to key on without risking a false corruption report (trading a true-positive guarantee for a false-positive risk).
- **13.8f-B — `receipt.plans` (sibling person/project entity-page KMPs) are NOT committed this slice.** Deferred to **13.8f-C** (already split out and tracked by the orchestrator, `c7c35122`), sequenced **with or after 13.8i** (never before) — the `requiresApproval !== false` filter a sibling-commit loop needs *is* the AUTO/PROPOSE split at the §9.8 Approvals boundary, which is 13.8i's territory. My own partial-commit reasoning (traced from `packages/workflows/src/workflows/sourceIngestion.ts:472-549`'s precedent + this codebase's own stated invariant *"buildOutputs runs BEFORE any durable write"*) is recorded on `#### 13.8f` in the plan — **whoever picks up 13.8f-C and puts the sibling-commit loop inside the activity instead of the workflow reintroduces the exact hazard this reasoning exists to prevent.**
- **13.8f-B — `refusals`/`groundedPaths` are not threaded through `MeetingVaultRewriteResult` at all.** Adding them with no consumer yet would mint a fresh L106 capability-not-guarantee — the exact defect 13.8m exists to close. 13.8m's own work is therefore "widen the result type + add the sink," not "build the whole binding."
- **13.8f-B — no `bootWorker` call site for `gateMeetingVaultRewrite`.** Nothing constructs the real `MeetingRewriteDeps` (gbrain/reason/sections/newPlanId/newRunId) — a future arming follow-up, numbered **13.8f-D** by the orchestrator from the code-quality reviewer's second low finding (a throwing rewrite port degrades silently to `[]` with zero operator-visible signal — reasonable while dormant, but an armed adapter failing 100% of the time would be invisible; needs an observability leg before arming).

## TDD compliance

- **9.38, 9.27: clean.** Every test confirmed RED for the right reason before implementation (9.38: exact `expected [] to have length 1` failures at the minting assertions; 9.27: 12 `tsc` errors at exactly the touched call sites, including 3 `Unused '@ts-expect-error'` directives).
- **13.8f-B: one disclosed violation.** `apps/worker/src/composition/meeting-vault.ts` (a thin, mechanical mapper) was written before its test file. Not left as an assertion of discrimination — mutation-verified afterward: the adapter's return was temporarily widened to `{meetingNoteLinkMutations, ...receipt}`, the "narrows to exactly meetingNoteLinkMutations" test confirmed RED, then reverted (never committed). Every other file in all three slices was test-first.

## Reachability

- **9.38** — `egressStatus` is already mounted at the live `systemHealth.egressStatus` tRPC procedure (`boot.ts` ~1572/~1985); this slice widens an existing reachable path, no new entry point.
- **9.27** — `toUiSafeCopilotAnswer`'s sole production caller (`runGovernedCopilotSynthesis` → `answerCopilotQuestion` → the mounted Copilot ask procedure) is already live; the signature tightened, not newly wired. Confirmed via `codegraph_callers` by the security reviewer independently.
- **13.8f-B** — `bootWorker` → `buildProofSpineActivities` → `meetingBuildOutputs` (already-live activity) is widened behind `params.meetingVault`, which is **always `undefined` today**. This is a genuine, stated gap: dormant by absence (no `bootWorker` call site) as well as by flag (`gateMeetingVaultRewrite` requires `=== true`) — not a silent one, since both halves are disclaimed in-code in `living-vault.ts`'s own voice.

## Open follow-ups

1. **13.8f-C** — commit `receipt.plans` as sibling KMPs. Sequenced **with or after 13.8i, never before** (already tracked, `c7c35122`; full reasoning on `#### 13.8f` in `IMPLEMENTATION_PLAN.md`).
2. **13.8f-D** — an observability leg for `gateMeetingVaultRewrite`'s eventual arming: a throwing/rejecting rewrite port currently degrades silently to `[]` with no operator-visible signal (numbered by the orchestrator from the code-quality reviewer's low finding).
3. **13.8m** — widen `MeetingVaultRewriteResult` when it builds the real sink; flagged by the security reviewer that today's narrowing (`{meetingNoteLinkMutations}` only) is TypeScript excess-property-strength, not adversarial-strength — a future `as`-cast could smuggle `plans`/`refusals` through. Inert today (nothing reads beyond the one field); 13.8m must not spread/pass through the raw port result when it widens.
4. **`gateMeetingVaultRewrite`'s `bootWorker` call site** — nothing constructs the real `MeetingRewriteDeps` (gbrain/reason/sections/newPlanId/newRunId) yet; a future arming follow-up, same state `gateLivingVaultRewrite` is in today.
5. **9.37(b)** — the `ingestionInboxProjection.ts` "Ships DORMANT" header still misdescribes an already-live producer (9.16). Queued, not dispatched this session.
6. **My queue per the orchestrator's `IMPLEMENTATION_PLAN.md` "Currently in progress,"** in order: **13.8g-B** → **9.41 leg B** (unblocks desktop's leg C) → **9.37(b)** → **13.8f-C** (sequencing constraint above).

### Verification techniques worth carrying forward (flagged explicitly by the orchestrator as transferable, not just this session's detail)

- **Three-mutation independence check** on compile pins: widen the parameter to optional (confirms the omission pin's directive goes unused) → separately add `| undefined` to the union (confirms ONLY the `undefined` pin's directive goes unused, the `null` one still fires) → separately add `| null` (confirms the reverse) — proves two-or-more `@ts-expect-error` pins are independently real, not one accidentally covering for another.
- **Count the RED precisely**, don't eyeball pass/fail — e.g. "exactly 12 `tsc` errors, at exactly these sites" rather than "some errors appeared."
- **Run the neighbouring package's suite** rather than reasoning a change is invisible to it — `packages/evals`' full suite for 9.27 (2 authorized call sites), `packages/knowledge`'s `meeting-rewrite.test.ts` (specifically the unmodified `no_production_caller` dormancy pin) for 13.8f-B, both run and confirmed rather than assumed green.

## Preflight (final gate)

`pnpm install` clean. `pnpm typecheck` (full graph, all 11 packages via turbo): **clean, 20/20 tasks successful.** `pnpm test` (full graph): **7379 passed, 58 skipped, 8 todo — 1 FAILED test file**, `apps/desktop/test/bundle/main-bundle-resolution.test.ts`, an `electron-vite build` **tool-invocation** failure (`Command failed: npx electron-vite build`), not a test-assertion failure. This is outside this session's territory (`apps/desktop` was not touched by any of the three slices — only `apps/worker` and `packages/workflows`), and `@sow/desktop:typecheck` passed cleanly in the same run, so it isn't a type-level regression from anything here either. Not investigated further (territory boundary); flagged for the record rather than silently passed over or fixed out-of-scope.

`pnpm lint` / `pnpm format:check` deliberately not run as a gate: established by inspection (not re-verified here, per this project's own L89 — an inspectable fact isn't re-opened by a flaky execution) that every package's `lint` script is `tsc --noEmit` (already covered above), ESLint is in zero manifests, and no `format:check` script exists anywhere in this repo.

## How this was built

Three `/tdd` cycles, each with a Step 2.5 pause (9.27 and 13.8f-B each needed a design-scoping exchange before Step 2.5 proper — 9.27's crux was expressing "no notice" without collapsing declined-with-forgotten; 13.8f-B's crux was where `receipt.plans` goes, resolved narrower than either party's original proposal after tracing the actual precedent in `sourceIngestion.ts`). Mandatory security + code-quality reviewers ran on all three (9.38 and 13.8f-B as KN-10/rule-1/rule-7-adjacent; 9.27 as an explicit rule-5 slice routed through the orchestrator to the lead). All six review passes: 0-to-2 low findings each, all addressed or deliberately deferred with reasoning recorded above; zero medium/high/critical findings across the whole session. Six commits total: `abf648c6`, `64b682e5`, `c7a1e21a`, `9afc2eaf` (code) — `9.21`/`13.21`/`13.22` were contract-implementer's concurrent work in the same tree, not mine, and stayed untouched by every pathspec-limited commit here (verified via `git show --stat` after each).

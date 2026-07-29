# 130 — worker: a partial scaffold becomes a typed, resumable outcome (9.21-A)

**Date:** 2026-07-29
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/128-2026-07-29-worker-refusal-channel-and-zeroegressonly-contract.md`
**Successor session:** _(unwritten)_

---

## What landed

| Task | Commit | Summary |
|---|---|---|
| **9.21-A** | `c09ccd9b` | `provisionWorkspace` returns a distinct, resumable `partial_scaffold` outcome (`configWritten:true`, `incompleteStep:"registry_union"`) on a `registerWorkspace` fault, instead of the generic `store_fault`; mapped through the transport as a distinguishable `ONBOARDING_PARTIAL_SCAFFOLD`. The already-working same-type resume path is pinned, not rebuilt. |

`apps/worker` 2020/2020 tests green (+14 net new), `provision-preserves-egress-posture.test.ts` 21/21 unaffected, `tsc --noEmit` clean. No lint coverage exists in this repo (`pnpm lint` is `tsc --noEmit`).

---

## Why this session existed

9.21 (idempotent scaffold repair/resume) was the SOLE remaining blocker of `/phase-exit 9`, deliberately excluded from the prior round's five-slice tail. Its prerequisites (9.23/9.29/9.30) had all landed, unblocking it. The orchestrator split it producer-first into two legs: 9.21-A (worker) makes the partial state a first-class typed outcome; 9.21-B (desktop, dispatched separately, landed later this round at `f4cc1b0f` — see "Since this session" below) consumes it as a resumable repair surface instead of a dead end.

The defect: `provisionWorkspace` has four individually durable steps and five store-side failure points, all collapsed into one `store_fault` code. Two of those five sites — a `registerWorkspace` fault on the create path and on the same-type (resume) path — leave a durable side effect behind (the config row IS written; only the registry union failed) yet reported the same code as "nothing happened," making the state indistinguishable from a no-op.

---

## The load-bearing decisions

### 1. A new `ProvisionWorkspaceError` variant, not a widened success type

Brief Q1 offered three shapes: (a) a new error variant, (b) a union success type, (c) widen `registryMember` to `boolean` + a `repairState` field. Chose (a), matching the brief's own default vote and worker L31's precedent: `ProvisionedWorkspace.registryMember` stays the literal `true` ("registry-member by construction"). Widening it would delete a real structural guarantee to model a failure as a success — a partial is a **failed operation with durable side effects**, not a success. Verified this needs no `packages/contracts` change: `UiSafeProvisionedWorkspace` (the transport-facing type) is ALSO worker-local (defined in `onboarding.ts`, no mirror/Zod schema anywhere in desktop) — so there was no Category-4 fork to raise to the lead.

### 2. Wrap, don't forward, the registry-union cause

`registerWorkspace`'s own error type (`RegistryUnionError = {code:"store_fault", message}`, in `workspaceRegistry.ts`) already collapses its own get-fault vs put-fault distinction before `provisionWorkspace` ever sees it. The new `partialScaffold()` helper discards that raw message and returns only step-identity fields (`configWritten:true`, `incompleteStep:"registry_union"`) — losing nothing beyond what `registerWorkspace` had already discarded, and keeping the redaction contract (§16 / rule 7) intact.

### 3. Half the slice pinned already-working behaviour — and it had to be proven, not assumed

The same-type branch already unions into the registry on resume (`provisionWorkspace.ts:275-281`), repairing a workspace written but never registered. This was correct and entirely unproven. Per the orchestrator's mandatory addition to Step 2.5 approval, three structural pins were **mutation-verified** rather than trusted, each broken and reverted inside a single turn (shared-checkout discipline — no mutation survives a turn boundary):
- Resume completes the union: removed the `registerWorkspace` call from the same-type branch → RED (`expected [] to include 'employer-work'`).
- Resume preserves egress posture: re-added the pre-9.23 seeding upsert (`workspaceConfig.upsert(seedCloudCopilotAllowlist(...))`) → RED (resumed policy carried 4 keys vs. the revoked 3 — the ack was restored).
- `registryMember` can't be `false` on an `ok`: widened the literal to `boolean` → `tsc` `TS2578` unused `@ts-expect-error`.

All three reverted; `git diff` on the source file showed only the intended 33-insertion/3-deletion feature diff before commit. A pin never observed to fail is an unproven pin (contracts L90, banked the prior round) — this discipline is why the slice is trustworthy, not incidental to it.

### 4. The bounded revoke guarantee, restated rather than inherited

9.21 makes re-provision routine, which is exactly what converts the 9.30/9.31 residuals from theoretical to reachable. Stated explicitly (in-code, in the test file header, in the commit message, and here): a re-provision can no longer restore a revoked egress ack — **durable per workspace ROW, not per VAULT.** Bounds named, not silently carried: **#38** (the revoke side is still a whole-aggregate upsert, so a concurrent rename can be lost — benign direction) and **#39** (a foreign `egressPolicy.workspaceId` is detected nowhere). This slice touches neither bound; `resume_does_not_restore_a_revoked_ack` pins the guarantee AT the now-routine resume path, per the brief's ask.

---

## Decisions explicitly NOT made

- **#38 / #39** — named and bounded, not started this session. Per the orchestrator's round-seal note, #39 should precede #38 next time: `EgressPolicy` carries its own `workspaceId`, nothing reconciles it against the row's `id`, and `buildActivities.ts:856` falls back to it (`ctx.workspaceId ?? params.resolved.egressPolicy.workspaceId`) — not reachable via code today (both derive from the same id today), but the accepted-residual shape #39 addresses. #38 is 9.30's narrow-the-write fix mirrored onto `egressRevoke.ts:60-68`.
- **#32, #45, #44** — not touched this session; recorded open from the prior round, unchanged.
- **9.21-B** (desktop consumer leg) — explicitly out of scope for this slice (worker producer leg only). Landed later this round via a separate dispatch at `f4cc1b0f` (see below) — not part of my session's work, noted here only for continuity.

---

## TDD compliance

**Clean.** One `/tdd` cycle, RED-first: 5 of the new test file's assertions failed for the right reason pre-implementation (expected `partial_scaffold`, got `store_fault`); `tsc --noEmit` also RED (TS2322/TS2367/TS2339 — the variant didn't exist in the type yet). 14 other tests in the new file passed pre-implementation because they exercise pre-existing guarantees this slice pins rather than builds (the resume path, totality, the untouched store-fault sites) — not vacuous passes, since the underlying behaviour genuinely already held; that distinction is exactly why the mandatory mutation-verification (decision 3, above) mattered: an unbroken pin and a vacuous pin look identical until you break the thing it claims to guard.

---

## Reachability

- **9.21-A** — LIVE, not dormant. `boot.ts:1577` binds `createProvisionWorkspacePort` over the real backends at boot, no flag, no gate. `partial_scaffold` is reachable today on any genuine registry read-model `.put` fault during onboarding (disk-full, store unavailable, etc.) — the not-yet-built consumer at the time of this session was desktop's resume affordance (9.21-B), not the outcome itself. (9.21-B has since landed — see below.)

---

## Since this session (context, not my work)

Per the orchestrator's round-seal message and confirmed in `git log`, after this slice's Step-10 commit the round continued without me and closed out 9.21 entirely: `f4cc1b0f feat(desktop): surface a partial scaffold as a resumable repair state (9.21-B, closes 9.21)`. Noted here only so a reader of this doc doesn't go looking for an open 9.21-B — it is closed, by a different implementer, in a commit after this one. `/phase-exit 9`'s remaining status is the orchestrator's to state, not reconstructed here.

---

## Open follow-ups

1. **#39 before #38** (per orchestrator's round-seal note) — `EgressPolicy.workspaceId` reconciliation against the row's `id`; `#38` mirrors 9.30's narrow-the-write fix onto `egressRevoke.ts:60-68`. Neither started; not blocking anything today (out-of-band reachability only).
2. **#32, #44, #45** — carried from the prior round, still open, unchanged by this session.
3. **Lessons banked** (by the orchestrator, hot, committed at `12e2e5ac` — not mine to re-state in full, cross-referenced here): worker **L79** ("a failure taxonomy needs a member per recoverable state, not per fault source") and worker **L80** ("do not widen a literal-typed success field to model a failure," extending L31).
4. **Cross-doc invariant audit:** none applicable. No model in the `packages/contracts/CLAUDE.md` Cross-doc invariants table changed this session; `ProvisionWorkspaceError` and `UiSafeProvisionedWorkspace` are both worker-local with no contracts mirror.

---

## How this was built

One `/tdd` cycle. Brief 217, one Step-2.5 round (APPROVED with one mandatory addition — mutation-verify the two resume pins in addition to the already-planned compile-time pin), one commit. Both reviewers dispatched (security-reviewer at `invariant` scope: 0 findings; code-quality-reviewer at `every-slice`: 1 medium — a stale line-citation in the test file's header comment, introduced by the brief's pre-implementation line numbers shifting after the feature landed — fixed in-slice before shipping). Step-9 routed to the orchestrator (not the lead): confirmed not a rule-5 change (no egress-path touch, confirmed by both the security reviewer and the orchestrator's own source verification before authoring the Step-10 commit message).

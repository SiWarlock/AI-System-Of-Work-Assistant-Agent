# 154 — providers-integrations: 24.13 boot guard shipped, 24.29 census widened, 24.15 blocked at hard-stop

**Date:** 2026-08-12
**Track / role:** main · providers-integrations-implementer (`packages/providers`, `packages/policy`, `packages/integrations`)
**Predecessor session:** `docs/sessions/149-2026-08-11-provint-respawn-9-42-established-24-16-24-14.md`
**Successor session:** _(next `/session-end`, whenever this track resumes)_

---

## Why this session existed

Fresh spawn on the `main` team, dispatched by main-orchestrator against the 24.6 safety-audit
remediation queue. Registered, ran `/session-start`, oriented on root `CLAUDE.md`,
`packages/providers/CLAUDE.md` + `LESSONS.md`, `IMPLEMENTATION_PLAN.md`'s 24.x tail, handoff 022,
audit 002's AC-2b partition, and session 149. Worked three tasks in sequence dispatched by
main-orchestrator: `24.13` (safety rule 1, HIGH), `24.29` (my own disclosed 24.13 residual,
promoted to a task by lead ruling), and `24.15` (fail-safe direction, lower stakes) — the last one
blocked mid-Step-2.5 on a cross-territory dependency, then held at the team's context hard-stop.

## What was built

**Files created:** none.

**Files modified:**
- `packages/knowledge/src/fs-watch/reconcile.ts` — `24.13`: added `assertReconcileVaultBootSafe(verify?)`,
  a fail-fast boot guard (Path B) replacing the plan to build a real HMAC verifier. Throws iff the
  resolved verifier is the `defaultVerifyKwSig` placeholder singleton. Doc comment states the
  mechanism's real limits explicitly (a known-singleton check, not a verifier-strength check; call
  once at boot, never per-event; nothing today forces a future composition root to call it).
  Commit `7a4fe0ac`.
- `packages/knowledge/test/reconcile.test.ts` — 4 new tests for `24.13` (boot-guard behavior +
  2 standing `execSync` repo-wide grep-census regression pins), then widened/added-to again for
  `24.29` (the reachability census's scan scope: `apps/`-only → `packages apps`, backed by a named
  `KNOWN_RECONCILER_SELF_REFERENCES` allow-list). Commits `7a4fe0ac`, `409730b6`.

No files created or touched outside `packages/knowledge` this session (both slices landed in
knowledge territory per each brief's own file list, not `packages/providers/policy/integrations`
— `24.15`'s brief was the one that would have touched my nominal home area, and it never reached
Step 4).

## Decisions made

1. **`24.13`: Path B (fail-fast boot guard), not Path A (real HMAC verifier).** `reconcileVault`
   has zero production callers today, so a real verifier has no live consumer to validate against
   yet — and the existing 280-line `reconcile.test.ts` fixture suite fakes `kwWriterSig` via a
   non-cryptographic stand-in throughout, so Path A would force rewriting an unrelated test suite
   to harden a dormant module. Orchestrator-approved at Step 2.5.
2. **`24.13`: throw-style, not `Result`-returning**, diverging from this codebase's dominant
   `assert*` convention (`packages/db/src/invariants/operational-truth.ts`,
   `packages/providers/src/model/http-transport.ts` both return typed `Result`). Justified: this
   is a load-time boot-crash invariant (mirroring `gbrain-sync-trigger.ts`'s existing unconditional
   fail-fast guard), not a runtime-recoverable path — a `Result` return would imply a caller that
   could reasonably continue past a false-attribution guarantee, which is wrong here.
3. **`24.13` Step 3 self-catch:** my first version of the "fires when wired with placeholder" test
   used a bare `.toThrow()`, which passed **before implementation existed** — the missing-export
   `TypeError` satisfied it vacuously. Caught before trusting it; tightened to
   `.toThrow(/placeholder/i)`, which correctly went RED for the right reason. Recorded because the
   same class of defect recurred in `24.29` (below), caught that time by a reviewer instead of by
   me.
4. **`24.29`: widened the reachability census repo-wide, and the "zero production callers" claim
   holds — investigated, not assumed.** The widening surfaced two files `24.13`'s own Step 9 didn't
   know about: `packages/knowledge/src/fs-watch/vault-watcher.ts` (a sibling module defining
   `createVaultWatcher`/`runWakeReconcile`, same category as `reconcile.ts` defining
   `reconcileVault` — confirmed zero actual calls to `reconcileVault(` anywhere) and its own
   unit-test file. Both are now explicit, commented entries in `KNOWN_RECONCILER_SELF_REFERENCES`
   rather than silently absorbed. The verifier-machinery census (a second, pre-existing test) needed
   no change — it was already `packages apps`-scoped since `24.13`; only the reachability one was
   `apps/`-only, an asymmetry nobody had flagged until this task.
5. **`24.29`: persist the full `approvalPolicy`-shaped design reasoning does NOT apply here** —
   that's `24.15`'s design question, not `24.29`'s. (Noted to avoid conflating the two slices'
   decisions in this recap.)
6. **`24.29` Step-8 fix: a genuinely vacuous test, caught by the code-quality reviewer, not by me.**
   `census_excludes_the_known_comment_reference` asserted against the *already-filtered*
   `unexpected` array — which can never contain a `KNOWN_RECONCILER_SELF_REFERENCES` member by
   construction, independent of whether the underlying grep matches anything. Fixed to assert
   against the raw census result instead; mutation-verified both broken (correctly RED when the
   matched term was mangled) and fixed (GREEN) states. **My own Step-3-equivalent mutation-check
   before Step 8 covered only the third new test, not this one** — the gap that let it through my
   own verification and land on the reviewer instead. Recorded plainly rather than glossed over.
7. **`24.29`: traced a wrong lesson citation to its source rather than just repeating it.** My own
   doc comment cited "the exact mirror of contracts L93" — copied faithfully from
   `IMPLEMENTATION_PLAN.md:3159` (task `24.29`'s own originating text, not something I introduced).
   Code-quality review flagged it as likely wrong; I independently verified against
   `packages/contracts/LESSONS.md#93` (it's about citations rotting in prose, not scoped-grep-
   missing-a-caller) and corrected my own comment rather than let it stand. Main-orchestrator
   independently re-verified and fixed the plan doc's citation (`00690851`), crediting the finding.
8. **`24.15`: blast-radius investigation completed at Step 2.5, before any code.** Read
   `packages/policy/src/approval-policy.ts` in full per the brief's mandatory instruction.
   `AUTO_PRIVATE_POLICY` is confirmed the sole `approvalPolicy` token conferring auto-eligibility,
   but auto-eligibility is a 5-conjunct predicate (resolved-posture, `dataOwner`, `approvalPolicy`,
   target allow-list, visibility) — `dataOwner`/visibility are resolved fresh from
   `ResolvedWorkspacePolicy` at call time (never persisted per-action), and `targetSystem` is
   already preserved verbatim in `outbox-drain.ts`'s `rebuildAction()`. `approvalPolicy` is the
   only one of the five actually clobbered on redrive today. No per-token test needed (the brief's
   conditional RED-outline item 4 doesn't apply — confirmed, not assumed).
9. **`24.15`: persist the full `approvalPolicy` string, not a frozen "was-auto-eligible" boolean** —
   strengthening the brief's own default vote with a mechanism-grounded reason: a frozen boolean
   would go stale if the workspace's visibility posture tightens between the original hold and a
   later redrive, incorrectly bypassing approval against *current* policy. Persisting the string and
   letting `requiresApproval()` re-run dynamically at redrive time (as it already does today for a
   fresh dispatch) correctly reflects governing state at redrive time, not a frozen snapshot.
10. **`24.15`: `OutboxEntry` confirmed NOT an Appendix-A model.** Its definition
    (`packages/db/src/repositories/interfaces.ts:83`) sits under a section header reading
    *"operational DTOs for domains with no 1:1 frozen Appendix-A model... deliberately NOT frozen
    seam contracts."* No schema-snapshot test applies.
11. **`24.15`: surfaced a genuine cross-territory blocker rather than either barrelling ahead or
    silently working around it.** Implementing the fix requires `OutboxEntry` to gain a field — but
    `OutboxEntry` is defined in `packages/db` (worker territory: `interfaces.ts`, both Drizzle
    schema dialects, both adapters' `update()`/`toOutbox()`), not mine
    (`providers/policy/integrations`). Bigger than contracts L121's narrow one-line-fixture
    exception. Flagged at Step 2.5 with three options; main-orchestrator confirmed the read and
    filed `24.35` as a worker-owned prerequisite (landed this session, `3cc87f6f`, built to my
    stated conclusion — additive/nullable `approvalPolicy?: string` on both dialects/adapters).
12. **`24.15`: did NOT start implementation once unblocked, per explicit instruction.** `24.35`
    landed mid-session, unblocking `24.15` — but the team was at a context hard-stop with dispatch
    halted, explicitly including newly-unblocked work. Left task `#19` `in_progress` and unstarted,
    exactly as instructed, rather than starting a slice that couldn't finish this session (which
    would have violated slice-atomicity in the other direction — starting something with no room to
    reach Step 10).

## Decisions explicitly NOT made

- **`24.15`'s Step 3 onward** — blast radius and design are fully answered (see above), but no test
  or implementation code exists yet. Next session's Step 2.5 open item, flagged by
  main-orchestrator: `OutboxEntry.approvalPolicy` is optional at the type level, so a
  pre-migration entry reads back `undefined` on redrive — `24.15` needs to decide what redrive does
  with an absent value. Fail-safe direction (gate rather than skip) is the obvious default given
  the finding's own fail-safe framing, but that's a Step-2.5 call, not decided here.
- **The census's residual imperfections (`24.29`, both `defer`, not fixed):**
  1. `KNOWN_RECONCILER_SELF_REFERENCES` has no structural safeguard against a future contributor
     adding a real caller's path to silence a red tripwire test — relies on reviewer discipline,
     same disclosed-limitation class as `assertReconcileVaultBootSafe` itself.
  2. The census still isn't literally 100%-repo-wide (misses `vitest.workspace.ts`, `scaffold/**`)
     — checked, no live gap today, immaterial given this project's composition-root convention.
- **`packages/policy/src/audit-signal.ts:137-143`'s doc comment** — asserts an audit-persistence
  consumer "does not exist yet in production," which task `24.7` (worker, landed this session) now
  makes false. Flagged by main-orchestrator as mine to fix (my file) at next touch — not urgent,
  not done this session (no code slice reached it).

## TDD compliance

Mostly clean, with one honestly-disclosed process gap:
- `24.13`: full RED → GREEN → mutation-verify cycle, both the boot-guard tests and (implicitly, via
  the earlier `defaultVerifyKwSig` behavior) the pre-existing fixture suite. Self-caught a vacuous
  `.toThrow()` at Step 3 before trusting it (see Decision 3).
- `24.29`: test-only slice (no production code — `24.13`'s own boot guard already existed; this
  slice only widened its regression-pin coverage), so the RED/GREEN cycle took the mutation-verify
  shape this repo uses for test-only slices rather than a literal pre-implementation RED. **Gap:**
  my own mutation-check before dispatching to reviewers covered only one of the three new tests
  (the primary tripwire); a second new test was vacuously true and was caught by the code-quality
  reviewer at Step 8, not by me at my own Step-3-equivalent verification (see Decision 6). Fixed
  in-slice, then mutation-verified properly before shipping — but the gap in my own process is
  worth naming plainly rather than only crediting the reviewer's catch after the fact.
- `24.15`: no code shipped this session — not applicable.

## Cross-doc invariant audit

No `packages/contracts` Appendix-A model's field list changed by anything I shipped this session.
`24.13` touched only `packages/knowledge`-local types (`KwSigVerifier`/`ReconcileDeps`, both
pre-existing). `24.29` was test-only. `24.15` never reached Step 4. `git diff -- ARCHITECTURE.md`
is clean (no uncommitted doc edit pending against anything of mine). No discipline violation to
flag.

## Reachability

- **`24.13`** — `assertReconcileVaultBootSafe` is **NOT wired**, deliberately: `reconcileVault`
  has zero production callers repo-wide (confirmed by `24.29`'s widened census). This is the
  intended state, not a gap — the guard is a backstop for whenever the fs-watch reconciler is first
  bound to a composition root, which has no tracked task number yet.
- **`24.29`** — not applicable; test-only, no new production code to wire.
- **`24.15`** — not applicable; no code shipped.

## Open follow-ups

- **`24.15`** — unblocked (`24.35` landed, `3cc87f6f`) but explicitly held at the team's context
  hard-stop, not started. Next session picks up at Step 3 with the Step 2.5 design already fully
  settled (see Decisions 8–11) plus the one new open question in "Decisions explicitly NOT made"
  above (redrive behavior on an `undefined`/pre-migration `approvalPolicy`).
- **`packages/policy/src/audit-signal.ts:137-143`** — doc comment goes stale now that `24.7`
  landed; mine to fix at next touch (main-orchestrator flagged, not urgent).
- **`24.29`'s two deferred residuals** (allow-list has no structural anti-gaming safeguard; census
  isn't literally 100%-repo-wide) — recorded, no action owed, listed above for completeness.

## How to use what was built

- `assertReconcileVaultBootSafe(verify?: KwSigVerifier)` (`packages/knowledge/src/fs-watch/reconcile.ts`)
  is the seam any future composition root binding `reconcileVault` must call before constructing
  real `ReconcileDeps` — call once at boot, passing the real verifier being wired; never call it
  per-reconcile-event.
- `KNOWN_RECONCILER_SELF_REFERENCES` (`packages/knowledge/test/reconcile.test.ts`) is the auditable
  allow-list backing the repo-wide reachability census — add an entry only after tracing the new
  hit from source (definition site / own test / confirmed-comment), never to silence a red test
  without investigation.
- `OutboxEntry.approvalPolicy?: string` (landed by `24.35`, not this session's own work, but the
  prerequisite `24.15` now consumes) is additive/nullable on both DB dialects and adapters — `24.15`
  is the consumer that reads/writes it meaningfully.

# Session 158 — knowledge: GCL denial-audit persistence (24.33 admission path + 24.44 leg 2 re-gate path), cross-track producer/consumer sequencing

**Date:** 2026-08-12 · **Role:** knowledge-implementer (`main`, single-track, root checkout)
**Predecessor:** [156-2026-08-12-raw-content-shape-fork-concept-sweep-24-34-zero-new-forks.md](156-2026-08-12-raw-content-shape-fork-concept-sweep-24-34-zero-new-forks.md) · **Successor:** _(next knowledge-implementer session)_

## Why this session existed

Continuation of the same team session, dispatched next after `24.34`'s audit slice closed. `admitProjection`'s deny branches (the GCL Visibility Gate, `packages/knowledge/src/gcl/visibility-gate.ts`) built a mandatory `AuditSignal` on every denial and discarded it — the same defect shape `24.7` fixed on the interactive-Copilot path. `24.33` built the persist mechanism for the write-admission path; `24.44` (leg 2, cross-track with worker) completed the same coverage for the read/re-gate path, which has a real production caller in a different track and required a lead-authorized, consumer-first landing sequence to avoid a compile-red window in the shared checkout.

## What was built

**Files created:** none.

**Files modified:**
- `packages/knowledge/src/gcl/visibility-gate.ts` — `24.33`: widened `GclGateError`'s three policy-decision-derived variants with an optional `audit?: AuditSignal`; `denialToGateError` threads it (additive 5th param, existing 4-arg exhaustive unit tests unaffected); `admitProjection`'s call site now passes `decision.audit`; new `auditOf(error)` export (switch + `assertNever`-exhaustive, matching this file's own established idiom — refactored from an initial `"audit" in error` structural check per code-quality review).
- `packages/knowledge/src/gcl/projection.ts` — `24.33`: new `GclAuditPersistPort` interface (GCL-local, not imported from `apps/worker` — would invert the package's layer direction) + `persistDenialAudit(audit, workspaceId, auditPersist)` (fail-closed gated on `@sow/policy`'s `isRedactionSafe`, try/catch around the port call so a future throwing adapter can't break this module's own never-throw contract), threaded through `admitAndPersistProjection` only in that slice. `24.44` (leg 2): `serveProjection` converted sync → async, threading the same port + calling the same `persistDenialAudit` helper on its re-gate deny path; `sourceWorkspace.id` (never row-derived) reaches the persist call, matching WS-8 discipline.
- `packages/knowledge/test/gcl-visibility-gate.test.ts` — `24.33`/`24.44` tests (deny carries the signal; `auditOf`'s negative-control branch for the two variants that never carry one).
- `packages/knowledge/test/gcl-projection.test.ts` — `24.33`'s `admitAndPersistProjection` suite (end-to-end persist, allow-persists-nothing, byte-equivalent-when-absent, raw-content-denial-persists-nothing, fail-closed-on-unsafe with a positive control) + `24.44`'s `serveProjection` suite (the same shape, plus a workspaceId-provenance pin and a routing pin proving the deny path goes *through* `persistDenialAudit` rather than bypassing it) + a standalone stale-comment correction (see below).

**Commits, in order:**
1. `ce8e839f` — `24.33`: admission-path persist mechanism, dormant.
2. `7f780a98` — standalone: corrected a stale "LIVE cross-workspace read gate" test comment (from task `24.18`, predating the `24.33` correction) — kept the true source-level fact (`crossWorkspaceRead.ts` really does call `serveProjection`), struck the liveness assertion. Deliberately its own commit, not folded into `24.33`, per the orchestrator's explicit instruction to keep a safety-adjacent mechanism slice bisectable from doc repair.
3. `dd0ee19b` — `24.44` leg 2: re-gate path persist mechanism, dormant. (Leg 1, worker's one-word `await` at `crossWorkspaceRead.ts:139`, landed separately at `e7991d52` — a different track's commit, not mine, verified via `git log` before I touched anything.)

Also touched, this session but a distinct task: `24.34` (audit sweep, zero forks found, 0 code changes) — already covered in the predecessor session doc (156); not repeated here.

## Decisions made

- **`24.33` Q1 (port shape):** GCL-local `GclAuditPersistPort`, not `24.7`'s worker-side one directly (layer-direction rule). **Deliberate divergence from `24.7`'s shape:** the `isRedactionSafe` gate lives in `packages/knowledge`'s own `persistDenialAudit`, not inside the injected port — because `24.7`'s port and gate are bound together in the same package/round, but here the real binding is deferred to a future phase/author; the safety property must hold at the layer guaranteed to run today. Endorsed explicitly by the orchestrator as *"stronger than 24.7's shape, not a shortcut"* and asked to be quoted verbatim in this doc.
- **`24.33` Q2 (which composing function gets the port):** originally proposed threading through both `admitAndPersistProjection` and `serveProjection` in one slice; **corrected via orchestrator TWEAK** — `serveProjection` has a real production caller in `apps/worker` that calls it synchronously, so `24.33` scoped to `admitAndPersistProjection` only and filed the read-path leg as `24.44`, a cross-track producer/consumer pair requiring lead authorization (a first-of-its-kind extension of `contracts L121` from test fixtures to production code).
- **`24.44` sequencing — consumer-first, not producer-first:** worker's `await` landed first while `serveProjection` was still synchronous (a legal no-op on a non-Promise value, verified both by the orchestrator and independently by me before touching GREEN); only then did `serveProjection` flip to `async`. This is the reusable half of the pair — producer-first cannot achieve a no-red-window landing by construction.
- **`24.44`'s routing-pin test, mutation-verified rather than RED-first:** per orchestrator ADD, added `serve_projection_denial_routes_through_the_redaction_gate` to prove the deny path routes through `persistDenialAudit` rather than bypassing it to the port directly — the one property no other test in the suite discriminates. This test is GREEN both before and after implementation (both an absent mechanism and a correctly-gated one produce zero port calls for its fixture), so it cannot be RED-first; **mutation-verified instead** (L75): baseline `PASS(23)/FAIL(0)` → bypass applied → `PASS(22)/FAIL(1)`, exactly this test, no collateral → reverted → `PASS(23)/FAIL(0)` restored. Redone against the *final* test content after review changed its fixture, not the draft.
- **Security review found the workspaceId-provenance pin was missing** for a genuinely subtle reason: `sourceWorkspace.id` was already the correct value at both call sites, but no test could tell it apart from the (wrong, WS-8-violating) row-derived alternative, because every other denial path has already proven the two equal by construction before denying. Added a dedicated mismatched-but-*safe* fixture (`"ws-002"`) that reaches the persist call so the comparison is meaningful.
- **Two of `24.44`'s own brief content items were themselves found to have errors, both acknowledged by the orchestrator as its own mistakes, not mine:** the suggested credential fixture (`...secret@...`) independently tripped a different redaction rule than the one it claimed to pin (fixed: swapped to `...hunter2@...`); the brief's "same four pins as 24.33" list substituted a restatement of pin 1 for 24.33's actual fourth pin (raw-content-denial-persists-nothing), leaving `serveProjection`'s own characteristic denial (a tampered raw-content row) without that pin. Both fixed in-slice.

## Decisions explicitly NOT made

- **`packages/policy`'s `isRedactionSafe` was not touched**, even though both slices' security reviews surfaced real gaps in it (a keyword/prefix heuristic overclaiming "no representable violation today"; an unvalidated `workspaceId` embedded in `MALFORMED_POLICY_INPUT`'s audit refs). Explicitly out of scope both times — that's `providers-integrations` territory, tracked as `24.45` (now amended to cover the read path too, per this session's finding).
- **Phase 25.2/25.4's actual port wiring** — neither slice binds a real `GclAuditPersistPort` anywhere; both mechanisms are built dormant, injected-and-unbound, `apps/` untouched (confirmed via file-redirected `git status` after every slice). Three follow-on findings from `24.44`'s review (unbounded per-row persist calls once bound; the read-path `24.45` amendment; a refused-unsafe-signal's zero observability) were routed rather than fixed, filed as `24.52`, an `24.45` amendment, and `24.53`.

## TDD compliance

**`24.33`:** clean, no violations — every test written RED-first, confirmed failing for the right reason before implementation.

**`24.44`:** one disclosed, orchestrator-approved substitution — the routing-pin test (`serve_projection_denial_routes_through_the_redaction_gate`) is not RED-first-capable by construction (see "Decisions made" above); mutation-verification was proposed as the substitute non-vacuity proof *before* implementing, the orchestrator agreed with the binding precondition that the mutation must be observed to fail (not just asserted to), and both the fail-state and the restore-state were run and their counts recorded. All other tests in both slices were RED-first, confirmed failing for the right reason.

## Cross-doc invariant audit

No Appendix-A/cross-doc model changed in either slice. `GclGateError`, `GclAuditPersistPort`, `persistDenialAudit`, `auditOf` are internal implementation types (re-confirmed this session, matching session 155's original classification of this file's sibling types) — no `ARCHITECTURE.md` or cross-doc-table follow-up owed.

## Reachability

- **`24.33` (`admitAndPersistProjection`):** NOT wired. Zero production callers of the persist mechanism; `apps/` untouched.
- **`24.44` (`serveProjection`):** the function call itself is now correctly threaded end-to-end — `apps/worker/src/composition/crossWorkspaceRead.ts:139` awaits it (`e7991d52`, worker's commit, verified via `git log` before I built against it). **But the overall PATH remains dormant**: `resolveApprovedCrossWorkspaceSlice` (the one caller of `serveProjection` in production source) has zero production callers of its own — every real caller is in a test file. The doc comment on `serveProjection` states this precisely (dated, with a re-derive instruction and the named falsifier: Phase 25.2/25.4's port wiring) rather than as a standing claim, per a `contracts L145` concern the orchestrator raised mid-slice.
- Both mechanisms activate automatically the moment a real `GclAuditPersistPort` binds at Phase 25.2/25.4 — no further code changes needed in `packages/knowledge` for that to happen, per each slice's own "unbound ⇒ byte-equivalent" test.

## Open follow-ups

- **`24.52`** (new, filed from `24.44`'s security review) — unbounded per-row awaited persist calls once the port binds; a wiring precondition for Phase 25.2/25.4, must gate the binding rather than trail it.
- **`24.45`, amended** (from `24.44`'s security review) — `isRedactionSafe`'s unvalidated-`workspaceId`-ref gap is now reachable from a second (read) path, not just the write path found in `24.33`'s own review. `serveProjection` exists specifically for the tampered-row threat model, so hostile input there is expected, not hypothetical — this is what upgrades the finding, per the orchestrator.
- **`24.53`** (new, filed from `24.44`'s security review) — a refused-unsafe-signal is silently dropped with zero observability, unlike the `boot.ts` `createAuditPersistPort` sibling which logs the refusal event-name-only; that's the precedent to mirror when this is addressed.
- The comment-staleness pattern (`contracts L145`: *"a reachability claim nothing re-measures, sitting where it is most believed"*) recurred a second time this session (the `24.18`-era test comment fixed in `7f780a98`), on top of `24.33`'s own original finding. Both instances are now fixed; no further sweep run beyond eyeballing the touched files, per the orchestrator's explicit scoping.

## Preflight (final gate, run at session-end)

`pnpm install` clean · lint (`npx turbo run lint`) 11/11 clean, both after `24.33` and again after `24.44` (including the interim state during mutation-verification, which correctly caught a real type-narrowing bug in the routing-pin test — `if (!r.ok) {...}` doesn't narrow `r.error`'s discriminated union in TS; fixed to `if (!r.ok && r.error.code === "malformed_policy_input")`) · full suite, final run: **7595 passed / 58 skipped / 8 todo, 1 pre-existing unrelated failure** (`apps/desktop/test/bundle/main-bundle-resolution.test.ts`, `### 24.25`, unowned — unchanged by this session's diffs, which touch only `packages/knowledge/`). One transient, non-reproducing failure (`@sow/integrations`'s `outbox.test.ts`, from a different implementer's concurrent in-flight work on `24.15`) appeared in one intermediate run and was gone on the next — matching the documented `L83` shared-tree signature; not chased, not caused by anything in this session's diff.

## How to use what was built

- **Both persist mechanisms activate automatically** the moment a real `GclAuditPersistPort` binds at Phase 25.2/25.4 (`### 24.52` is a precondition on that binding: it must cap/dedupe per-read persist calls before going live). No further `packages/knowledge` code changes needed for either path.
- **`auditOf(error)` and `persistDenialAudit(audit, workspaceId, auditPersist)`** are the single-sourced building blocks (`contracts L39`) — any future third denial-producing path in this package should reuse them, not re-derive the gate.

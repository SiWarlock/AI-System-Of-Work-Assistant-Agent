# Session 073 — rebuild-oracle boot binding (piece C): CLOSES the producer arc

- **Date:** 2026-07-15
- **Phase / task:** 13.10 (Copilot propose/serving-oracle go-live — runbook Phase 4 producer, piece C of A→B→C) — task #21
- **Team:** `session-734f946b` · orchestrator `orch20` · implementer `impl22` (worker area) · lead `main`; single-track on `main`
- **Predecessor:** [072-2026-07-15-knowledge-impl-rebuild-strict-equality.md](072-2026-07-15-knowledge-impl-rebuild-strict-equality.md)
- **Successor:** _(none yet)_

## Why this session existed

Pieces A (`210e95e`, the `probeRebuildOracle` producer) and B (`118135c`, the default-OFF `gateRebuildOracle` boot gate) landed reachability-WAIVERED — reachable only from their own tests. Piece C is the arc-CLOSING slice: it wires `gateRebuildOracle` into `bootWorker`, binds the cached `resolveOracleBuild` accessor into `createServingCoverageReader` (the last hardwired-false serving-coverage leg), routes any rebuild divergence to the health surface, and closes the A+B reachability waivers — while staying DORMANT (the owner-gated real `IndexRebuildClient` stays UNBOUND). In parallel, a knowledge-track implementer hardened `rebuild.ts:160` (`!receipt.replaced` → strict `=== true`, task #22, session 072) — the arming blocker I flagged from piece A — so the whole green path is now strict.

## What was built

### Files created
- **`apps/worker/test/boot/rebuildOracleBinding.test.ts`** — 5 tests (boot class) over the extracted helpers + the byte-equivalent default: rule-7 safe-fields reprojection, record-fault propagation, route-only-diverged over the REAL wiring, compute-never-throws-contains-fault (incl. a guarded throwing fault-signal), and the Lesson-16 no-false-green (`oracleBuildOk=false` WITH `pinValid=true` + clean parity).

### Files modified
- **`apps/worker/src/boot.ts`** (commit `c251518`):
  - **`createRebuildOracleHealthSink`** — mirror `createReconcileHealthSink`: reproject a `diverged` status's `rebuild_divergence` `HealthItem` → a `HealthFailure` using ONLY safe fields (frozen `failureClass`, a SYNTHESIZED safe message, a subjectRef from ids/workspaceId); NEVER forwards the item's free-form `message` (safety rule 7). A `recordFailure` fault PROPAGATES (Lesson 18).
  - **`computeAndRouteRebuildOracle`** — await the one-shot `compute()` once, route ONLY `diverged` statuses to the sink, and CONTAIN any fault (§16); the contained-fault SIGNAL (`onContainedFault`) is itself guarded against a throwing logger (mirror `createReconcileLogSink`).
  - **3 `bootWorker` edits:** construct `gateRebuildOracle` in the `copilotProvenanceStamping && provenanceBundle` serving-oracle branch with **`makeRebuildClient` OMITTED** (the owner-gated real client UNBOUND — the arming crossing); AND-bind `resolveOracleBuild: rebuildOracle?.resolveOracleBuild` into `createServingCoverageReader`; and `await computeAndRouteRebuildOracle(...)` once after the reconcile binding (where `surface` is in scope).

## Decisions made
- **Brief correction (accepted by orch20, brief 072 fixed):** the brief said wire `makeRebuildClient: () => undefined` (mirroring reconcile F2's `makeDbAdapter`). That is WRONG for piece B's committed gate — its OFF-lock is `typeof makeRebuildClient !== "function"` (a client-PRESENCE gate), so `() => undefined` reads as ON *and* wouldn't typecheck (`() => undefined` ⊄ `() => IndexRebuildClient`). The correct dormant binding is **`makeRebuildClient` OMITTED** (absent) ⇒ gate returns `undefined` ⇒ byte-equivalent. (Reconcile differs because its ON/OFF is the `reconcile` flag, adapter always-present.)
- **Test surface split (Lesson 16):** the extracted helpers are unit-tested; the `bootWorker` call site is proven via typecheck + `/wired`, not a `bootWorker` RED.
- **In-slice hardening (from security review):** the `onContainedFault` fault-signal is guarded (try/catch) so a throwing logger cannot defeat the boot containment / crash boot (§16) — TDD'd (failing assertion first).
- **Totality:** the gate's `newHealthItemId` (pure counter) + `auditRef` (`auditId("...:boot")`, eagerly a string) are total — they're called unguarded in `rebuildIndexFromMarkdown`.
- **subjectRef fallback** `rebuild-oracle:${workspaceId}` (the rebuild item carries no `factIdentity`/`parityReportRef`); the precise OBS-2 dedupe subjectRef finalizes at arming.

## Decisions explicitly NOT made (deferred to arming)
- **`faulted` operator-visibility** — a per-ws `faulted` status routes NO health (piece A's `faulted` variant carries no `HealthItem`; `compute()` swallows internally so the boot catch never fires). Serving still degrades (fail-safe, NO false-green), but it's operator-invisible — a Lesson-25 ASYMMETRY vs reconcile (whose `pass_faulted` mints a `parity_defect` item). Surfacing it needs a piece-A producer change at arming.
- **Per-ws routing resilience** — a `sink.record` rejection on the first diverged ws short-circuits the loop (later divergences unrouted that boot). Fails safe; finalizes at arming.
- **Real arming** — the owner-gated real `IndexRebuildClient`, the signing key, real corpora, governance eval, and the propose flip remain the owner's ARMING GATE.

## TDD compliance
**CLEAN.** Test-first: RED confirmed for the right reason (missing helper exports before impl; the byte-equivalent-default test passed early because it only used existing exports — correct). The review-driven §16 hardening was also TDD'd (failing throwing-callback assertion first). Mandatory dual review at Step 8.

## Reachability
- **CLOSED (this is the wiring slice):** `bootWorker`@1082 → `gateRebuildOracle`@1338 (call site) → the compute closure → `probeRebuildOracle`@874 is statically reachable (typecheck + `/wired`/codegraph confirmed), closing the piece-A + piece-B waivers. Runtime stays DORMANT — `rebuildOracle` is `undefined` by default (client unbound), so the compute+route block is a no-op on the shipped path.

## Open follow-ups
- **Arming (owner):** provision the real `IndexRebuildClient` factory (+ signing key + corpora + governance eval); at arming, surface `faulted` statuses (piece-A producer change) + add per-ws routing resilience + finalize the OBS-2 dedupe subjectRef.
- **Orchestrator-routed (hot, arc close):** ARCH §6 rebuild-oracle arc-CLOSE note (A+B+C) + worker Lesson 29 (the arc lesson) — orch20 writes both at `/orchestrate-end`.
- **Cross-doc invariant change:** NONE.

## How to use what was built
The rebuild-oracle producer arc is now fully wired but DORMANT. At arming, provisioning a real `IndexRebuildClient` factory (via config, in the serving-oracle branch) flips `gateRebuildOracle` ON: `bootWorker` `await`s `compute()` once, folds per-workspace corroboration into the cached `oracleBuildOk`, and `createServingCoverageReader` reads it as one AND-term of `deriveServingCoverage` — turning the last hardwired-false serving-coverage leg into a real, corroborated signal. Divergences route to the health surface (safe-fields-only); everything fails closed.

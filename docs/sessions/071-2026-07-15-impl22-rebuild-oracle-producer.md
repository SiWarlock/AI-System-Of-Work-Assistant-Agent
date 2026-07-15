# Session 071 — rebuild-oracle producer arc (pieces A + B): the go-live `oracleBuildOk` producer + its default-OFF boot gate

- **Date:** 2026-07-15
- **Phase / task:** 13.10 (Copilot propose/serving-oracle go-live — runbook Phase 4 "serving oracle go-live" producer) — first go-live PRODUCER build round
- **Team:** `session-734f946b` · orchestrator `orch20` · implementer `impl22` (worker area) · lead `main`; single-track on `main`
- **Predecessor:** [070-2026-07-14-impl21-external-write-gate-and-arming-strict-equality.md](070-2026-07-14-impl21-external-write-gate-and-arming-strict-equality.md)
- **Successor:** _(none yet)_

## Why this session existed

At the prior round's close the system was HOLDING at the owner-gated ARMING GATE with "no buildable-dormant work remaining" — EXCEPT the dormancy audit's DEFERRED gap: the **rebuild-oracle producer was UNBUILT**. `oracleBuildOk` (the last leg of `deriveServingCoverage`) was effectively hardwired `false` because the serving-coverage reader's `resolveOracleBuild` dep was UNBOUND (`servingContextBootReaders.ts:139` → `deps.resolveOracleBuild?.() ?? false`), so even a clean+complete `ParityReport` + a valid pin still degraded the serving-coverage gate. The owner greenlit building this deferred producer — DORMANT — as the first go-live producer build. This session built the first two pieces of the 3-piece arc (A→B→C, mirroring the reconcile-TRIGGER arc's shape).

## What was built

### Files created
- **`apps/worker/src/composition/rebuildOracleStatus.ts`** (piece A, commit `210e95e`) — the pure worker-side rebuild-oracle STATUS producer `probeRebuildOracle(workspaceId, deps): Promise<RebuildOracleStatus>`. Composes an injected LOCAL `CommittedVaultReader` + an injected owner-gated `IndexRebuildClient` (the real gbrain scratch-import; UNBOUND in prod) through the existing `rebuildIndexFromMarkdown` → a fail-closed `oracleBuildOk` boolean on a typed `RebuildOracleStatus` (discriminant `outcome`: `corroborated`|`absent`|`diverged`|`faulted`). Only a wholesale-replace + complete recovery corroborates `true`; every absence / WS-8 read-back mismatch / rebuild divergence / reader fault degrades to `false`. Never throws (§16).
- **`apps/worker/test/composition/rebuildOracleStatus.test.ts`** (piece A) — 7 tests: green corroboration (crown jewel, non-vacuous) + 6 fail-closed/never-throws, driving the REAL deriver over a fake client.
- **`apps/worker/test/boot/rebuildOracleGate.test.ts`** (piece B, commit `118135c`) — 6 tests mirroring `reconcileGate.test.ts`: OFF zero-invocation byte-equivalence pin, malformed-client type-robust degrade, no-served-workspaces, ON green fold, fail-closed AND (diverged + absent), compute never-throws (non-vacuous, Lesson 15).

### Files modified
- **`apps/worker/src/boot.ts`** (piece B, commit `118135c`) — added the default-OFF `gateRebuildOracle(opts, deps): RebuildOracleWiring | undefined` boot-gate helper + 5 exported types (`RebuildOracleGateOpts`/`RebuildOracleWorkspaceStatus`/`RebuildOracleComputeResult`/`RebuildOracleWiring`/`RebuildOracleGateDeps`) + 2 imports, co-located with `gateReconcile`. Turns piece A's producer into a boot-resolvable `resolveOracleBuild: () => boolean` for `createServingCoverageReader` — ONLY when the owner provisions a real `IndexRebuildClient`. **Byte-equivalent BY CONSTRUCTION**: all additions sit BEFORE `bootWorker@1014` (verified — the 3 diff hunks are outside the function), so the shipped boot is byte-identical. `compute()` folds the probe over each served workspace fail-closed (true IFF served-set non-empty AND every ws strictly `corroborated`) into a one-shot cached boolean.

## Decisions made
- **Piece A — NO `expectedRevisionId` pin** (orch20 TWEAK on the brief's decision-#2 "PIN" default). The producer hands the FROZEN in-memory `snapshot.files` straight to `rebuildIndexFromMarkdown` (derives from that Map, no re-read) and hands the derived FACTS (not a vault path) to the client — so there is no re-read window inside the producer→rebuild→client chain for a pin to guard. Worse, pinning `snapshot.revisionId` (the full-vault hash from `readVaultHeadRevision`) against the rebuild's internal `computeRevisionId(snapshot.files)` (the `.md`-subset hash) would spuriously `stale_revision`-degrade whenever a non-`.md` file exists — a permanent false-red for zero real TOCTOU protection. The reader's own atomic-snapshot go-live TODO (`servingContextBootReaders.ts` L63-66) is the real revision-consistency dependency for arming.
- **Piece A — WS-8 read-back mismatch degrades to `absent`** (Lesson 20 precedent; a distinct ws-mismatch health signal stays deferred). `String()` coercion idiom (not an `as` cast) matches the sibling loader.
- **Piece A — empty-derived → trivially `corroborated`** (documented in-code): a mapped vault deriving to 0 facts recovers "0 of 0" ⇒ `true` with an empty `oracleSet`. Deliberate separation of concerns — `oracleBuildOk` asserts rebuild/disposability corroboration, NOT content-presence; the "empty allow-set ⇒ degrade" decision belongs to the loader's allow-set leg (AND-composed downstream). NOT a live false-green.
- **Piece B — 4 Step-2.5 flags all took the brief defaults (APPROVED):** (#1) gate ON `typeof makeRebuildClient === "function"` — the provisioning-gate pattern (like `keychainSecrets`), NOT a separate `copilotServingOracleGoLive` flag (selection stays separately gated), enabling observe-coverage before arm-selection per the runbook step-6-before-7 isolation; (#2) fail-closed AND fold; (#3) one-shot cached accessor (mirrors `resolveRunning`); (#4) B stays pure (returns per-ws statuses, routes no health).

## Decisions explicitly NOT made (deferred)
- **Piece C (the boot binding)** — the `bootWorker` call site + async boot-await/cache + `createServingCoverageReader` binding + reachability closure. Deferred to the next brief; the real `IndexRebuildClient` stays UNBOUND (owner provisions at arming).
- **Health routing of `diverged` statuses** — piece B stays pure; piece C routes the `rebuild_divergence` HealthItem where the health surface binds (mirrors reconcile F2).
- **Cross-track hardening (knowledge)** — the `packages/knowledge/rebuild.ts:160` truthy `!receipt.replaced` gate (should be strict `receipt.replaced !== true`) is a false-green vector at arming; escalated to the lead + Carry-forward as a knowledge-track arming blocker (NOT worker territory).

## TDD compliance
**CLEAN.** Both slices were test-first: RED confirmed for the right reason (missing module/export) before any implementation, then GREEN, then review-driven hardenings (piece A: non-vacuity asserts + `String()` idiom; both applied without changing the approved contract). No TDD violations. Both slices carried the mandatory dual review (security + code-quality) at Step 8 — the seams feed the serve-time trust gate.

## Reachability
- **piece A `probeRebuildOracle`** — reachability-WAIVERED: reachable only from its own test; the production caller is piece B/C's boot binding. No `bootWorker` edit.
- **piece B `gateRebuildOracle`** — reachability-WAIVERED (mirror `gateReconcile` F1): no `bootWorker` caller; reachable only from its own test. Piece C adds the call site + closes reachability. Byte-equivalent by construction.

## Open follow-ups
**Piece C (the boot binding) MUST:**
1. **Redact the `rebuild_divergence` HealthItem to safe-fields-only before any log sink** (safety rule 7 / Lessons 21/25) — mirror `gateReconcile`'s healthSink (`boot.ts:698-707`, synthesized safe message, never the item's free-form `message`). The wiring forwards the item verbatim by reference.
2. **Consume `resolveOracleBuild` ONLY as one AND-term of `deriveServingCoverage`**, never as a standalone serving-admit signal — else piece A's documented empty-derived→true becomes a real false-green.
3. **Call `compute()` EXACTLY once at boot**, then bind the cached `resolveOracleBuild` (it's re-runnable/not memoized, mirroring `resolveRunning`).
4. Resolve `servedWorkspaceIds` from `config.copilotGbrainWorkspaceId` (`boot.ts:1051`/`:1139`) and decide the per-ws-vs-boot-global fold (single served ws ⇒ result IS global).

**Arming (owner):** at arming, the real `IndexRebuildClient`'s scratch-index isolation across serial per-ws wholesale-replaces is an owner concern (client unbound today). Freshness of the one-shot cached `true` after a later divergence folds into the arming-era re-probe trigger.

**Orchestrator-routed (hot, confirmed):** §6 rebuild-oracle arc note (A + B) + the arc-lesson addendum → orch20 writes at ARC CLOSE (with piece C). Cross-doc invariant change: NONE.

## How to use what was built
When the owner provisions a real `IndexRebuildClient` factory (arming), piece C binds `gateRebuildOracle({ servedWorkspaceIds }, { makeRebuildClient, makeReader, now, newHealthItemId, auditRef })` at boot, `await`s `wiring.compute()` once, and passes `wiring.resolveOracleBuild` to `createServingCoverageReader({ ..., resolveOracleBuild })` — flipping the last hardwired-false serving-coverage leg to a real, corroborated signal. Until then the factory is absent ⇒ the gate returns `undefined` ⇒ `oracleBuildOk` stays `false` ⇒ serving degrades (byte-equivalent shipped default).

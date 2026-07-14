# Session 067 — impl18: Brick-B serve-time parity read+write chain (B2→B5)

- **Date:** 2026-07-14
- **Phase:** 11/13 (task 13.10 — the C5.4b `admitForServing`-backed serving oracle; Brick-B of the propose go-live path)
- **Team:** `session-734f946b`, orchestrator `orch16` + implementer `impl18`
- **Predecessor:** [066-2026-07-13-impl18-11.1-serve-time-parity-report-store.md](066-2026-07-13-impl18-11.1-serve-time-parity-report-store.md) (B1 store, crash-recovery)
- **Successor:** [068 — impl19: the reconcile-TRIGGER arc (A→F2) + run-path-standup vault-usable gate](068-2026-07-14-impl19-reconcile-trigger-arc-and-runstandup.md)
- **Commits (this arc, on `main`, each its own atomic mandatory-dual-reviewed slice):**
  - B1 `ca10090` — serve-time ParityReport store (dual-dialect repo + fakeable read-port) — _recovery, detailed in session 066_
  - B2 `daf4fa1` — wire the store into `createServingCoverageReader` (parity leg, async seam, fail-closed)
  - B3 `07d6b0b` — worker-side reconcile→store record path (record-only-on-ok gate)
  - B4 `8aef52d` — boot-bind the store into the reader + parity-chain e2e (B2 waiver closed)
  - B5 `57fef4b` — make the `oracleBuildOk` coverage leg bindable (`resolveOracleBuild`, fail-closed)

## Why this session existed

Brick-B of the C5.4b propose/write-bridge go-live path: build the durable serve-time `ParityReport` read+write chain that the Copilot trust-oracle's serving-coverage **kill-switch** reads — the source that decides whether a workspace can serve KnowledgeWriter-stamped content as `trusted`. The whole arc is **safety-critical** (a false "clean report present" is a trust-gate defeat) and ships **entirely dormant** (propose stays structurally OFF behind the triple-lock; no hard line crossed — building the substrate ≠ arming it).

The session opened by recovering a crash-lost, pre-written, lead-verified-green B1 slice (session 066), then built B2→B5 as classic TDD slices (plus B4 as a wiring/closing slice).

## What was built

### Files created
- `apps/worker/test/composition/parityReconcileRecording.test.ts` (B3) — the recorder-adapter + `recordReconcileOutcome` gate cases (record-only-on-ok, verbatim, fault-vs-skip, dirty-recorded, rule-7 redaction).
- `apps/worker/test/api/procedures/parityServingChain.e2e.test.ts` (B4) — the write→read round-trip integration e2e over a REAL better-sqlite3 `parity_reports` repo (greens the two parity legs; asserts honest no-false-green; stale-revision degrades).

### Files modified
- `apps/worker/src/api/procedures/servingContextBootReaders.ts` — B2 added the optional `store?: ParityReportStore` dep + made `createServingCoverageReader` async (parity leg reads the store, fail-closed); B5 added the optional `resolveOracleBuild?: () => boolean` dep + sourced `oracleBuildOk = deps.resolveOracleBuild?.() ?? false` (the last hardwired-false leg removed). Both inside the reader's existing try/catch (a throw degrades all legs).
- `apps/worker/src/api/procedures/servingContextLoader.ts` (B2) — widened the `ServingCoverageReader` seam to sync-or-async (mirrors `CommittedVaultReader`); the loader now `await`s `readServingCoverage`; the `revisionScopedParity` staleness re-check unchanged.
- `apps/worker/src/composition/parityReportStore.ts` (B3) — added the `ParityReportRecorder` write-port + `createParityReportRecorderAdapter(repo, now)` + `ParityRecordDisposition` + `recordReconcileOutcome` gate (type-only `@sow/knowledge` import of the reconciler output types); B2/B4 refreshed the module header.
- `apps/worker/src/boot.ts` (B4) — bound `store: createParityReportStoreAdapter(backends.repos.parityReports)` into the `createServingCoverageReader` call, as a nested arg INSIDE the triple-locked `loaderBackedServingOracle` branch (shipped default constructs nothing — byte-equivalent).
- `apps/worker/test/api/procedures/servingContextBootReaders.test.ts` — B2 reader-wiring cases + B5's 5 oracleBuildOk cases (incl. the `full_green_reachable` milestone).
- `apps/worker/test/api/procedures/servingContextLoader.test.ts` (B2) — loader awaits-async / degrades-on-reject / staleness-still-kills cases.
- `apps/worker/package.json` + `pnpm-lock.yaml` (B4) — added `@types/better-sqlite3` (types-only devDep; better-sqlite3 already a runtime dep) for the e2e's real repo.

## Decisions made
- **B2 store dep OPTIONAL + reader ALWAYS async + loader `await`s + staleness re-check kept** — orch defaults; keeps B2 atomic, boot byte-equivalent, and the async seam mirrors the `CommittedVaultReader` sibling (worker Lesson 7 union).
- **B3 records from `reconcileParity` (the FULL producer), NOT `checkGbrainParity`** (lead Ruling A) — the narrow db_only primitive would over-claim coverage at the trust gate (a false-clean defeat). The recorder/gate live worker-side (type-only knowledge import; no knowledge→db coupling).
- **B3 fault-vs-skip** — a reconcile `err` is a typed `skipped_reconcile_error` disposition (never coerced into a stored clean report, guardrail #1); a record `DbError` REJECTS (the disposition union has no fault variant); a dirty report IS recorded (operational truth). Report recorded VERBATIM (no trust-field synthesis, guardrail #2).
- **B4 wiring-slice posture** — the boot binding isn't unit-RED-able without a heavy `bootWorker` spin-up, so the e2e is an integration proof (GREEN-on-write, composing the shipped B1/B2/B3 seams over a real repo) and the boot binding is verified by typecheck + `/wired`. Real **better-sqlite3** repo over pglite (equally real, simpler, mirrors the B1 durability test; the repo contract is dialect-agnostic + already both-dialect-tested in `@sow/db`). Staleness handled by the store's revision-scoped query (a non-head report isn't returned when querying by head) — a stronger true-e2e closure than replicating the loader re-check. All orch-approved at Step-2.5.
- **B5 semantics A (boot-global liveness)** — `resolveOracleBuild?: () => boolean` mirrors `resolveRunning`; the per-revision `coverageComplete`-corroboration gap (the reconciler defaults the oracle term true when `rebuildOracle` is absent) is assigned to the reconcile-TRIGGER slice. Fail-closed all-legs on a throwing resolver.

## Decisions explicitly NOT made (deferred)
- **The reconcile-TRIGGER slice** — the Temporal pass that runs `reconcileParity` + calls `recordReconcileOutcome` + routes `healthItems`/degrade, and always supplies a `rebuildOracle` (closing the per-revision corroboration gap). Independent of B4; sequenced next.
- **The rebuild-oracle build-status PRODUCER** — the gbrain import-into-scratch (`rebuildIndexFromMarkdown`, real gbrain I/O) that would bind `resolveOracleBuild`. OWNER-GATED, deferred. The serve path takes no I/O.
- **The ARMING GATE (the HARD LINE)** — `goLiveArmed` + provenance-stamping + provision a signing key into Keychain + real corpora + the propose-path governance-eval (coordinate eval-security). Owner-confirmed flip, per crossing.
- **Parity-report GC/backfill** — unbounded growth; mirrors brief 043's revision-GC note. Non-blocking.

## TDD compliance
**Clean — no violations.** B2, B3, B5 were classic RED-first (discriminating failing tests written + confirmed RED before implementation; then GREEN). B1 was a **crash-recovery** of pre-written, lead-verified-green code (no RED/GREEN by definition — taken through the review/commit tail; documented in 066). B4 was a **wiring/closing slice** where the boot binding is verified by typecheck + `/wired` and the e2e is an integration proof (GREEN-on-write) — the recognized waiver-holder pattern, explicitly flagged and orch-approved at Step-2.5, not a violation. Every slice got the MANDATORY fresh adversarial dual review (security + code-quality), all **CLEAR/SHIP**; the reviews caught + fixed real issues each slice (B1: deterministic tiebreak + read-back identity gate + test-discrimination; B2: stale header + line-ref; B3: a vacuous rule-7 `.catch` test; B4: comment precision + a stale-case `pinValid` assertion; B5: a header phrasing nit).

## Reachability
- **B1 store** — dormant + waivered at build; **B2 closed** the read-port waiver (bound into `createServingCoverageReader`).
- **B2 reader** — reachable (boot `:934`); the store-CONSUMING branch was waivered until B4.
- **B3 record path** — dormant + waivered: no reconcile trigger, no boot change, no production caller (the future reconcile-TRIGGER slice wires it). Independent of B4.
- **B4 boot-bind** — **CLOSED the B2 store-consuming waiver** (`/wired`: `bootWorker` → `loaderBackedServingOracle` branch → `createServingCoverageReader({ store })` → `createParityReportStoreAdapter` → `backends.repos.parityReports`; only production callsite = boot `:938`). Behind the triple-lock; dormant.
- **B5 oracleBuildOk leg** — reader reachable; the `resolveOracleBuild`-CONSUMING branch is dormant + waivered (boot leaves it unbound; the owner-gated gbrain-import producer is deferred).

No tested-but-unwired gaps beyond the intentional, named, owner-gated dormancy above.

## Open follow-ups (Step-9 routed hot to orch16; orch writes the docs)
- **Cross-doc invariant changes:** NONE across all 5 slices (frozen `ParityReport` + the existing `ServingCoverageSources` reused; the new types — `ParityReportRepository`/`ParityReportRecorder`/`ParityRecordDisposition`/`resolveOracleBuild?` — are `@sow/db` + worker-composition seams, not Appendix-A models). No `ARCHITECTURE.md` field edit owed; orch wrote the §6 arch-NOTES hot in its round-seals.
- **Lessons banked by orch (round-seals):** the serve-time trust-signal store (B1, Lesson 12) · sync-or-async reader seam (B2) · record-only-on-ok gate (B3) · waiver-holder closing slice (B4, Lesson 16) · last coverage-leg seam (B5, Lesson 17).
- **Named next work (all owner-gated):** reconcile-TRIGGER slice → rebuild-oracle build-status producer (binds `resolveOracleBuild`) → the arming gate (HARD LINE). Full green admission needs the reconcile-trigger (real reports in the store) AND the arming.
- **C5.4b go-live-time residuals (dormant, from the Carry-forward):** the committed-vault reader's double-read TOCTOU; per-workspace vault roots at go-live. Non-blocking.

## How to use what was built
The serve-time parity chain is END-TO-END wired + reachable, all DORMANT. The coverage gate (`deriveServingCoverage` ANDs cleanForServing + coverageComplete + pinValid + oracleBuildOk) is now **fully wired / green-CAPABLE** — proven by the B5 `full_green_reachable` milestone (all 4 legs true ⇒ `isDegradedCoverage` false) with fakes. In production every leg fails closed (boot leaves the store + `resolveOracleBuild` unbound ⇒ degrade), and even a green coverage cannot admit until the owner arms `goLiveArmed` (the interim degraded oracle stays selected). Green-CAPABLE ≠ armed — no hard line crossed. To exercise the full green path (test-only): bind a `store` returning a clean revision-matched report + a valid pin + `resolveOracleBuild: () => true`.

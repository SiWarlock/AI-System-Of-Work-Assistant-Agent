# Session 068 — impl19: the reconcile-TRIGGER arc (A→F2) + run-path-standup vault-usable gate

- **Date:** 2026-07-14
- **Phase:** 13 (OPEN-THE-GATES / propose go-live grind → RUN-PATH STANDUP)
- **Implementer:** impl19 (worker area) · **Orchestrator:** orch17 · team `session-734f946b`
- **Predecessor:** [067 — impl18 Brick-B serve-time parity chain](067-2026-07-13-impl18-brick-b-serve-time-parity-chain.md)
- **Successor:** _(impl20 — next cycle, armed-path arming-prep)_

## Why this session existed

Owner steer at the propose go-live gate: **keep grinding the last dormant plumbing** before the owner-gated arming, then **stand up + run the read path on the real vault first** (not arm yet). Two arcs landed:

1. **The reconcile-TRIGGER arc (task 13.10)** — the ⭐ Carry-forward item: an 8-slice DORMANT arc that composes the serve-time parity reconciliation end-to-end (read → reconcile → record → health), completing the last piece of plumbing before the propose arming gate. Records REAL `ParityReport`s so the serve-time coverage source reads real signal — but stays fully dormant (nothing armed).
2. **RUN-PATH STANDUP piece 2 (task 13.10d)** — a small honest-gate polish so the read-only `copilot.vault.read` tool is offered only on a usable vault (reads-only; propose stays OFF).

Every slice: full TDD (RED-first), MANDATORY security + code-quality dual review, per-file `git add`, own commit, repo-wide `pnpm -w turbo run typecheck test` 31/31 green throughout. **NO hard line crossed anywhere** — the arming (flag flip + real transport/signing-key/corpora/governance-eval provisioning + trigger-source wiring) is the owner's, escalated by orch17.

## What was built

### The reconcile-TRIGGER arc — 8 slices, all DORMANT (task 13.10)

**Files created** (all `apps/worker/src/composition/` + a co-located test each):
- `parityReconcile.ts` (**A**, `ca8d835`) — `runReconcilePass(req, deps)`: the pure composition seam. reconcileParity → B3 `recordReconcileOutcome` → route `outcome.healthItems` through an injected `ReconcileHealthSink` in order → `ParityRecordDisposition`. Record-before-route, fail-closed both directions (store fault rejects before routing; sink fault propagates; reconcile-err is a typed skip).
- `reconcilerDbProjection.ts` (**B**, `8a27e78`) — `buildReconcilerDbProjection(adapter)`: maps the read-only `GbrainReadAdapter` (`graph`→`DbFact[]`, `schemaRead`→version) into a `ReconcilerDbProjection`. Fail-closed on coverage (any read err / adapter reject-or-non-Result / truncation-or-open-cursor [type-robust] / malformed row-or-envelope / non-positive version ⇒ `complete=false`), never throws, conservative `stamped`, workspaceId from the grant-bound adapter (WS-8).
- `canonicalFactSet.ts` (**C**, `85f6b63`) — `buildCanonicalFactSet(reader, ws)`: injected `CommittedVaultReader` → pure `deriveCanonicalFacts` → a 3-way `{ derived | absent | derive_error }` outcome (broken vault distinct from benign absence), never throws, WS-8 read-back re-gate (Lesson 12).
- `reconcileDriver.ts` (**D**, `8d07a60`) — `runReconcileForWorkspace(ws, deps)`: the pure, trigger-agnostic end-to-end driver composing C→B→A over injected async collaborators into a 4-way `ReconcileDriverOutcome` (`reconciled | skipped_absent | skipped_derive_error | pass_faulted`). Short-circuits absent/broken canonical refs (no wasted gbrain read), catches the pass fault into a typed outcome (never throws). `rebuildOracle` omitted; workflow-weight deferred to E.
- `reconcileScheduler.ts` (**E**, `89106e5`) — `createReconcileScheduler(deps)`: the pure trigger-origin scheduler. `enqueue`/`flush` per workspace, LIFE-2 burst-collapse (`collapseToMaxRevision` — a burst fires ONE max-revision pass), single-dispatch the never-throwing driver, snapshot+delete-before-await concurrency, per-workspace isolation, and a SINGLE redacted `log` chokepoint (safety rule 7). **Workflow-weight RESOLVED = the lighter worker-scheduled pass** (not Temporal — the reconcile is idempotent read+record).

**Files modified:**
- `apps/worker/src/boot.ts` (**F1**, `e9c6d77`) — added the pure `gateReconcile(opts, deps)` default-OFF boot gate (mirror `gateAutoIngest`) + `ReconcileGateOpts`/`ReconcileWiring`/`ReconcileGateDeps` types + a new gate test (`test/boot/reconcileGate.test.ts`). OFF ⇒ undefined + zero dep-thunk invocations (byte-equivalence factory-spy pin); ON ⇒ assemble the scheduler over the never-reject builders, transport unbound so even armed records degraded. No `bootWorker` edit ⇒ byte-equivalent by construction.
- `apps/worker/src/boot.ts` (**F2**, `dadb167`) — the composition-root binding that CLOSES the arc: `BootConfig.reconcile`/`BootedWorker.reconcile` fields; 2 exported sink helpers (`createReconcileLogSink` redacted+health-materializing, `createReconcileHealthSink` reproject); the `bootWorker` `gateReconcile(...)` call with real leaf-thunks (`createCommittedVaultReader`; `makeDbAdapter→undefined` [transport unbound]; recorder over `backends.repos.parityReports`; HealthSurface-backed sinks); the returned wiring exposed on `BootedWorker`. Byte-equivalent by default (reconcile unset ⇒ gate undefined ⇒ no machinery + field omitted); reachability chain closed (`bootWorker → gateReconcile → scheduler → driver → builders`). New test `test/boot/reconcileBootWiring.test.ts`.

### RUN-PATH STANDUP piece 2 — the vault-usable gate (task 13.10d, `90679a3`)

**Files modified:**
- `apps/worker/src/boot.ts` — `gateCopilotVaultReadDeps` gains a 4th fail-safe `vaultUsable: (root)=>boolean` param (AND-ed after the 3 preconditions, which early-return first so the flag-off default never touches the fs) + a co-located `createFsVaultUsable()` factory (true IFF exists + ≥1 `.md` FILE, recursive — mirrors `createCommittedVaultReader`'s `e.isFile() && name.endsWith(".md")`) + a `readdirSync` import + the boot call-site arg.
- `apps/worker/test/boot-copilot-read-gating.test.ts` — extended (10 new cases: the 4-condition gate matrix + fail-safe throw + the fs predicate incl. an `notes.md/`-directory edge).

## Decisions made

- **Reconcile B3 record from the FULL producer, driver omits rebuildOracle** — inherited from impl18's lead Ruling A; the driver's assembled req rests coverageComplete on `dbProjection.complete` (the real `RebuildOracleSet` is owner-gated).
- **Workflow-weight = the lighter worker-scheduled pass, NOT Temporal** (resolved at E) — the reconcile is idempotent read+record (not an external side effect); `collapseToMaxRevision` IS the LIFE-2 catch-up-collapse; crash→degrade→next-trigger-recovers is fail-safe. The driver (D) is trigger-agnostic (works under either model), so the choice belongs at the trigger (E).
- **Piece F split F1/F2** (orch17-approved) — F1 = the gate helper (added byte-equivalent-by-construction, no `bootWorker` edit); F2 = the composition-root binding. Isolates the composition-root byte-equivalence risk to its own reviewed slice.
- **Single redacted `log` sink (not a raw onOutcome hook)** at E — makes E the sole redaction chokepoint so the downstream cannot leak the raw cause.
- **vaultUsable mirrors the reader's `isFile()` filter recursively** (13.10d) — so `usable ⟺ the-reader-would-find-a-page`; closed a fail-open edge (a `notes.md/` directory).
- **Fail-closed / never-throws everywhere**, WS-8 re-gates folded (C's read-back re-gate; B's grant-bound workspaceId), redaction via `@sow/domain redactError`.

## Decisions explicitly NOT made (deferred)

- **The ARMING GATE (the owner's HARD LINE)** — the flag flip (`copilotProposeMode`/`copilotServingOracleGoLive` + `reconcile`), provisioning the real `GbrainReadGrant` transport + signing key + real corpora, the governance eval (coordinate eval-security), and wiring the trigger source/timing. orch17 escalates to lead+owner. **Nothing armed this session.**
- **The reconcile healthSink propagate-vs-swallow semantics** (F2) — my `createReconcileHealthSink` swallows a record fault (best-effort); piece A's contract (Lesson 18) wants it to PROPAGATE. Documented in-code as a DORMANT-era deferral to the arming review (dormant + not a serve-time fail-open since record-before-route lands the ParityReport). **orch17 captured this as a HARD arming-gate blocker.**
- **`pass_faulted` mints no HealthItem** (F2, log-only) — a durable-store-write fault is health-worthy; deferred to the arming review (orch17 blocker).
- **The precise OBS-2 dedupe subjectRef** for reconcile health items — an arming refinement (finalizes when real defects flow).
- **Trigger source/timing binding** (E/F) — the real `startVaultWatcher`/schedule/post-commit → `enqueue`, the flush debounce → `flush` — the owner's arming-era wiring.

## TDD compliance

**Clean.** Every one of the 9 slices was RED-first: the failing test was written + confirmed RED (for the right reason — missing module/export/behavior) before any implementation. Mandatory security + code-quality dual review ran on every slice (safety-critical); all reviewer must-fix/convergent findings were folded in-slice (each fold monotonic + test-pinned) or explicitly deferred to the arming review with a Step-9 flag. No TDD violations.

## Cross-doc invariant audit

**NONE.** No Appendix-A model's field-set changed this session — the arc reused the frozen `ParityReport` / `DbFact` / `CanonicalFactSet` / `CanonicalVaultSnapshot` / `DeriveError` / `ReconcileRequest` / `ParityRecordDisposition` / `HealthItem` / `HealthFailure` as-is. `ReconcileGateOpts`/`ReconcileWiring`/`ReconcileGateDeps`/`ReconcileDriverOutcome`/`LoggedReconcileOutcome`/`ReconcileHealthDeps` + `BootConfig.reconcile`/`BootedWorker.reconcile` are worker-composition / boot-config seams, not contract models. `git diff -- ARCHITECTURE.md` clean (orch17's §6 arc notes rode its round-seal commits). Each slice flagged "Cross-doc invariant change: NONE" at Step 9.

## Reachability

- **Reconcile-TRIGGER arc:** A–E + F1 shipped DORMANT + reachability-waivered (reachable from their own tests only). **F2 closed the chain** — `gateReconcile` is now called at `bootWorker` (boot.ts), so the full path `bootWorker → gateReconcile → scheduler → driver → builders` is reachable-by-construction; byte-equivalent by default (reconcile unset ⇒ the wiring is `undefined`, the field omitted). No tested-but-unwired gaps remain in the arc.
- **§13.10d:** the `gateCopilotVaultReadDeps` gate is the EXISTING live `bootWorker` call site (now with the 4th arg); `createFsVaultUsable()` reachable from `bootWorker`. Live path, byte-equivalent on a real vault.

## Open follow-ups (for the successor + the arming review)

**Arming-gate blockers (owner-gated, HARD LINE — orch17 escalates):**
1. Resolve `createReconcileHealthSink` to PROPAGATE a `surface.record` fault (per Lesson 18 / piece A's contract) before arming — a swallowing healthSink on the armed path silently drops operator visibility on a real parity defect.
2. `pass_faulted` should mint a HealthItem (a durable-store write fault is health-worthy).
3. Finalize the OBS-2 dedupe subjectRef for reconcile health items.
4. Provision the real `GbrainReadGrant` HTTP transport + the HMAC signing key (macOS Keychain) + real KW corpora + the propose-path governance eval (coordinate eval-security), then wire the trigger source/timing, then the owner-confirmed flip.

**Architecture-doc note candidates (orch17 routes hot):** §6 — the reconcile-TRIGGER arc is COMPLETE-DORMANT (F2 closes reachability; arming is the HARD LINE); the `copilot.vault.read` tool is offered only on a USABLE vault (13.10d).

No open follow-ups block the current dormant state — the arc is complete + green + reachable + nothing armed.

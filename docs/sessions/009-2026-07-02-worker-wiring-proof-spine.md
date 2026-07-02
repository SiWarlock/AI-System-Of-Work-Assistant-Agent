# Session 009 — Worker-wiring wave (proof spine): the §9 workflows run for real

- **Date:** 2026-07-02 · **Mode:** single-operator + Workflow fan-outs · **Track:** worker
- **Predecessor:** `008-2026-07-02-phase7-workflows.md` (Phase 7 certified — 13 pure drivers, reachability WAIVED pending worker wiring)
- **HEAD at close:** `11d7e6b` (this wave = commits `d755c7b` WW-1, `11d7e6b` WW-2/3) on `8cc9654`
- **Gates:** repo-wide **2447 pass / 5 skip / 2 todo**; typecheck **10/10**; `pnpm audit --prod` clean; **`SOW_TEMPORAL=1` live: 4/4**.

## What this was

Phase 7 shipped all 13 Temporal workflow *drivers* as pure, fake-tested control logic with **no production Temporal entrypoint** (reachability explicitly waived: "re-run when the worker wiring lands"). This wave lands that wiring — but scoped to a **proof spine**, per a finding that reshaped it.

## The finding that reshaped the wave (owner-confirmed scope)

Two read-only scouts mapped the seam. The gap map showed the handoff **under-counted the work**: only **3 of 13 drivers are fully wireable today** — `runMeetingCloseout` (the §9 acceptance proof spine), `runApprovalFlow`, `runIngestionTriage`. The other 10 depend on **40 ports that have no production activity — only `test/support` fakes**, and those 40 split by *natural phase*, not "just write them":

- **Agent-job runners + synthesizers** (`RunSourceAgentJobPort`, `RunBriefingAgentPort`, `RunReviewAgentPort`, `ProposeWindowsAgentPort`, `SynthesizeAnswerPort`, …) → LLM-driven → the project's TDD posture routes these to the **eval path (Phase 12)**; eval corpora don't exist yet.
- **Read-model / dashboard / notify back-halves** (`UpdateDashboardPort`, `NotifyPort`, `ReviewUpdateProjectionsPort`, …) → write the read-models **Phase 8** builds + the Mac/Telegram notifications **Phase 8.5/Phase 9** own.
- **Deterministic remainder** (validators, commit ports, build-projections, connector-refresh) → TDD-able, but wiring them yields **no runnable driver** (each sibling agent-runner is still fake/eval-path).

**Decision (AskUserQuestion, confirmed): proof-spine wave.** Wire only the 3 wireable drivers end-to-end + the shared infra; defer the 40 to their owning phases (documented carry-forward). See memory `worker-wiring-scope`. Also reconciled against the plan: **session-auth wiring → Phase 8.1** (build the guard with the door), **`health_items`/`last_run` persistence → Phase 10.3/10.7** — none belong to this wave.

## Delivered

### WW-1 — DB cross-process no-dup-write foundations (`d755c7b`, `@sow/db` + one `@sow/workflows` line)
- `write_receipts` table + `WriteReceiptRepository.reserve()` — the DB-backed no-duplicate-external-write claim (safety rule 3), dual-dialect through the one repository contract suite. Atomic `ON CONFLICT DO NOTHING` on the `(targetSystem, canonicalObjectKey)` PK; a shared pure `decideReserve` so both dialects provably agree (mirrors `decideApprovalCas`). `release` refuses to delete a committed row; `put` idempotent.
- `workflowRunRefs.idempotencyKey` UNIQUE + `create()` surfaces a typed conflict; `resolveRun`'s race-loser re-reads the winner run → `reused:true` (closes the cross-process double-run race).
- **Adversarial verify (3 lenses) — HIGH caught + fixed:** the reserved placeholder's synthetic key `reserve:${targetSystem}:${canonicalObjectKey}` is **not injective** (`('slack','C123:456')` and `('slack:C123','456')` both fold to `reserve:slack:C123:456`) and could also collide with a real committed key → blocked an object never reserved. **Fix:** `idempotencyKey` made NULLABLE — a placeholder carries no replay key (UNIQUE admits many NULLs on both dialects; object identity = the composite PK), `put` sets the real key at commit. Regression test pins the exact colliding pair on both dialects.

### WW-2/3 — proof-spine composition root + Temporal wrappers (`11d7e6b`, `@sow/workflows` + `apps/worker`)
- **`meetingOutputsProjection`** (`@sow/workflows`): the real derive-from-validated projection (`NoteCreate` + external-action descriptors) — no-inference (only evidence-backed validated fields; absent → TBD), workspace-stamp (plan targets the PASSED workspaceId), fail-closed (unmappable → err, no partial note).
- **`apps/worker` composition root** (`src/composition/{backends,buildActivities}.ts`): real KnowledgeWriter (real ownership + secret-scan defaults) over an FS vault, real Tool Gateway (DB-backed `ReceiptStore` over the WW-1 reserve), real Broker (`localConfig` always supplied), real `@sow/db` repos + genesis migration; per-vendor transports (provider / target-write / gbrain-index / correlate-signals) are **deterministic stubs marked `REAL-SDK INJECTION POINT`** (carry-forward). `buildProofSpineActivities()` is the plain-async-function object Temporal registers.
- **Thin `@temporalio/workflow` wrappers** (`src/temporal/workflows.ts`, sandbox-safe: `proxyActivities` + workflow-time clock, no `node:crypto`/`Date.now`) + `Worker.create` wired into `bootstrapWorker` (was connect-then-close). `bundleWorkflowCode` sandbox-purity holds via a module-replacement plugin stubbing never-called `node:fs`/`node:crypto` pulled in transitively by the `@sow/contracts`/`@sow/domain` barrels.
- **`SOW_TEMPORAL`-gated integration test — 4/4 live:** happy-path commit, idempotency (one committed note on replay), approval exactly-once, triage replay.
- **Adversarial verify (3 lenses) — idempotency/no-dup-write + approval/sandbox CLEAR; projection-bypass caught a HIGH:** the model-controlled meeting `title` was interpolated **raw** into `note.path`, so a `../` title escaped the bound workspace vault after `join(root, path)` (cross-workspace / arbitrary-filesystem durable write; safety rule 4 / WS-4). **Fixed at two layers:** the projection SLUGS the title (no separators/dots → no traversal; empty slug fails closed) AND `createFsVault` refuses any path resolving outside the vault root (defense-in-depth). Regression tests pin both.

## Carry-forward (recorded in IMPLEMENTATION_PLAN)

1. **The 10 remaining drivers' 40 fake-only activities** — deferred by natural phase: agent-runners + synthesizers → eval/Phase 12; read-model/dashboard/notify → Phase 8/9; deterministic remainder → follow-on wave once its sibling runner exists.
2. **Real vendor SDK transports** — the proof spine uses deterministic stubs at each `REAL-SDK INJECTION POINT` (provider/calendar/gbrain/target-write). Real clients land with connector/eval integration.
3. **Workflow-safe barrels** — `@sow/contracts` + `@sow/domain` barrels unconditionally `export *` a `node:fs` schema-registry / `node:crypto` idempotency-hasher into *every* consumer, incl. the Temporal sandbox module (provably never called there; neutralized via bundler module-replacement). A barrel-first / fs-free split would remove the need for the plugin.
4. **Sole-writer path containment** — the vault containment guard lives in the `apps/worker` `createFsVault`; the *architecturally central* place is the sole writer (`@sow/knowledge`) rejecting any plan path that escapes the workspace root. Add as Phase-4/10 hardening (defense-in-depth; the running system is already safe via the two layers shipped here).
5. **Reachability (Phase-7 waiver) — partially discharged:** the 3 wired drivers now have a production Temporal entrypoint (`bootstrapWorker → Worker.create → wrappers → drivers`), proven live. The other 10 remain unreachable-by-design until (1).

## Resume pointer

Proof spine runs. Next: **Phase 8 (§10 Local App API, worker track) ∥ Phase 10 (cross-cutting, eval-security)** — different tracks, may run 2 concurrent Workflows. Phase 8.1 folds in the deferred renderer↔worker session-auth wiring; Phase 10.3/10.7 fold in the deferred `health_items`/`last_run` persistence. Method unchanged (Workflow fan-outs ≤2 concurrent, adversarial-verify safety-critical waves, full solo close-out). See `docs/HANDOFF.md` + memory `worker-wiring-scope`.

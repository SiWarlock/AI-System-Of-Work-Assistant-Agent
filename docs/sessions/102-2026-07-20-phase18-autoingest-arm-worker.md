# Session 102 — Phase-18 auto-ingest ARM (worker legs): egress-allowlist seam + committed L64 armed dry-run

- **Date:** 2026-07-20
- **Phase:** 18 (§19.5 real model transport / auto-ingest arming)
- **Role:** worker-impl (single-track `main`)
- **Predecessor:** [`101-2026-07-19-phase18-pre-arm-hardening-worker-impl.md`](101-2026-07-19-phase18-pre-arm-hardening-worker-impl.md) (Phase-18 pre-ARM hardening: 18.28/18.29/18.30)
- **Successor:** _(next round)_

## Why this session existed

The Phase-18 subscription crossing is SHIPPED and the auto-ingest dormant seam is pre-ARM-assured (18.30). This round built the **worker legs of the 18.10 auto-ingest ARM** — the seam the desktop arming forward (18.32) needs, plus the committed go/no-go that proves an armed run actually produces a note before the owner enables autonomous recurring extraction. BUILD/VERIFY DORMANT only — no auto-ingest flip (owner-gated ENABLE).

## What was built

### Files modified
- `apps/worker/src/boot.ts` — **18.31**: `AutoIngestGateOpts` gains optional `egressAllowedProcessors?: readonly string[]`; `gateAutoIngest`'s `buildProofSpineParams` thunk widened to `(ws, egressAllowedProcessors?)` with a conditional 2nd-arg pass (byte-equivalent by construction, L57); `buildAutoIngestProofSpineParams(boundWorkspace, egressAllowedProcessors = [])` brands `string→ProcessorId` at the single worker-side site and populates BOTH `EgressPolicy.allowedProcessors` AND `.rawContentAllowedProcessors` (source ingestion carries raw content). Default-empty ⇒ byte-equivalent to the prior hardcoded-empty policy.
- `apps/worker/test/boot-auto-ingest-gating.test.ts` — **18.31**: +3 tests (byte-equivalent default, both-lists populated, arity pin for the conditional).
- `apps/worker/test/composition/egress-veto-assembled.test.ts` — **18.31**: +3 assembled-broker egress pins (ALLOW-when-allowlisted / DENY-empty `PROCESSOR_NOT_ALLOWED` / employer-veto-precedence unaffected).

### Files created
- `apps/worker/test/integration/autoIngest-armed-live.test.ts` — **18.33**: the committed Lesson-64 armed-auto-ingest dry-run go/no-go. Env-gated behind a dedicated `SOW_L64_DRYRUN` gate (default-skip; not `SOW_TEMPORAL`, since it drives the armed activities deterministically without Temporal). Boots the worker ARMED (`gateSubscriptionOnlyExtraction({enabled:true})` over a FAKE $0 completion + fake content resolver + fake reachability check) with the 18.31 egress-allowlist seam populated + the `withSubscriptionExtractionArming(params, true)` transform, drops a benign `.md` via the real watcher capture, and asserts a REAL note is produced through the full armed path (ING-7 admission → §5 egress veto → `sow:agent-extraction` schema-gate → `validateNoInference` → KnowledgeWriter `applyPlan`) — all gates REAL over the assembled root; the SDK/network are the only fakes. 4 tests: produce-note, absent-datum→TBD, no-refire (L37), empty-allowlist deny control (non-vacuous, `completionCalls===0`).

### Commits
- `dd2ceaa4` — `feat(worker): 18.31 auto-ingest egress-processor allowlist seam (proof-spine EgressPolicy)`
- `db45eb6e` — `test(worker): 18.33 committed L64 armed-auto-ingest dry-run go/no-go harness`

## Decisions made
- **18.31 threading via a conditional 2nd thunk arg** (not always-pass `?? []`): keeps the default/OFF path calling the thunk exactly as the pre-seam code did ⇒ byte-equivalence by construction (mirrors the L57 conditional-spread), and touches zero existing spy/wiring assertions. `AutoIngestWiring` gets no new field — the allowlist lives inside `proofSpineParams.resolved.egressPolicy`.
- **18.31 brand seam: accept `readonly string[]` at the opt, brand worker-side** (orchestrator-recommended, confirmed with desktop-impl). Desktop forwards its IPC-safe `WorkerHostConfig.egressAllowedProcessors: readonly string[]` straight through untouched; the worker brands `string→ProcessorId` at the single site where `ProcessorId` lives.
- **18.33 design: Option B (deterministic armed-ACTIVITIES drive), not Option A (full live-Temporal e2e)** — orchestrator-approved. The L64 risk is downstream of the arm (candidate→note); Temporal orchestration is already pinned by sourceIngestion-live + vaultWatcher-live. Option B drives the exact L64-risk surface deterministically ⇒ a reliable, repeatable go/no-go command; the deny control is a param swap.
- **18.33 dedicated `SOW_L64_DRYRUN` env gate** (not `SOW_TEMPORAL`) — Option B bypasses Temporal, so a Temporal gate would read misleadingly; the dedicated gate is self-documenting and stays out of both the default and `-live` suites.
- **18.33 composition tie to 18.31/18.32** — the allowlist value derives from the canonical `CLOUD_EXTRACTION_ROUTE.runtime` constant (not a magic string); armed params via `withSubscriptionExtractionArming(buildAutoIngestProofSpineParams(WS,[EXTRACTION_PROCESSOR]), true)` reuse the 18.31 seam + the shared `AutoIngestGateOpts`/`BootConfig.subscriptionArm` types (tsc-enforced structural tie; no hand-mirror).

## Decisions explicitly NOT made
- **Did NOT flip auto-ingest ON / arm the subscription path** — the owner-gated ENABLE (lead+owner-run) is unchanged; all built dormant/byte-equivalent.
- **18.31: no defensive validation of malformed allowlist elements worker-side** — `processorId` throws on empty/whitespace, which is the correct fail-closed direction (boot doesn't complete → no egress). A friendlier config-error boundary is owed at the desktop layer (18.32 Future-TODO), not worker-side.
- **18.33: did NOT pin the deny reason/stage in test 4** — non-vacuity is airtight by paired construction + `completionCalls===0`; the reason-shape assert (the activity wraps the broker error) is optional defense-in-depth, deferred.

## TDD compliance
- **18.31 — CLEAN.** RED tests first (`egress_allowlist_populates_both_processor_lists` assertion-failed, `assembled_broker_allows_..._when_allowlisted` isOk-failed) → minimal GREEN → full suite. Byte-equivalence pins green before + after (by design). A code-quality-reviewer-flagged coverage gap (the explicit-`[]` conditional branch) was hardened in-slice with an arity pin.
- **18.33 — test-only harness (no production change).** Not a red-green production cycle: it is a committed characterization/go-no-go that PINS the L64 fix (green-on-write by design). A real defect DID surface during authoring (the watcher-captured context lacks the top-level WS-2 `context.workspaceId` the Temporal workflow binds) and was fixed before commit; a typecheck error (`input.run.workspaceId` is plain `string`; dispatch return type) was fixed by making the dispatch a recorder + driving activities with `workspaceId(WS)`. No TDD violation.

## Cross-doc invariant audit
- **No model field changes this session.** `EgressPolicy` (Appendix-A) field set is UNCHANGED — 18.31 only threads values into the pre-existing `allowedProcessors`/`rawContentAllowedProcessors`. `AutoIngestGateOpts`/`AutoIngestWiring` are worker-internal composition types, not Appendix-A models. Confirmed NONE at Step 9 (orchestrator ack). No schema-snapshot delta. **No drift.**

## Reachability
- **18.31 (`egressAllowedProcessors` seam):** reachable from the production worker-host entry `apps/desktop/worker-host/index.ts:217` (`boot.gateAutoIngest({...}, config.vaultRoot, boot.buildAutoIngestProofSpineParams)` → `bootWorker`) on the armed auto-ingest path. The new param's real-config caller — the desktop forward of `config.egressAllowedProcessors` — landed in **18.32** (`0d8e7c56`). The param is reachability-proven here via the assembled-broker egress test driving the real `assembleBackends(...).broker.runJob` with the seam-populated egress policy.
- **18.33 (harness):** test-only — no new production wiring. It drives the REAL armed production path (`assembleBackends({providerTransport})` → source activities → broker/all-gates → KnowledgeWriter). No tested-but-unwired production symbol introduced.

## Open follow-ups
Step-9 items were routed hot during the session (orchestrator owns writing them at `/orchestrate-end` — deferred this round by the earlier park):
- **Worker Lesson candidate (L68, 18.31):** an arming-adjacent allowlist defaults empty/fail-closed and populates both raw + non-raw processor lists together for a raw-content path; threads via a conditional 2nd-arg (byte-equivalence by construction, extends L57/L23/L28).
- **Worker Lesson candidate (L69, 18.33):** the L64 go/no-go is a COMMITTED env-gated fake-completion armed dry-run (real arm+broker+all-gates+KnowledgeWriter, $0), NOT a throwaway — repeatable pre-spend note-produced proof + a non-vacuous egress-allowlist deny control.
- **ARCHITECTURE §19.5 note + phase-18 ENABLE runbook:** the standing pre-ENABLE go/no-go command is `SOW_L64_DRYRUN=1 npx vitest run apps/worker/test/integration/autoIngest-armed-live.test.ts`.
- **Future-TODO (18.32, desktop):** validate `WorkerHostConfig.egressAllowedProcessors` elements are non-empty strings before forwarding (convert a worker-side `processorId` boot-throw into a friendly desktop config error). Flagged by both reviewers.
- **Future-TODO (optional hardening, 18.33):** test 4 could additionally pin the denial reason/stage (`PROCESSOR_NOT_ALLOWED` at the egress veto) — accepted as deferred; non-vacuity is airtight by paired construction + `completionCalls===0`.

## How to use what was built
- **The go/no-go command (owner/lead, pre-ENABLE):** `SOW_L64_DRYRUN=1 npx vitest run apps/worker/test/integration/autoIngest-armed-live.test.ts` — a $0, no-real-call proof that the armed auto-ingest path produces a real note (broker-accepts + note-produced, not spend-and-produce-nothing) with a non-vacuous empty-allowlist deny control. Run it green before arming the subscription path.
- **The 18.31 seam (for the desktop 18.32 forward):** `AutoIngestGateOpts.egressAllowedProcessors?: readonly string[]` (plain IPC strings) → threaded into `buildAutoIngestProofSpineParams` → the proof-spine `EgressPolicy` both-lists. Populating it with `claude-agent-sdk` is what lets an armed cloud `{runtime}` route pass the §5 egress veto.

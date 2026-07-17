# Session 092 — Phase-18 S5–S7 (worker-impl2): source extraction leg + ING-7, ProposedAction producer, source note content

- **Date:** 2026-07-17
- **Phase:** Phase 18 (§19.5 real ModelProvider — SAFE-BUILD; the deterministic extraction/routing/content legs, no crossing)
- **Role / session:** `worker-impl2` (worker track — successor to `worker-impl`, which died on context overflow mid-S5)
- **Predecessor session:** [091-2026-07-16-phase17-keychain-build.md](091-2026-07-16-phase17-keychain-build.md)
- **Successor session:** [093-2026-07-17-worker-impl3-phase18-s8-s9-egress-veto-autoingest-guard.md](093-2026-07-17-worker-impl3-phase18-s8-s9-egress-veto-autoingest-guard.md)

## Why this session existed
Resume the Phase-18 SAFE-BUILD as the worker implementer after `worker-impl` died mid-S5 (fresh context). Carry the deterministic source/meeting legs from the RED test through commit: S5 (18.4 source extraction + ING-7), S6 (18.7 ProposedAction producer), S7 (18.8 commit callers carry real content). All SAFE-BUILD — no real cloud key, no real model call, no real spend, no hard-line crossing.

## What was built

### S5 — 18.4 source extraction leg + ING-7 (commit `2068039f`)
**Files created:**
- `apps/worker/src/composition/source-extraction.ts` — `createSourceAgentBrokerRouting`: routes the source agent job THROUGH the broker (ING-7 `admitJob` before the broker; gate-on-outcome `mapCandidate`; WS-8 dynamic workspace bind from `ctx.workspaceId`, never content). Source analog of 18.3's meeting `createRunAgentJobActivity`.
- `apps/worker/test/composition/source-extraction.test.ts` — 11 unit tests (routed-through-broker, ING-7 mutating-reject/read-only-admit, WS-8-from-ctx + unbound-fails-closed, gate-on-outcome, safe-build, + reused-gate over source fixtures).

**Files modified:**
- `apps/worker/src/composition/buildActivities.ts` — replaced the `sourceAgent` broker-bypass with `createSourceAgentBrokerRouting`; `buildMatrix`/`buildEgress` scoped to `ctx.workspaceId` (fixes a Temporal-only route-resolution mismatch); DEFAULT_ROUTE egressClass `"local_zero_egress"` → `"local"` (valid enum).
- `apps/worker/src/temporal/workflows.ts` — the in-sandbox `validate`'s `passThroughSchemaGate` → the real `createMeetingExtractionSchemaGate` (shared meeting+source; pure/sandbox-safe).
- `apps/worker/src/boot.ts` — `buildAutoIngestProofSpineParams` provisions a `source.process` loopback-local route + `allowedProviders: ["ollama"]`; stale "bypasses the broker" comment fixed; a VERIFICATION-OWED note on the owner-opt-in live stub candidate.
- `apps/worker/test/integration/sourceIngestion-live.test.ts` — added the `source.process` local route + a valid-KMP stub candidate (the accept-path proof).

### S6 — 18.7 ProposedAction producer (commit `8d9c6507`)
**Files created:**
- `apps/worker/src/composition/proposed-action-producer.ts` — `produceProposedActions`: a PURE, binding-driven producer emitting ONE PENDING ProposedAction (+ envelope) when a config binding + an explicit validated action-intent field are present. Structural no-dispatch (no gateway dep); keys from the binding + a traversal-safe identity (§8 builders), never content. Dormant by default.
- `apps/worker/test/composition/proposed-action-producer.test.ts` — 11 unit tests.

**Files modified:**
- `apps/worker/src/composition/buildActivities.ts` — source buildOutputs wired to `produceProposedActions` (optional `externalActionBinding?` on SourceIngestionParams; byte-equivalent when unset).
- `packages/workflows/src/activities/buildOutputs.ts` — MEETING: reorder so `plan.externalActionProposals` mirrors the existing projection-derived actions (no new producer).
- `packages/workflows/test/meeting-activities.test.ts` — 1 meeting-mirror test.

### S7 — 18.8 source note frontmatter carries the validated extraction (commit `f1318db2`)
**Files modified:**
- `apps/worker/src/composition/buildActivities.ts` — the source note frontmatter now carries the validated extraction's owner/dueDate (fixed `["owner","dueDate"]` convention + `frontmatterValue` TBD-sentinel + `neutralizeFrontmatterValue`, identity fields retained) — reusing the meeting's helpers.
- `apps/worker/test/composition/realSourceCommit.test.ts` — 6 new 18.8 tests (frontmatter-real / absent⇒TBD / marker-neutralized [mutation-verified] / body-real / WS-8-no-smuggle / content-via-sole-writer).

## Decisions made
- **S5 live auto-ingest flip (Option A, owner-mandate-checked):** the shipped source path routes through the real broker. Output byte-equivalent; shipped default (auto-ingest OFF) never constructs it → byte-equivalent runtime; the gating is a policing tightening (ING-7 now runs), no effect armed. Rule-5 verified: the source route is loopback-local (`processorOfRoute===null` ⇒ §5 employer-raw veto allows).
- **S6 meeting asymmetry (Option A):** the meeting already had a richer per-action-item projection producer — do NOT wire the binding-driven producer there; instead mirror its derived actions into `externalActionProposals`. My binding-driven producer serves the source only.
- **S6 payloadHash fix (caught in review):** payloadHash now digests the payload (was hashing the identity key) — closes a §8 payload-swap TOCTOU gap. `approvalPolicy = "requires_approval"` (never `"auto_private"`, the sole auto-eligible token ⇒ fail-closed to PENDING).
- **S7 trace-honest scope:** meeting/body/routing already real (verify-only); the source note frontmatter was the one real gap. Fixed `["owner","dueDate"]` convention (never arbitrary validated fields) is the load-bearing WS-8/no-smuggle safety.

## Decisions explicitly NOT made (deferred)
- **Faithful evidence-bearing extraction reconstruction** from the accepted candidate — deferred to task #18 (the KMP stand-in discards `evidenceRef`; GATE-1).
- **Shared `assembleProposedAction` (S6) + `stampConventionFrontmatter` (S7) helpers** — Future-TODO hardening (both extract a shared safety-idiom to prevent source/meeting drift; no active drift now — both verbatim; the orch will pair them).
- **Extraction-derived source note title** (vs `Ingested: <sourceId>`) + **barrel-export `neutralizeFrontmatterValue`** — Future-TODO minor.
- **Promote meeting/source extraction to a first-class BrokerCandidate kind + Appendix-A schema** — task #18, owner-gated (when real model flows).

## TDD compliance
**Clean.** All three slices were RED-first: S5 + S6 failed module-not-found before the producer/factory existed; S7's frontmatter test failed `expected undefined to be 'Bob'` before the impl. Every reviewer-flagged safety gap was closed WITH a test (notably S7's marker-neutralization pin was mutation-verified load-bearing — removing the neutralize made it fail). No TDD violation.

## Reachability (confirmed at each Step 7.5)
- **S5** `createSourceAgentBrokerRouting` ← `sourceAgent`/`sourceRunAgentJob` (buildActivities:759) ← source driver `agent.run` (workflows.ts:414) ← `runSourceIngestion` ← `dispatchSourceIngestion` (boot.ts:1781, vault watcher, owner-opt-in). Real gate ← in-sandbox `validate` ← both drivers.
- **S6** `produceProposedActions` ← source `sourceBuildOutputs` (buildActivities:846) ← source driver; meeting `externalActionProposals` mirror ← `createBuildOutputsActivity` (buildActivities:474) ← meeting driver (meetingCloseout.ts:326).
- **S7** the source frontmatter build is inside the already-reachable source `buildOutputs` → sole-writer commit.
- **No tested-but-unwired gaps.** SOW_TEMPORAL `sourceIngestion-live` end-to-end: source happy-path (a/g/d) commits real content; `(c) IDEMPOTENT` + `(e) DISPATCH` remain the PRE-EXISTING `#15` failures (git-stash-baseline-confirmed identical on the pre-S5 bypass — NOT introduced this session).

## Open follow-ups (Step-9 categorized — already routed hot to the orch)
1. **Live auto-ingest accept-path completion (S5) → crossing tracker #13:** the owner-opt-in live auto-ingest needs a valid-KMP `stubExtraction` threaded by the desktop-side bootWorker host (cross-territory; not yet threaded through AutoIngestWiring). Until then, ENABLING auto-ingest fails-closed at the schema gate (safe, non-functional). Shipped default (OFF) byte-equivalent. Documented in-code (boot.ts NOTE).
2. **Pre-existing `sourceIngestion-live (c)/(e)` failures → folded into #15** (same replay/dispatch class; not mine).
3. **Shared `assembleProposedAction` (S6) + `stampConventionFrontmatter` (S7) helpers → Future-TODO hardening.**
4. **§19.5/§9 arch notes (orch writes):** approvalPolicy taxonomy arch_gap (`auto_private` = sole auto-eligible token; all else fail-closes to requires-approval); the extraction→ProposedAction mapping + no-dispatch boundary; the extraction/routing/body → KMP → note-content flow; the payloadHash-digests-payload requirement (Tool-Gateway integrity binds at Phase-21/22 arming).
5. **Import asymmetry / hoist / extraction-derived title → Future-TODO minor.**

## Cross-doc invariant audit
**No model field changes this session.** All slices reused existing frozen models (`AgentJob`, `ProposedAction`, `ExternalWriteEnvelope`, `KnowledgeMutationPlan`, `NoteCreate`) — no field add/remove/rename. `ExternalActionBinding`/`ActionIdentity` (S6) are worker-internal composition types. Confirmed "cross-doc: NONE" at each Step 9. No `ARCHITECTURE.md`/Appendix-A edit owed.

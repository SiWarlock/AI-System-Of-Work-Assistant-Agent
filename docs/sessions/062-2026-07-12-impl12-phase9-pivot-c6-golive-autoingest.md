# Session 062 — impl12: Phase-9 pivot slices · C6 go-live + (b) skills · open-the-gates auto-ingest

- **Date:** 2026-07-12
- **Phase:** Phase-9 renderer pivot → C6 §13.10 Copilot skills → Phase-11 open-the-gates (slice 1)
- **Role:** implementer `impl12` (single-track on `main`; team `session-f2673cd5`) — cycled in for `impl10`
- **Orchestrators:** `orch11` (tasks 37–39) → cycled → `orch13` (tasks 40–43)
- **Predecessor:** [061-2026-07-12-phase9-pivot-round-seal.md](061-2026-07-12-phase9-pivot-round-seal.md)
- **Successor:** [`063-2026-07-13-impl14-durable-revisions-real-commit-multifile.md`](063-2026-07-13-impl14-durable-revisions-real-commit-multifile.md)

## Why this session existed

Continue the owner-authorized work after the Phase-9 renderer pivot round seal: the remaining Phase-9 non-HITL renderer vein, then the C6 §13.10 Copilot skill catalog (owner-authorized go-live + the Tier-2 local-synthesis skills), then the first "open-the-gates" Phase-11 slice (make the shipped app run vault→ingestion live behind an owner opt-in). Six slices landed, each `/tdd` test-first with mandatory review where the surface warranted it.

## What was built (6 slices, all committed)

| Task | Commit | Slice |
|---|---|---|
| 37 | `d4f38cf` | §9.7 triage-resolution ACTION UI (`disposeTriage` → IngestionInbox) |
| 38 | `1110024` | §11 ScopeSwitcher popup keyboard-loop a11y |
| 39 | `762ae8a` | C6 §13.10d go-live — flip vault.read + skill-introspection live (owner-authorized; **pushed**) |
| 40 | `b1048c3` | C6 (b)-1 on-request §9.4-Today Copilot briefing skill |
| 42 | `048d13e` | C6 (b)-2 on-request concept-synthesis Copilot skill |
| 43 | `727ab76` | open-the-gates slice 1 — auto-ingest live-wiring (owner-opt-in, default-OFF; **pushed** by orch) |

### Files created
- `apps/desktop/renderer/lib/triage-disposition.ts` — `createTriageDisposition` + deterministic `triageIdempotencyKey` + fail-closed fold (task 37).
- `apps/worker/src/api/procedures/copilotBriefing.ts` — `answerCopilotBriefing` + `CopilotBriefingRetrievalPort` + fixture/read-model adapters + `BRIEFING_DIRECTIVE` (task 40).
- `apps/worker/src/api/procedures/copilotConcept.ts` — `answerCopilotConcept` + `CONCEPT_DIRECTIVE` + `conceptDirective` (task 42).
- Tests: `test/renderer/triage-disposition.test.ts`, `test-dom/ingestion-inbox-page.test.tsx` (+action tests), `apps/worker/test/api/procedures/copilotBriefing.test.ts`, `copilotConcept.test.ts`, `apps/worker/test/boot-copilot-read-gating.test.ts` (task 39), `apps/worker/test/boot-auto-ingest-gating.test.ts` (task 43).

### Files modified
- `apps/desktop/renderer/`: `surfaces/ingestion-inbox/index.tsx` (dispose actions + fail-closed affordance), `lib/live.ts` (`disposeTriage` handle), `App.tsx` (onDispose + store-drain), `lib/a11y/useRovingListbox.ts` (optional `open` → focus-on-open/reset), `chrome/AppShell.tsx` (ScopeSwitcher return-focus loop).
- `apps/worker/src/api/procedures/copilot.ts` — **extracted `runGovernedCopilotSynthesis` + `GovernedCopilotSynthesisDeps`** (the single-sourced governed core reused by ask/briefing/concept; behavior-identical, reviewer-verified).
- `apps/worker/src/api/procedures/queries.ts` — mounted `query.copilotBriefing` + `query.copilotConcept` (+ `parseBriefingInput`/`parseConceptInput` with a code-point single-line guard); `server.ts` (+`briefing` dep); `boot.ts` — **the C6 vault/skills gate extraction** (`gateCopilotVaultReadDeps`/`gateCopilotSkillIntrospectionDeps`, task 39) + the auto-ingest gate (`gateAutoIngest` + `buildAutoIngestProofSpineParams` + `DEFAULT_INGEST_WORKSPACE`, task 43) + the briefing deps assembly.
- `apps/desktop/worker-host/index.ts` (flip vault/skills flags, task 39; auto-ingest opt-in fields + `gateAutoIngest` spread, task 43), `apps/desktop/main/index.ts` + `main/worker-supervisor.ts` (SOW_INGEST_* env → both WorkerHostConfig IPC mirrors, task 43).
- Test-only ripple (task 40, required-`briefing`-field): `apps/worker/test/api/{uiSafe,procedures/queries}.test.ts`, `test/integration/api-live.test.ts`, `packages/evals/src/{benchmarks/dashboard-warmload.bench.ts,worker-api-auth/auth-suite.ts}`.

## Decisions made
- **Single-sourced governed core (tasks 40/42):** extracted `runGovernedCopilotSynthesis` from `answerCopilotQuestion` so ask/briefing/concept share the WS-8 re-guard → posture → egress-veto → candidate-gate machinery verbatim — it cannot drift between skills. Banked as worker Lesson 1.
- **Briefing no-raw-by-construction (task 40):** the read-model adapter assembles blocks from ONLY already-UiSafe items (recentChanges + ingestion summaries) + an approval COUNT; workspace-cards (raw at the port) deferred to a projector-backed variant.
- **Concept term = Q&A-equivalent injection surface (task 42):** bounded at `parseConceptInput` (≤200 + genuinely single-line via a code-point Set, per the Unicode-in-regex lesson).
- **Auto-ingest = pure fail-safe gate (task 43):** `gateAutoIngest` mirrors `gateCopilotVaultReadDeps` (thunk'd builder → never constructed on the OFF path); default OFF is byte-equivalent to today's degraded boot; `DEFAULT_INGEST_WORKSPACE` reuses the canonical `DEFAULT_GBRAIN_COPILOT_WORKSPACE`.
- **Go-live governance (task 39):** held + escalated the cloud go-live before executing; proceeded only after the lead confirmed explicit owner authorization; surfaced the Employer-Work→cloud egress framing (owner subsequently relaxed the egress line for the Copilot — propose/write bridge stays gated).

## Decisions explicitly NOT made (deferred)
- Real durable `sourceCommit` + a durable `revisions` store (auto-ingest slice 2 — banked in the `buildAutoIngestProofSpineParams` JSDoc; the in-memory store is honest-inert today).
- Briefing workspace-cards enrichment (needs the UiSafe dashboard projector); the concept/briefing governance-eval cases (eval-security track — NOT built; did not touch `../SoW-build-evalsec`).
- Renderer affordances for briefing/concept ("brief me" / "explain a concept") — desktop-track follow-on.
- Concept-directive quote-escaping (deferred as ≤ Q&A posture; both reviewers concurred).

## TDD compliance
**Clean.** Every slice was test-first — RED confirmed for the right reason before GREEN (missing module/export/behavior), then GREEN. Review-driven fixes (task 38 MED flag-lifecycle leak; task 40 MED empty-Today coverage; task 42 Unicode line-sep gap; task 43 MED dead-field) were applied test-first where a behavior change was involved. No TDD violations.

## Reachability
- 37 triage: IngestionInbox button → `App.onDisposeTriage` → `handle.disposeTriage` → `createTriageDisposition` → `command.disposeTriage`.
- 38 a11y: ScopeSwitcher already mounted (AppShell top bar); additive focus mgmt.
- 39 vault/skills: worker-host flags → `gateCopilotVaultReadDeps`/`gateCopilotSkillIntrospectionDeps` → runner scoped-proxy → live cloud agent.
- 40/42 briefing/concept: `query.copilotBriefing` / `query.copilotConcept` mounted behind `authedResolver` → `composeAppRouter` (briefing deps assembled in boot; concept reuses the copilot dep).
- 43 auto-ingest: `worker-host.start()` → `gateAutoIngest` spread → `bootWorker` on the real boot path when the owner sets `SOW_INGEST_WATCH`; default OFF → `undefined` → degraded boot unchanged.
No tested-but-unwired gaps.

## Open follow-ups (Step-9 categorized — routed hot during the session; captured here for continuity)
- **⚑ Propose go-live gate (task 43, both reviewers):** with the auto-ingest opt-in ON, `proofSpineParams` is now DEFINED on the shipped path — satisfying a NECESSARY precondition of the propose/semantic-approval dispatch the app previously always denied by `proofSpineParams`-absence. Propose STAYS OFF via 3 independent locks (copilotProposeMode/copilotProposeKnowledge unset + the C5.4b interim oracle → untrusted → runtime-OFF). The propose go-live gate must re-verify the flag + oracle locks, NOT rely on `proofSpineParams`-absence. → copilot-propose-go-live runbook.
- **Deferred residual — durable `revisions`:** must become durable before EITHER a real durable `sourceCommit` (slice 2) OR propose-live (`buildSemanticApprovalDispatch` also consumes it). Banked in the JSDoc.
- **Cross-package eval ripple (task 40):** `packages/evals` consumers gained mechanical `briefing` fakes (shared ApiServerDeps). Coordinate with eval-security if those files are in flight.
- **Convention candidates (banked/candidate):** worker Lesson 1 (governed-core reuse) landed; the "fail-safe boot-gate helper activates a built-but-dormant capability, default byte-equivalent" convention (gateCopilotVaultReadDeps / gateAutoIngest) — candidate.
- **Runbook / arch-doc (orchestrator routes):** Bucket-A runbook ingestion section "unbuilt-wiring gap" → "owner-opt-in wired"; new `SOW_*` env knobs; §13 boot's first live step (local Temporal dev-server connect, owner-opt-in). Partial 11.1 progress (Temporal-connect for ingestion; 11.1 stays unticked).
- **eval-security follow-ons:** briefing + concept governance-eval cases (join `copilot-governance.test.ts`).

## Cross-doc invariant audit
**No model field changes this session** — every slice reused existing contracts (`UiSafeIngestionItem`, `UiSafeCopilotAnswer`, `ProofSpineParams`); `WorkerHostConfig` is app-internal (not Appendix-A). `git diff -- ARCHITECTURE.md` is empty. No drift.

## Governance note
Task 39 (cloud go-live) and task 43's propose-precondition coupling were handled escalation-first: held before executing, confirmed owner authorization via the lead, surfaced the Employer-Work→cloud + propose-gate findings. The hard line held throughout (no propose flip, no write-through, no external spend).

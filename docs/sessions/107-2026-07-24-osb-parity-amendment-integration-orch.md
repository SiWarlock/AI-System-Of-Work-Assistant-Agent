# Session 107 — OSB-Parity amendment integration into canonical ARCHITECTURE + IMPLEMENTATION_PLAN (orchestrator planning round)

- **Date:** 2026-07-24
- **Role:** main-orchestrator (team main, single-track)
- **Predecessor:** `106-2026-07-24-phase18-arm18-checkpoint1-crossing-golive.md`
- **Kind:** orchestrator-only PLANNING round — no code, nothing armed, all additions dormant.

## Why this session existed

Owner-directed NEW scope: full OSB (obsidian-second-brain) parity under SoW governance — (1) auto-linking docs to related entries, (2) auto-updating related entities on ingest ("the vault rewrites itself"), (3) the exact `/research` + `/research-deep` Perplexity/Grok web-research flow. A subagent-authored amendment proposal (`docs/planning/osb-parity-amendment-proposal.md`) was owner-approved AS IS and routed by the lead (after the §ARM-18 crossing sealed) for integration into the canonical docs as planned phases/tasks.

## What was integrated

**ARCHITECTURE.md**
- §6 — **KN-10** (Living-Vault Synthesis Engine: SENSE→REASON→EFFECT confined planner → `KnowledgeMutationPlan` → KnowledgeWriter; tiered autonomy revises "generative = propose-only"), **KN-11** (governed auto-link via `LinkMutation`/`applyLink` + derived-never-authored backlinks), **KN-12** (structural-file `index.md`/`log.md` parity as vault-surface writes).
- §7 — **RES-1** (egress-classed Research/Web-Retrieval provider: Perplexity Sonar + Grok Live Search + free key-less aggregator; candidate→gate→KnowledgeWriter; frozen-contract note for new ProviderIds) + **RES-2** (`/research-deep` vault-first 5-phase pipeline).
- §19 — new **§19.13** (Research provider go-live + living-vault scheduling, HARD-LINE crossing 8, independent arc); §19.12 amend (register `livingVaultSynthesis`).
- Spec Anchor Index — REQ-F-021, REQ-F-022, §19.13 (Phase 26) rows.

**IMPLEMENTATION_PLAN.md**
- Task **13.8 → 13.8a–e** (parent retained + buildable sub-slices): EntityResolver (net-new) · LinkHealer · confined synthesis planner · living-vault ingest-rewrite + index/log parity · scheduled synthesis activity (13.8e OWNER-GATED).
- New **13.13** (RES-1 research provider, dormant) + **13.14** (`/research`+`/research-deep` flows, dormant).
- New **§ARM-RESEARCH** arming ledger (crossing 8; real fetch + paid Perplexity/xAI key = two standing hard lines; employer-work ack-OFF fails closed).
- New **Phase 26** (26.1 provider go-live + 26.2 living-vault scheduling, both OWNER-GATED §ARM-RESEARCH) + phase-status rows (Phase 26 added; Phase 13 open 8→10).

## Decisions made

- **Anchor verification FIRST (lead-mandated — proposal was subagent-authored).** A general-purpose subagent verified all 11 cited code anchors via codegraph/graphify: **zero DRIFTED/WRONG.** The 3 load-bearing claims hold — `applyLink` (writer.ts:511-528), backlinks derived by `deriveCanonicalFacts` (canonical-fact-deriver.ts:259), and **NO `EntityResolver`/`LinkHealer`** today (paths lossily slug-derived via `safeNoteSlug`, noteSlug.ts:71). Refinement applied: `ProviderId` is exactly `packages/contracts/src/primitives/enums.ts:14` (5 members).
- **Lint-format correction.** The proposal's `### 13.8a` checkbox form BREAKS plan-lint (`tn = substr($0, index($0,".")+1) + 0` coerces `13.8a`→8, colliding with `13.8` on the "out of numeric order" check, line 100). Rendered 13.8a–e as lint-exempt `#### ` sub-slices (text-state, rolling up to 13.8's state) instead; 13.13/13.14/26.1/26.2 are proper integer `### ` tasks (tn strictly increasing). plan-lint: 0 violations.
- **Frozen-contract placement.** Adding `perplexity`/`xai` ProviderIds is a build-time frozen-contract round (task 13.13), NOT the arming crossing (§ARM-RESEARCH arms the transport + paid key, not the contract).
- **Committed the source proposal** (`docs/planning/osb-parity-amendment-proposal.md`) as the integration's provenance artifact.

## Decisions explicitly NOT made (deferred)

- **No build.** Every added task is dormant/planned; no code written this round.
- **No arming.** Research cloud egress + paid Perplexity/xAI key provisioning are owner-gated (§ARM-RESEARCH, crossing 8) — untouched.
- **Build sequencing** of the dormant slices (13.8a–e / 13.13 / 13.14) is owner/lead-sequenced — not decided here.

## TDD / cross-doc / reachability

- **TDD:** N/A — planning-doc round, no code. The added deterministic tasks (13.8a–e, 13.13/13.14) carry `/tdd`-shaped Done-when clauses; model legs are marked eval-tested.
- **Cross-doc invariant audit:** ARCHITECTURE ↔ IMPLEMENTATION_PLAN kept in lock-step (KN-10/11/12 ↔ 13.8a–e; RES-1/2 ↔ 13.13/14; §19.13 ↔ Phase 26/§ARM-RESEARCH; REQ-F-021/022 ↔ Spec-Index). No frozen Appendix-A model changed (the ProviderId enum extension is FLAGGED as a future frozen-contract round in 13.13, not done here).
- **Reachability:** N/A (no code).

## Open follow-ups

- Build the dormant OSB-parity slices when owner-sequenced (13.8a–e deterministic-TDD; 13.13/13.14 build + eval; the ProviderId frozen-contract round rides 13.13).
- Worker L73-corollary lesson (SDK re-injects `CLAUDE_CODE_SDK_*` atop the scrubbed env) was handed to the worker to bank in `apps/worker/LESSONS.md` (crossing-round follow-up; independent of this planning round).
- plan-lint's 3 standing ledger warnings (§ARM-17/§ARM-REBUILD/§DEC-CAT4 "defined but no task references it") are pre-existing, unrelated to this round.

## How to use what was integrated

Nothing to run — all planned/dormant. The build slices are queued in Phase 13 (13.8a–e, 13.13, 13.14); the go-live is Phase 26 behind §ARM-RESEARCH (owner-gated). Source proposal: `docs/planning/osb-parity-amendment-proposal.md`.

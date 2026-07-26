# Session 114 — ARC-4 living-vault keystone: 13.8b→c→d (knowledge)

- **Date:** 2026-07-26
- **Phase / arc:** ARC-4 §13.8 living-vault synthesis KEYSTONE (knowledge track, single-track `main`)
- **Role:** knowledge-implementer
- **Predecessor:** [113-2026-07-26-worker-phase9-13-21-slices.md](113-2026-07-26-worker-phase9-13-21-slices.md) (chronological); knowledge lineage: 13.8a EntityResolver `c3d62436`
- **Successor:** _(post-pause)_ — 13.8f meeting-path synthesis + the 13.8d worker binding (queued, not dispatched)

## Why this session existed

Build the middle + tail of the ARC-4 living-vault synthesis keystone chain on top of the landed 13.8a EntityResolver — the "vault rewrites itself / OSB-parity smart-vault" payoff. This session was a respawn (prior knowledge-impl terminated by an erroneous lead shutdown; slice #40 orphaned brief-only, no code lost) and ran the chain to completion, then wound down on an owner TEAM PAUSE directive.

## What was built (4 slices, 5 commits)

### 13.8b LinkHealer — `262df7b8` (task #40)
**Files created:** `src/synthesis/link-healer.ts` (`healLinks` — governed forward-link heal), `src/synthesis/match-keys.ts` (shared `faithfulKey`+`entitySlug`+`identifiers`), `test/synthesis-link-healer.test.ts` (18).
**Files modified:** `src/synthesis/entity-resolver.ts` (re-point to shared match-keys — behavior-preserving; 13.8a's 15 tests stayed green), `src/index.ts` (barrel).
Faithful/unambiguous → `LinkMutation{op:'add'}`; lossy/fuzzy/2+ → withheld; backlinks never authored; WS-8 drop; PURE/TOTAL never-throws.

### 13.8c confined synthesis planner — `461a0186` (task #44)
**Files created:** `src/synthesis/planner.ts` (`planSynthesis` — SENSE→REASON→EFFECT → 0–2 `KnowledgeMutationPlan`s), `test/synthesis-planner.test.ts` (16).
**Files modified:** `src/index.ts` (barrel).
Deterministic tiered autonomy (additive→AUTO `requiresApproval:false`, FrontmatterPatch→PROPOSE `true`, in SEPARATE plans); `@user` confinement = symmetric fail-closed allowlist (`refresh` id ∈ generatedRegionIds; `new_region` id ∉ it; marker-safe id guard); no-inference (owner/date→`TBD`) via `@sow/domain` `validateNoInference`; PURE/TOTAL never-throws; DORMANT.

### 13.8d(a) KW create+patch marker-neutralization — `04e01eed` (task #51, SAFETY commit)
**Files modified:** `src/markdown-vault/sections.ts` (+`neutralizeRegionMarkers` canonical, +`neutralizeNoteBody` region-aware), `src/knowledge-writer/writer.ts` (`renderCreate`+`applyRegionPatch` route through them).
**Files created:** `test/region-marker-neutralize.test.ts` (14).
A content-embedded `kw:region`/`@generated`/`@user` marker can no longer forge a region boundary on create OR patch (L9 single-neutralizer, both legs). Single-pass fixpoint (`replaceAll`) — linear on the untrusted path.

### 13.8d(b) living-vault ingest-rewrite + structural-file parity — `3d2d24f9` (task #51)
**Files created:** `src/synthesis/ingest-rewrite.ts` (`rewriteVaultForSource` + `IngestRewriteReceipt`), `src/markdown-vault/structural-files.ts` (index/op-log builders), `test/ingest-rewrite.test.ts` (9), `test/structural-files.test.ts` (4).
**Files modified:** `src/index.ts` (barrel), `test/synthesis-planner.test.ts` (dormancy-test retarget).
SINGLE `planSynthesis`/run → ≤2 KMPs (ingest UPDATES existing notes) + KN-12 structural parity (index.md per-section regen + `Logs/<date>.md` + `log.md` pointer) merged into the AUTO plan as KW mutations (rule 1); `planIds` digest = batch-undo unit; L31 flood-bound; PURE/never-throws; DORMANT.

## Decisions made
- **Shared match-keys (13.8b):** extracted `faithfulKey`/`entitySlug`/`identifiers` into `match-keys.ts` so resolver + healer can't drift (Lesson 17). Rationale: consistency-by-construction over local re-impl.
- **Deterministic tier + separate plans (13.8c):** `requiresApproval` set by the planner from (effect kind+target), never model-declared; additive-AUTO + human-relevant-PROPOSE in separate KMPs so additive auto-applies (the KN-10 payoff).
- **Symmetric fail-closed confinement (13.8c):** driven by a security-review Critical — `new_region` must be a *fresh* id (∉ allowlist), closing an effect-relabel bypass. Marker-safe id guard added.
- **Neutralizer canonical home (13.8d):** a broken-premise Finding — the L9 neutralizer lived in `packages/workflows` (unreachable from KW by layer). Resolved by defining the canonical `neutralizeRegionMarkers` in knowledge `sections.ts` (co-located with `MARKER_RE`); orch owns worker follow-up #54 to re-point `workflows/noteSlug.ts` to `@sow/knowledge`.
- **renderCreate region-aware (13.8d):** `neutralizeNoteBody` preserves legit `@generated` regions (planner new_note) while defusing embedded forge-markers — a blanket neutralize would have escaped legit wrappers.
- **Receipt `planIds` not `revisionIds` (13.8d):** the pure/pre-commit orchestrator can't know commit-time revision hashes; ordered `planIds` are the stable batch-undo unit (worker binding maps planId→CommittedRevision).
- **Dormancy-test retarget (13.8d):** planSynthesis now has legit dormant/eval consumers (ingest-rewrite + 13.8c-eval scorer) → the meaningful invariant is "no PRODUCTION apps/workflows importer."

## Decisions explicitly NOT made (deferred)
- **`living_vault_synthesis` provenanceOrigin** frozen enum member — deferred to the 13.8d worker-binding round (contract-track); planner takes provenanceOrigin as input, origin-agnostic for now.
- **realpath containment (security-item iii)** for model-controlled notePath — deferred to the worker binding (L17), not built here.
- **Planner new_note inner-neutralization** — a synthesis body with marker-like content gets de-regioned (safe) by KW's neutralization rather than preserved; region-survival hardening is a possible future nicety, not built.

## TDD compliance
- 13.8b, 13.8c, 13.8d(a): RED-first confirmed (import/module-not-found failures watched before impl). Clean.
- **13.8d(b) minor order-deviation:** `ingest-rewrite.ts`/`structural-files.ts` impl + tests were authored together then run green (not a watched RED-first per function). Behavior is fully pinned by the 13 tests + the design was pre-approved at Step-2.5 and security-reviewed CLEAN. Not safety-critical (dormant orchestrator). Noted for honesty.

## Reachability
- 13.8b `healLinks`, 13.8c `planSynthesis`, 13.8d(b) `rewriteVaultForSource`: **DORMANT** — barrel-exported, no `apps/`/`workflows/` (production) importer (grep-pinned). Consumers: 13.8c/d compose 13.8a/b; the eval scorer (evalsec) consumes planSynthesis; production wiring = the 13.8d/13.8f worker bindings.
- 13.8d(a) neutralization: **LIVE** — reachable by every KW create+patch (`renderCreate`/`applyRegionPatch`); only strengthens existing writes.

## Open follow-ups (Step-9 categorized — orchestrator routes at /orchestrate-end)
- **Architecture-doc notes (orch writes):** §6 KN-10 stance revision (propose-only → tiered autonomy + symmetric-allowlist confinement); §6 KN-11 (13.8b rides the 13.8 note); §6 KN-12 structural-file parity through KW.
- **Convention-candidate lessons:** shared match-keys (L17); planner-deterministic tier + separate KMPs; symmetric-allowlist @user confinement; L9 create+patch canonical neutralizer (knowledge home); ingest-rewrite single-planSynthesis→≤2 + planIds; structural-parity-as-KW-mutations.
- **Worker / next-leg follow-ups:** #54 `noteSlug.ts` re-point → `@sow/knowledge` (single-source the neutralizer — canonical export now landed); the 13.8d worker binding (`rewriteVaultForSource` → `runSourceIngestion` + realpath containment L17); 13.8f meeting-path; `living_vault_synthesis` provenanceOrigin decision.
- **arch_gap:** `OWNER_DATE_RE /owner|assignee|due|date/i` (13.8c) — the concrete §9 owner/date field taxonomy is unspecified; heuristic errs toward TBD-coercion (REQ-F-017-safe).
- **Informational (security review, no action):** `applyRegionPatch` regionId + structural `isSafeId` permit an embedded `<!--` in an id — harmless (schema/boot-config, not candidate data); defense-in-depth note only if a future caller routes model text as a regionId.
- **Infra (not a finding):** the code-quality reviewer on 13.8d aborted on an account session-limit; orch carries a re-run as a non-blocking post-reset follow-up.

## Cross-doc invariant audit
**Clean.** No frozen Appendix-A model field was added/removed/renamed this session — all slices reuse `KnowledgeMutationPlan`/`NotePatch`/`NoteCreate`/`LinkMutation`/`FrontmatterPatch` as-is. No owed `ARCHITECTURE.md` field edit.

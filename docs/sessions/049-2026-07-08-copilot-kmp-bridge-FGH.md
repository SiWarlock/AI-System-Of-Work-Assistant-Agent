# Session 049 — §13.10a Copilot→KMP bridge: Slices F / G / H (executor · tool+catalog · desktop card)

**Date:** 2026-07-08 · **Operator:** solo (worker track, full workflow) · **HEAD at start:** `2718f35` (Slice E) · **HEAD at end:** `de8ca9e`

## Goal
Finish the deterministic half of the §13.10a Copilot semantic-write bridge — the on-approval executor (F), the model-facing tool + ING-7 catalog (G), and the desktop card (H) — per the resume handoff `sow-kmp-bridge-finish`. Environment note: the prior session halted on a macOS TCC / Full-Disk-Access revocation; this session confirmed reads under `~/Documents/` work again before starting.

## What shipped (all TDD; reviewed; repo-wide gate 31/31 after each cross-package change)

### Slice F — on-approval → KnowledgeWriter executor · `11faf76` (17 tests)
`apps/worker/src/api/procedures/semanticMutationDispatch.ts`: `createSemanticMutationDispatch` (a `DispatchApprovalFn`, the SEMANTIC branch) + `createApprovalDispatchRouter` (routes by `subjectKind`; external → the existing Tool-Gateway dispatch, semantic → this executor). On an **approved** `semantic_mutation` Approval: guard `subjectKind`/`planRef` → fetch pending KMP by `planRef` (phantom → fail-closed) → idempotent skip if the row is already `committed` (LIFE-3) → **FG-1** WS-8 (`row.workspaceId === approval.workspaceId`) → object-guard + **FG-2** TOCTOU (`payloadHash(row.plan) === approval.payloadHash`, the FROZEN one) → **candidate-gate** re-validate through `KnowledgeMutationPlanSchema` → commit via `CommitKnowledgePort` (idempotent by `plan.planId`) → mark row `committed`+`settledAt`. On **rejected**: mark row `rejected`. Redaction-safe `FailureVariant`; never throws. Reuses `CommitKnowledgePort` (which wraps `applyPlan` + `mapWriteFailure`) rather than duplicating it.
- **Adversarial review (general-purpose agent):** 1 MED (fail-closed, not reachable today) — FG-2 re-hashes a JSON-round-tripped blob vs a hash taken over the in-memory KMP; a future producer emitting a schema-legal present-`undefined` value would spuriously reject (never a wrong commit). Documented as a go-live gate; tests now round-trip the stored blob to prove today's producer is safe. The two LOWs (commit-ok/update-fails coverage; settle-rejected WS-8) were closed in-round.
- **Deferred (go-live gate):** the slug-collision check on a NotePatch — the KMP patch carries no projectId, so the executor can't compare against the note's frontmatter yet (needs a Slice-B/contract follow-up). Bounded today by the human gate.

### Slice G1 — `copilot.propose_knowledge` tool + propose path · `d6a1983` (11 tests)
`apps/worker/src/api/procedures/copilotProposeKnowledgeTool.ts`: `handleCopilotProposeKnowledgeToolCall` → `proposeCopilotKnowledge` → `deriveCopilotProjectKnowledgePlan` (Slice B) → `routeCopilotKnowledgeProposal` → the Slice-E sink → a PENDING §9.8 card. NEVER writes Markdown. Untrusted intent is strict-shape-guarded by the derive fn; `workspaceId`/`sourceRef`/`noteExists` are SERVER-BOUND deps (documented runner preconditions). Belt-and-suspenders §16 catch on the handler so the untrusted-model-facing surface never throws.

### Slice G2 — ING-7 catalog entry · `09218b6` (policy suite 325)
`packages/policy/src/copilot-tool-catalog.ts`: `COPILOT_PROPOSE_KNOWLEDGE_TOOL` (mutating, frozen) added to the CATALOG so `isMutatingCopilotTool` classifies it explicitly (C4 ING-7 admission HARD-REJECTS it for an untrusted job). Grant is DECOUPLED: `copilotKnowledgeAgentToolIds`/`copilotKnowledgeProposeToolPolicy` = read tools + propose_knowledge — `copilotAgentToolIds` (the external-write grant + the wired synthesis runner) is left UNCHANGED.
- **Adversarial review (G1+G2, general-purpose agent):** SHIP, 0 crit/high/med.

### Slice H — desktop semantic-mutation Approvals card · `de8ca9e` (contract freeze + worker projector + renderer jsdom)
Additive UI-safe frozen round: `UiSafeApproval.subjectKind?` (optional, mirrors `actionRef`) + schema + the checked-in `UI_SAFE_ALLOWLIST` + the freeze test (a frozen 2-value enum, no content; `planRef` never surfaced). `toUiSafeApproval` projects it. `Approvals.tsx` branches the card — a semantic card shows a descriptive label ("Proposed note write (Copilot)") + a `data-subject-kind` hook + a `--semantic` class; external cards unchanged (undefined → backward-compatible default). Inline leakage review (frozen enum, no plan/note content reaches the renderer). `commands.test` key-set assertions updated for the ripple.
- **Deferred:** a real note-title subject needs a read-model plan-join (its own WS-8/redaction review).

## Method notes carried
- Reviewer subagents are gone → used **general-purpose Agent** with security+code-quality prompts for F and G (safety-critical); inline review for H (small, additive, enum-only leakage boundary).
- Per-file `git add`; never staged `.claude/settings.json` / root `CLAUDE.md` / `graphify-out/`. `graphify update .` after each code change.

## State at close
The §13.10a bridge is **built end-to-end (A–H) and DORMANT.** Nothing exposes the tool to a live model and no dispatcher is wired to `dispatchApproval` (still a no-op stub). Remaining = the live runner-wiring (G3 SDK-MCP adapter + G4 boot flag `copilotProposeKnowledge`) + the go-live gates. See `IMPLEMENTATION_PLAN.md` §13.10a + memory `sow-kmp-bridge-finish` / `sow-copilot-kmp-bridge`.

## Addendum — go-live gates 1/2/3 closed (same session)

After the A–H arc, this session also closed **3 of the 4 §13.10a go-live gates** (all TDD'd, reviewed, pushed):
- **Gate 2 — YAML-safe frontmatter serialization** (`3011749`, knowledge). `serializeScalar` quotes+escapes unsafe/coercible string values (letter-leading-plain-only ⇒ numbers/dates/hex quoted; all C0/C1 control chars escaped); the create `title` path routed through it. Fixes a latent bug in the LIVE writer, not just the dormant path. Review folded 2 MEDs.
- **Gate 1 — slug-collision guard** (`1cfa1f4` frozen KMP round `expectedProjectId?` + `09ca3c7` derive-stamp + executor-verify), owner picked the plan-level field. Executor reads each write target's frontmatter `projectId` (WS-8-scoped `readNoteProjectId` port) and rejects a patch to a foreign project's note AND a create whose target path exists (renderCreate overwrites). Review folded the create-clobber vector + the reader↔gate-2 quoting contract.
- **Gate 3 — FG-2 persisted-form hashing** (`b7e677e`, worker). The sink hashes the round-tripped (persisted) plan so the executor's re-hash always matches, even for a future producer emitting a present-`undefined` value.
- **Remaining:** gate 4 (C5.4b serving oracle, eval-security arc) + the live wiring. Recommended next: concrete `readNoteProjectId` → G3 SDK adapter → G4 runner/boot flag. HEAD `f2fbebe`; all pushed.

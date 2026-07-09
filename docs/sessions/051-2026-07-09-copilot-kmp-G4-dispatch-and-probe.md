# Session 051 — §13.10a G4 (full): dispatch side (G4a) + propose noteExists probe (G4b-1)

**Date:** 2026-07-09 · **Operator:** solo (knowledge + workflows + worker tracks, full workflow) · **HEAD at start:** `5ba3043` · **HEAD at end:** `809dd4c`

## Goal
Owner picked **full G4** (both sides, staggered commits, dormant). This session landed the entire **dispatch side (G4a)** + the first propose-side slice (**G4b-1**, the noteExists probe). The two remaining propose-side slices (G4b-2 runner capability/grant, G4b-3 boot flag) are the clean next step (see below).

## Discovery that reshaped G4 (surfaced to owner before building)
- **The commit port isn't commit-on-approval-safe:** `createCommitActivity` baked a FIXED `expectedBaseRevision`. A semantic plan is approved long after propose, so a fixed base spuriously `write_conflict`s on any unrelated vault change. → head-at-commit resolver.
- **No durable KnowledgeRevisionStore outside Temporal:** the revision store enters via optional `config.proofSpineParams`; the default/Temporal-degraded boot has none. → the semantic dispatch is wired ONLY when `proofSpineParams` is present (dormant otherwise).
- **`noteExists` can't be a pre-resolved boolean on the propose path:** the runner needs the model's projectId first. → a call-time probe (G4b-1).

## What shipped (TDD; adversarially reviewed; repo-wide 31/31 after each cross-package change)

### G4a — dispatch side (3 commits)
- **`97060f7` knowledge — `readVaultHeadRevision(vault)`**: the live whole-vault head (computeRevisionId ∘ readSnapshot). The commit-on-approval base.
- **`70955dc` workflows — commit-activity base-revision resolver**: `createCommitActivity.expectedBaseRevision` now accepts `RevisionId | (() => Promise<RevisionId>)` (backward-compatible). The approval path passes `() => readVaultHeadRevision(vault)`. Both effectful paths are §16-wrapped: a resolver throw AND a throwing injected `applyPlan` (revision-store/audit adapter faulting) fold to `commit_failed` — parity so nothing escapes the synchronous DispatchApprovalFn boundary (review MEDIUM).
- **`bea18f6` worker — `buildSemanticApprovalDispatch` + boot wiring**: the composition factory (gate-1 reader + existence probe over the vault, head-at-commit commit port, `createSemanticMutationDispatch`; `applyPlan` injectable for a light integration test). Boot: `dispatchApproval = createApprovalDispatchRouter({semantic, external: config.dispatchApproval})`, semantic branch wired ONLY when `config.proofSpineParams` is present; approval-specific commit provenance (actor `copilot-approval`). Executor also gained a **supported-kind gate** (a plan carrying frontmatterUpdates/linkMutations — which gate 1 doesn't cover — is rejected fail-closed; review LOW).

**Adversarial review (general-purpose Agent): SHIP (dormant).** The load-bearing decision — head-at-commit + gate-1 replaces the whole-vault compare — is SOUND: the real backstop is the writer's OWN live-bytes `enforceHumanOwnership` (correctly left as the secure default in `buildSemanticApprovalDispatch`), so human-owned Markdown is never clobbered and nothing writes outside KnowledgeWriter. No CRITICAL/HIGH. Folded the MEDIUM (§16 applyPlan-throw parity) + the LOW (unsupported-kind gate). **Go-live residuals (documented, not blocking):** (1) propose ON ⇒ proofSpineParams present (else an approved semantic card hits external-only); (2) approve→dispatch is not atomic — a re-drive/reconciler is needed so an approved-but-uncommitted card recovers (executor is idempotent); (3) fold the approvalId into the audit refs (the workflowRunRef is a placeholder); (4) WS-8 belt-and-suspenders path-within-workspace check.

### G4b-1 — propose noteExists probe · `809dd4c` (worker)
`noteExists` on the propose path changed from a resolved boolean to a `CopilotNoteExistsProbe = (path) => Promise<boolean>`. New pure helper `resolveProposeNoteExists` (in copilotProposeKnowledge.ts) parses the intent's projectId, derives its path via the SAME projectNotePath authority, and probes — `deriveCopilotProjectKnowledgePlan` stays PURE. Fail-closed + never throws: a malformed intent / bad projectId / unsafe path short-circuits BEFORE the probe (untrusted intent never reaches I/O); a probe throw folds to PROBE_FAILED before any record. `proposeCopilotKnowledge` + `handleCopilotProposeKnowledgeToolCall` take the probe.

## What REMAINS — G4b-2 + G4b-3 (the propose-side runner + flag) — RESUME HERE
Both are FULLY DORMANT (trust never returns "trusted" on a live ask; gate 4 serving oracle open), and are the architecturally-loaded untrusted-tool-grant surface — do them as one careful slice with an adversarial pass.

**G4b-2 — runner knowledge-propose capability + grant** (`apps/worker/src/api/procedures/copilotAgentSynthesis.ts`). A knowledge-propose job must be built with `copilotKnowledgeProposeToolPolicy` (G2, grants `copilot.propose_knowledge`) so `canUseTool` admits the tool. Five interlocking parts:
1. `copilotAgentJobCapability` — add a knowledge-propose capability (needs a `knowledgeProposeEnabled` param), mutually exclusive with external `propose`.
2. `buildCopilotAgentJob` — map the new capability → `copilotKnowledgeProposeToolPolicy` + `trustLevel:"trusted"`.
3. `createAgentRuntimeCopilotSynthesis` — a `knowledgeProposeEnabled` opt; pass the knowledge deps.
4. `createClaudeAgentCopilotRunner` — a `knowledgeProposeGranted` grant (served + trusted + scoped_write + knowledge deps present); register the G3 server under the shared `COPILOT_MCP_SERVER_NAME` ("copilot") + push `mcp__copilot__propose_knowledge`; close `handleCopilotProposeKnowledgeToolCall` over `{workspaceId (server-bound), sourceRef, noteExists: probe over vaultReadFile, sink}`. ⚠ **The "copilot" server key is shared with propose_action — enforce mutual exclusion (a job grants at most one propose server; a both-granted config is a fail-closed invalid_job), per the G3-review LOW.**
5. New runner deps: `knowledgeProposeSink`, `buildKnowledgeProposeMcpServer` (= `createCopilotProposeKnowledgeMcpServer`), a `knowledgeNoteExists` probe source (build from `vaultReadFile`+`vaultRoot`), `knowledgeSourceRef`.

**G4b-3 — boot flag `copilotProposeKnowledge`** (OFF; mirror `copilotProposeMode`): construct `createApprovalsKnowledgeProposeSink` + the knowledge propose deps + pass `knowledgeProposeEnabled: config.copilotProposeKnowledge === true` into the synthesis. ⚠ Couple **propose ON ⇒ proofSpineParams present** (dispatch residual #1).

Then: **gate 4** (C5.4b serving oracle, eval-security arc) is the only remaining go-live gate.

## Addendum — G4b-2 + G4b-3 landed same session (G4 COMPLETE)

### G4b-2 — runner knowledge-propose capability + grant · `405681e`
`copilotAgentSynthesis.ts`: `CopilotAgentCapability` gained `propose_knowledge`; `resolveCopilotAgentCapability` gained `knowledgeProposeEnabled` (a propose capability ONLY on affirmed-trusted content; BOTH propose flags ⇒ read_only, fail-closed mutual exclusion). `buildCopilotAgentJob` maps it → `copilotKnowledgeProposeToolPolicy` + trusted. The runner distinguishes the two propose kinds by the JOB'S POLICY (`allowedTools` includes which tool id), NOT which deps are wired — a both-tools policy is rejected `invalid_job` BEFORE either grant. The propose_knowledge handler is closed over the SERVER-BOUND `job.workspaceId` + injected sourceRef + noteExists probe + sink. **HARDENING:** the seed-only read-tool strip now keys on `trustedScopedWrite` (propose-CAPABLE), not on the grant firing — a propose job with absent deps stays seed-only + tool-less (fail-closed) instead of falling back to read tools.
- **Adversarial review (general-purpose Agent): SHIP — no crit/high/med.** Trust gating, cross-grant isolation, shared-server mutual exclusion, seed-only TOCTOU closure, WS-4 workspaceId binding, and ING-7 admission all hold, layered + fail-closed across resolver + build + admission + runner. Fully dormant.

### G4b-3 — boot flag `copilotProposeKnowledge` (OFF) · `549114c`
Wires `createApprovalsKnowledgeProposeSink` + `createCopilotProposeKnowledgeMcpServer` + a vault existence probe + the sourceRef as the runner's knowledge deps. `knowledgeProposeEnabled` is COUPLED to the dispatch side (`config.copilotProposeKnowledge === true && config.proofSpineParams !== undefined`) — closes the G4a residual #1 (a proposed card is always committable, never stranded on external-only dispatch). Mutually exclusive with `copilotProposeMode`.

**§13.10a is now WIRED END-TO-END + DORMANT.** The whole bridge exists: a trusted Copilot answer can call `propose_knowledge` → PENDING §9.8 card → owner approval → head-at-commit KnowledgeWriter commit. Dormant because `deriveCopilotContentTrust` returns untrusted for every live gbrain hit (no adapter stamps `knowledge_writer`) AND the flag is OFF. **The ONLY remaining go-live gate is gate 4 — the C5.4b serving oracle (a retrieval adapter that stamps `knowledge_writer` on genuine KnowledgeWriter-authored Markdown), an eval-security-track arc.** Other go-live residuals (approve→dispatch reconciler; approvalId in audit refs; WS-8 path check) are hardening.

## Method notes carried
- Reviewer subagents gone → **general-purpose Agent** with security+code-quality prompts (adversarial pass on each safety-critical slice). Per-file `git add`; never staged `.claude/settings.json` / root `CLAUDE.md` / `graphify-out/`. `graphify update .` after code changes.
- Head-at-commit is safe ONLY because the writer's own ownership/region enforcement runs on live bytes — never weaken those defaults on the approval path.

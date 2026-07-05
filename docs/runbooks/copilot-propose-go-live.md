# Runbook — Copilot propose-action go-live

**Status: NOT LIVE (by design).** The Copilot's `copilot.propose_action` tool — the write-via-Approvals path (owner's P4 Option-C pick) — is fully built, governed, and TDD'd end-to-end, but is **structurally OFF** behind a real, fail-closed content-trust gate. This runbook is the explicit go-live gate: the preconditions that MUST be met, and the acceptance criteria that verify them, before the tool can fire on a live ask.

Do not flip this live by flag alone. `copilotProposeMode` is an **AND-term** with the content-trust verdict — it can never grant propose on its own.

## What is already built (Phase C, C1–C5.4a)

| Piece | Where | State |
|---|---|---|
| Tool catalog + `isMutatingCopilotTool` | `packages/policy/src/copilot-tool-catalog.ts` | done |
| Concrete `ClaudeAgentTransport` (governed `canUseTool` deny-by-default) | `packages/providers/src/runtime/claude-agent-sdk-transport.ts` | done |
| Agentic synthesis + gbrain read tools | `apps/worker/src/api/procedures/copilotAgentSynthesis.ts` | done |
| ING-7 admission wiring | `admitCopilotAgentJob` (same file) | done |
| Content-derived trust + capability | `resolveCopilotAgentCapability` / `deriveCopilotContentTrust` | done (real, C5.4a) |
| Propose derivation (server keys) | `deriveCopilotProposedAction` (`copilotPropose.ts`) | done |
| Route → §9.8 Approvals (unconditional) | `routeCopilotProposal` / `proposeCopilotAction` | done |
| Model-facing tool handler | `handleCopilotProposeToolCall` | done |
| SDK MCP registration adapter | `packages/providers/src/runtime/copilot-propose-mcp.ts` | done |
| Concrete sink → direct ApprovalRepository write | `copilotProposeSink.ts` | done |
| Runner grant (defense-in-depth) + seed-only surface | `createClaudeAgentCopilotRunner` | done |
| Boot flip point (`copilotProposeMode`) | `boot.ts` | done (OFF) |

## Why it is OFF today

`deriveCopilotContentTrust(context)` returns `"trusted"` **only** when the retrieval is non-empty AND every source carries `provenance === "knowledge_writer"`. No live retrieval adapter stamps `knowledge_writer` yet (gbrain hits leave provenance absent ⇒ `unknown` ⇒ untrusted), so every live ask resolves to a `read_only` job — the propose tool is never in the allow-list. This is fail-closed and honest.

## Go-live preconditions (ALL required)

### 1. C5.4b — a provenance-stamping retrieval adapter (the last content-trust gate)

A retrieval adapter must stamp `provenance: "knowledge_writer"` on a source **only** when the content is genuinely KnowledgeWriter-authored canonical Markdown.

- **The hard rule (do not weaken):** a blanket stamp on all gbrain hits **re-opens the ING-7 bypass C4 closed** — an owner's brain routinely holds ingested untrusted notes (web clips, imported email, external transcripts), and a false-`trusted` verdict makes a prompt-injected passage propose-capable. The C4 admission backstop (`admitCopilotAgentJob`) does **not** catch this: a `trusted`+`scoped_write` job is legitimately admitted.
- **Sound verification (per the C5.3 workflow's provenance survey):** self-reporting a stamp off a query hit is unsound (a borrowed/forged stamp passes a presence check). Only **serve-time HMAC re-verification** over an independently re-derived provenance tuple against the committed Markdown + the SecretsPort key proves KnowledgeWriter authorship. The oracle is `packages/knowledge` `admitForServing` / `verifyProvenanceStamp` — currently on a path the Copilot retrieval seam never touches.
- **Degraded coverage ⇒ untrusted:** dirty parity, a `GbrainPin` mismatch, an oracle failure, or an unresolved signing key (today's live reality — corpora absent) must all collapse to `unknown` (untrusted). Fail-closed.
- **Note:** a propose job is already **seed-only** (C5.4a strips the gbrain read tools), so the surface to verify is exactly the seed — no live-read TOCTOU to chase.

### 2. §9.8 approvals inbox — workspace scoping (OWNER DECISION)

`readModel.pendingApprovals(workspaceId)` currently returns `approvals.listByStatus("pending")` **unfiltered** — every workspace's inbox shows all pending cards. This was **global-by-design** (session 027; the `UiSafeApproval` projection is UI-safe). Copilot propose cards carry workspace-scoped, potentially raw-derived content, so global surfacing becomes a WS-4/WS-7 cross-workspace read once propose is live.

- **Decision required (Option A/B):** (A) make the inbox workspace-scoped — add `workspaceId` to the **frozen `Approval` seam** contract (Zod model + `schemas/*.schema.json` + `__snapshots__/*.snap` + `ARCHITECTURE.md` Appendix A + the cross-doc table) + `ApprovalRepository.listByStatusAndWorkspace` + route `pendingApprovals` through it; OR (B) keep the global inbox and accept the cross-workspace visibility for Copilot cards (only viable if the card content is provably sanitized/UI-safe for cross-scope viewing). **This reverses an intentional design + touches a frozen contract — the owner decides.**
- The Copilot sink already folds `workspaceId` into the derived Approval id (write-attribution is correct); this precondition is purely the **read** scope.

### 3. Governance / grounding eval (coordinate with the eval-security track)

Before flipping the flag, a governance eval for the propose path must be green (lives in `packages/evals` — the eval-security track's territory; coordinate). It must cover:

- **contentTrust TOCTOU:** inject a non-KnowledgeWriter passage reachable ONLY via a live tool read (not the seed) and assert `contentTrust` collapses to `untrusted` and propose is never granted. (With C5.4a's seed-only design there is no live read on a propose job — this asserts that stays true.)
- **No auto-apply:** every proposal → a pending §9.8 card; nothing executes on the decorative `approvalPolicy` string.
- **Payload-swap TOCTOU:** a same-object second proposal with a divergent payload is rejected, never overwriting an approved card.
- **Leakage / injection:** a prompt-injected propose intent cannot mis-target a write (keys are server-derived), cannot smuggle a workspace (server-bound), and cannot leak raw content into an error surfaced to the model.
- **Real SDK end-to-end (eval-gated):** the real `query()` drives the propose tool to a pending card within `DEFAULT_MAX_TURNS`.

## Flip procedure (only after 1–3 are met)

1. Land C5.4b (the provenance-stamping adapter) — verify a KnowledgeWriter-authored source stamps `knowledge_writer` and an imported note does NOT (adversarial test).
2. Land the §9.8 inbox scoping per the owner's Option A/B decision.
3. Green the governance eval (eval-security track).
4. Set `copilotProposeMode: true` (with `copilotAgentMode: true` + `copilotRealModel: true` + a running `gbrain serve --http`). Confirm on a trusted-content ask the job resolves `scoped_write`, the propose tool is in the allow-list, and a proposal lands as a pending card in the CORRECT workspace inbox only.

## Rollback

Set `copilotProposeMode: false` (or `copilotAgentMode: false`). The propose tool leaves the allow-list immediately; in-flight proposals already recorded remain as pending §9.8 cards the owner can reject. No external write can have occurred (the sink only records pending; dispatch-after-approval is the separate §9.8 command path).

## References

- Session docs `037` (C3–C5.2a), `038` (C5.2c–C5.4a).
- Memory `sow-copilot-real-model-direction` (full build history + the C5.3 design-workflow verdicts).
- Safety invariants: root `CLAUDE.md` "Key safety rules" (rule 3 external-write envelope, rule 4 WS-8, rule 6 ING-7).

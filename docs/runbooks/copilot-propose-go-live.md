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
| **C5.4b provenance-stamping decorator + serving-oracle SEAM** | `apps/worker/src/api/procedures/copilotProvenanceStamp.ts` | **done (C5.4b, `d170c3b`)** — decorator + interim (always-degraded) oracle wired behind `copilotProvenanceStamping` (OFF). The **real** admitForServing-backed oracle is the remaining gate (§1 below). |

## Why it is OFF today

`deriveCopilotContentTrust(context)` returns `"trusted"` **only** when the retrieval is non-empty AND every source carries `provenance === "knowledge_writer"`. No live retrieval adapter stamps `knowledge_writer` yet (gbrain hits leave provenance absent ⇒ `unknown` ⇒ untrusted), so every live ask resolves to a `read_only` job — the propose tool is never in the allow-list. This is fail-closed and honest.

## Go-live preconditions (ALL required)

### 1. C5.4b — the provenance-stamping seam (SEAM DONE `d170c3b`; the REAL oracle is the remaining gate)

A source is stamped `provenance: "knowledge_writer"` **only** when its content is genuinely KnowledgeWriter-authored canonical Markdown.

- **SHIPPED (C5.4b, `d170c3b`):** `createProvenanceStampingRetrieval` — a fail-closed `CopilotRetrievalPort` decorator that stamps a source `knowledge_writer` IFF a `CopilotServingOracle` admits its citationId under an explicit **gated** verdict; degraded / oracle-err / malformed / foreign-id (TOCTOU) / non-`Set` / missing-mode all strip to untrusted. It ALWAYS derives provenance from the verdict (an inner adapter can never self-stamp its way to trusted). Boot wires the **interim (always-degraded) oracle** behind `copilotProvenanceStamping` (OFF), so nothing is stamped today — the mechanism is real, its INPUT keeps it OFF (the C5.4a pattern). Adversarially designed + verified (workflow); both reviewers clean (0 crit/high/med).
- **The hard rule (do not weaken):** a blanket stamp on all gbrain hits **re-opens the ING-7 bypass C4 closed** — an owner's brain routinely holds ingested untrusted notes (web clips, imported email, external transcripts), and a false-`trusted` verdict makes a prompt-injected passage propose-capable. The C4 admission backstop (`admitCopilotAgentJob`) does **not** catch this: a `trusted`+`scoped_write` job is legitimately admitted.
- **THE REMAINING GATE — the real `admitForServing`-backed oracle (a deferred, security-review-gated sub-slice).** Replace `createInterimDegradedServingOracle` with a real oracle over `packages/knowledge` `admitForServing` / `verifyProvenanceStamp` (serve-time HMAC re-verification over a tuple independently re-derived from committed Markdown + the SecretsPort key — self-reporting a stamp off a query hit is unsound; a borrowed/forged stamp passes a presence check). Wiring ANY non-interim oracle is a security-review-gated event. Its **five named GO-LIVE PRECONDITIONS** (documented in `copilotProvenanceStamp.ts` header):
  1. **Content integrity** — the gated verdict must carry each admitted citation's rehydrated `AdmittedFact.content` + `mdContentSha`, and the path must **rebuild `RetrievedContext.blocks` from those proven bytes** (the model synthesizes over `blocks`, a separate array from `sources`; a trusted label must not sit over unverified bytes).
  2. **Granularity** — a `citationId` is per-slug/page, an `AdmittedFact.factIdentity` is per-fact (a page has many). Stamp a citationId `knowledge_writer` only if **every** fact reachable via it is admitted (all-or-nothing); prefer per-fact citationIds.
  3. **Resolver injectivity** — the slug/originPath → factIdentity resolver must withhold on any non-uniquely-resolvable originPath, and the back-map must be injective, so an attacker-controlled ingest slug colliding onto a real KW page's originPath cannot inherit its stamp.
  4. **ServingError mapping** — convert `admitForServing`'s hard `ServingError` (workspace_mismatch / revision_mismatch) into an oracle `err`, never swallow it into an `ok` verdict.
  5. **Citation uniqueness** — a `citationId` must be unique within a `RetrievedContext` (retrieval-side dedup), else one admission stamps every duplicate.
- **Degraded coverage ⇒ untrusted:** dirty parity, a `GbrainPin` mismatch, an oracle failure, or an unresolved signing key (today's live reality — corpora absent) must all collapse to untrusted. Already enforced by the decorator + `admitForServing`'s degraded mode.
- **Note:** a propose job is already **seed-only** (C5.4a strips the gbrain read tools), so the surface to verify is exactly the seed — no live-read TOCTOU to chase.

### 2. §9.8 approvals inbox — workspace scoping ✅ DONE (`f57a5a5`)

**Resolved (owner picked Option A; session 039).** `readModel.pendingApprovals(workspaceId)` now routes through `ApprovalRepository.listByStatusAndWorkspace("pending", workspaceId)`; `workspaceId` was added to the frozen `Approval` seam (Zod + `schemas/*.schema.json` + `__snapshots__/*.snap` + `ARCHITECTURE.md` Appendix A + cross-doc table) with an additive dual-dialect migration `0001`. The global inbox is preserved (the renderer fans the 3 known scopes and unions), now WS-8-safe (disjoint partitions). The cross-workspace read leak is CLOSED end-to-end. Security-reviewed clean. This precondition is met.

### 3. Governance / grounding eval (coordinate with the eval-security track)

Before flipping the flag, a governance eval for the propose path must be green (lives in `packages/evals` — the eval-security track's territory; coordinate). It must cover:

- **contentTrust TOCTOU:** inject a non-KnowledgeWriter passage reachable ONLY via a live tool read (not the seed) and assert `contentTrust` collapses to `untrusted` and propose is never granted. (With C5.4a's seed-only design there is no live read on a propose job — this asserts that stays true.)
- **No auto-apply:** every proposal → a pending §9.8 card; nothing executes on the decorative `approvalPolicy` string.
- **Payload-swap TOCTOU:** a same-object second proposal with a divergent payload is rejected, never overwriting an approved card.
- **Leakage / injection:** a prompt-injected propose intent cannot mis-target a write (keys are server-derived), cannot smuggle a workspace (server-bound), and cannot leak raw content into an error surfaced to the model.
- **Real SDK end-to-end (eval-gated):** the real `query()` drives the propose tool to a pending card within `DEFAULT_MAX_TURNS`.

## Flip procedure (only after 1–3 are met)

1. ~~Land C5.4b (the provenance-stamping seam).~~ **DONE `d170c3b`.** Then land the **real `admitForServing`-backed oracle** meeting all five preconditions in §1 — verify a KnowledgeWriter-authored source stamps `knowledge_writer` and an imported note does NOT (adversarial test), and that `blocks` are rebuilt from proven bytes.
2. ~~Land the §9.8 inbox scoping.~~ **DONE `f57a5a5`** (Option A).
3. Green the governance eval (eval-security track).
4. Set `copilotProposeMode: true` (with `copilotAgentMode: true` + `copilotRealModel: true` + a running `gbrain serve --http`). Confirm on a trusted-content ask the job resolves `scoped_write`, the propose tool is in the allow-list, and a proposal lands as a pending card in the CORRECT workspace inbox only.

## Rollback

Set `copilotProposeMode: false` (or `copilotAgentMode: false`). The propose tool leaves the allow-list immediately; in-flight proposals already recorded remain as pending §9.8 cards the owner can reject. No external write can have occurred (the sink only records pending; dispatch-after-approval is the separate §9.8 command path).

## References

- Session docs `037` (C3–C5.2a), `038` (C5.2c–C5.4a), `039` (§9.8 inbox scoping), `040` (C5.4b provenance-stamping seam).
- Memory `sow-copilot-real-model-direction` (full build history + the C5.3 design-workflow verdicts).
- Safety invariants: root `CLAUDE.md` "Key safety rules" (rule 3 external-write envelope, rule 4 WS-8, rule 6 ING-7).

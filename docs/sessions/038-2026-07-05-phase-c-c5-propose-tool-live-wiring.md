# Session 038 — Phase C (tool-enabled Copilot): C5.2c + C5.3 (the propose tool, live-wired but OFF)

- **Date:** 2026-07-05 · **Mode:** single-operator (build, ultracode) · **Track:** worker + providers
- **Predecessor:** `037-2026-07-05-phase-c-c3-c4-agentic-copilot.md`
- **Successor:** `039-2026-07-05-approvals-inbox-workspace-scoping.md` (§9.8 inbox scoping — go-live blocker 1 of the owner's "do all 3")
- **HEAD at close:** `3c64052` (C5.4a). This session: C5.2c `e530032` → C5.3a `0be926a` · C5.3b `28a78e9` · C5.3c `41dd26b` · C5.3d `1d14524` → C5.4a `3c64052`.
- **Gate at close:** repo-wide `turbo typecheck test` **31/31**; worker **628**; providers +5 (copilot-propose-mcp). Pushed at close-out.

## Why this session existed

The owner chose **Option B** ("the model calls a propose tool") for C5. C5.1 (content-derived trust) + C5.2a/b/c (derive → route → model-facing handler) built the propose LOGIC over fakes. This session wired it LIVE — the SDK MCP registration, the concrete §9.8 sink, the runner grant, and the boot flip point — **structurally OFF** behind a fail-closed content-trust interim.

## The C5.3 design workflow (ultracode)

C5.3 had real design uncertainty (the sink→recording seam, where zod lives, the content-provenance model) + three security contracts. Ran a **survey → design → adversarial-verify** Workflow (`wf_00490f49-920`): 4 parallel surveys → design synthesis → **4 parallel adversarial verifiers, one per contract**. (Hit the weekly limit mid-run; resumed from cache after re-login — the 3 completed surveys replayed, the tail re-ran.) Verdicts:

- **[YES] redaction / no-auto-apply** — structural, unbreakable.
- **[PARTIAL] payload-swap TOCTOU** — core holds (A′ can't execute), but the sink sketch had a **compile bug**: `makeApprovalId` imported from `@sow/domain` (which doesn't export it) instead of `approvalId as makeApprovalId` from `@sow/contracts`. Folded the fix + a cross-path id-equality test.
- **[PARTIAL] workspace provenance** — write side airtight; surfaced a **pre-existing §9.8 read-model leak** (a C5.4 blocker).
- **[PARTIAL] contentTrust** — immediate fail-closed airtight, but "trust over the whole tool-reachable surface" is a genuine **TOCTOU** a build-time resolver can't satisfy (a C5.4 re-scope). Added the trustLevel defense-in-depth gate.

The verifiers earned their cost — two of the four corrections (the compile bug, the trustLevel gate) were load-bearing.

## What was built

### C5.2c (`e530032`) — the model-facing tool handler
`handleCopilotProposeToolCall(rawArgs, {workspaceId, sink})` in `copilotPropose.ts` — drives derive→route over the model's untrusted args, returns a `CallToolResult`-shaped result (pending-approval ack / bounded error). Fail-safe + redaction-safe. Surveyed the SDK's `createSdkMcpServer`/`tool` API (needs a zod raw shape → registration deferred to C5.3a).

### C5.3a (`0be926a`) — providers SDK MCP adapter
**Created** `packages/providers/src/runtime/copilot-propose-mcp.ts` — `createCopilotProposeMcpServer(handler)` exposes `mcp__copilot__propose_action` via `createSdkMcpServer` + `tool()` over a zod raw shape, delegating to an injected worker handler (typed structurally, args-as-`unknown`, so providers ↛ worker). zod `^3.23.8` added to **providers only** (dedupes to the SDK's `zod@3.25.76`). The zod shape is model-facing ergonomics, NOT the gate — the worker's strict parse stays authoritative.

### C5.3b (`28a78e9`) — the concrete sink
**Created** `apps/worker/src/api/procedures/copilotProposeSink.ts` — `createApprovalsProposeSink` records a PENDING §9.8 Approval via a **direct ApprovalRepository write** (no Temporal — the in-process Copilot needs no workflow context). Mirrors `createRecordPendingActivity`'s stable-id derivation (so an in-process record + a Temporal re-drive collide on ONE row) and enforces all three contracts: **(a)** server-bound workspaceId registry-validated + folded into the id; **(b)** first-write-wins + **payloadHash-divergence REJECT** (the TOCTOU guard the activity omits); **(c)** `dbErrorToProposeFailure` bounded codes, never throws, never auto-applies.

### C5.3c (`41dd26b`) — runner + synthesis wiring
**Edited** `copilotAgentSynthesis.ts` — `deriveCopilotContentTrust` (**fail-closed interim, always `untrusted`**); `createAgentRuntimeCopilotSynthesis(runner, opts?)` threads `{contentTrust, proposeEnabled}`; the runner gains `proposeSink?`+`buildProposeMcpServer?` and a **propose-grant branch with defense-in-depth** (served + `trustLevel==='trusted'` + `mode==='scoped_write'` + both deps present) that appends the tool to the allow-list + composes the copilot MCP server + binds the handler to the **server-bound `job.workspaceId`**. Read-only default path byte-identical.

### C5.3d (`1d14524`) — boot flip point
**Edited** `boot.ts` — `copilotProposeMode` flag (OFF); builds the sink over `backends.repos.{approvals,workspaceConfig}`+`backends.now`; injects sink + `createCopilotProposeMcpServer` + `{proposeEnabled: flag, resolveContentTrust: deriveCopilotContentTrust}`. Because the resolver is fail-closed, **propose stays OFF at runtime even with the flag ON**.

## Decisions made

- **The propose tool ships fully wired but STRUCTURALLY OFF** — `deriveCopilotContentTrust` returns `untrusted` unconditionally, so no live ask resolves to a propose-capable job. The flag is an AND-term with the trust verdict, never a standalone override.
- **The concrete sink is a direct ApprovalRepository write, not a Temporal activity** — recording a pending card is two repo calls; the in-process Copilot has the same `backends.repos.approvals`.
- **zod added to providers only** — the single manifest change; the worker keeps its zod-free strict-parse boundary.

## Decisions explicitly NOT made (deferred to C5.4 — BOTH gate propose go-live)

- **§9.8 read-model workspace scoping.** `readModel.ts pendingApprovals(workspaceId)` returns `listByStatus('pending')` UNFILTERED — every workspace's inbox shows all cards (Approval has no workspaceId column). Dormant (propose is OFF) but a real cross-workspace disclosure once propose goes live. Needs `listByStatusAndWorkspace`.
- **Real per-content contentTrust.** A build-time resolver can't see LIVE `mcp__gbrain__query` reads (TOCTOU). C5.4 must EITHER strip the gbrain read tools from a propose job (seed-only surface — simplest sound design) OR add a read-time `canUseTool`/read-result hook that revokes propose on the first non-KnowledgeWriter passage.

## TDD compliance

Clean. C5.3a (5 tests), C5.3b (8 — all 3 contracts + cross-path id + no-auto-apply), C5.3c (9 — grant/deny matrix + server-bound workspace binding + the flag-alone AND-term) all RED→GREEN. The real SDK `query()` end-to-end + the C5.4 governance/leakage eval are eval-gated (noted). C5.3d is a flag-gated boot passthrough (exercised by the existing bootstrap tests; default path unchanged).

## Reachability

`answerCopilotQuestion` → `deps.synthesis` → (boot `copilotAgentMode`) `createAgentRuntimeCopilotSynthesis` → `admitCopilotAgentJob` → runner → (propose-grant branch, when a job is trusted+scoped_write+served) → SDK `query()` with `mcp__copilot__propose_action` → `handleCopilotProposeToolCall` → `proposeCopilotAction` → derive → route → `createApprovalsProposeSink.record` → pending §9.8 Approval. **Wired end-to-end; the propose branch is dormant** (the fail-closed trust interim never yields a propose-capable job on a live ask). This is a flag-gated, trust-gated feature — not a silent gap.

## C5.4a (`3c64052`) — real content-trust + seed-only propose surface

Built the same session (post-C5.3), under the owner's standing "keep going" while they were away — the one remaining path safe to do unilaterally (additive, worker-territory, no frozen-contract change, no design reversal).

- **`deriveCopilotContentTrust` is now REAL** (was a fail-closed stub): `'trusted'` IFF the retrieval is non-empty AND every source is `knowledge_writer`-provenance, else `'untrusted'` — one imported/unknown/absent source taints the whole. `RetrievedSource` (worker-internal, NOT a frozen contract) gains an optional `provenance` field; absent ⇒ untrusted.
- **A propose job is now SEED-ONLY** — the runner strips the gbrain read tools (the C5.3-workflow verifier's recommended TOCTOU fix). The tool-reachable content surface == the pre-verified seed, so the build-time trust verdict is sound (a propose agent can't fetch more/untrusted content mid-run).
- **Security review: no crit/high/medium.** Seed-only design confirmed sound (deny-by-default `canUseTool` blocks every built-in incl. WebFetch; no residual read path); derivation fail-closed + taint-correct (empty-guard defeats the vacuous-truth trap; provenance server-side-only). **Propose genuinely still OFF** — no live adapter stamps `knowledge_writer`.

## Open follow-ups (2 are OWNER DECISIONS — deferred, not acted on)

- **[OWNER DECISION] §9.8 approvals inbox scoping** — `pendingApprovals` is global (all cards to every workspace); making it workspace-scoped **reverses the intentional global-inbox design (session 027)** + adds `workspaceId` to the **frozen `Approval` seam contract**. A go-live blocker AND a design/UX decision.
- **[OWNER DECISION] C6 skills** — expose skill access (the third leg of Option C); needs direction on which skills / what governance.
- **[C5.4b — the last contentTrust go-live gate]** a retrieval adapter that stamps `knowledge_writer` provenance ONLY on genuinely KnowledgeWriter-authored canonical Markdown (a blanket stamp on gbrain hits re-opens the ING-7 bypass — the C4 admission backstop can't catch a false-trusted job). Depends on wiring the knowledge layer's `admitForServing`/stamp verification into the retrieval seam.
- **[C6 eval]** the propose-path governance/grounding eval (packages/evals is the eval-security track's territory — coordinate) + the real SDK `query()` end-to-end (eval-gated).

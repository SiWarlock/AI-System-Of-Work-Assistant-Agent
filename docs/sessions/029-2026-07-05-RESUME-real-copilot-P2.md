# RESUME HANDOFF — real Copilot Phase 2 (in progress: P2.3 next)

> **PROSPECTIVE handoff** (for the next session, post-compaction). Predecessor: `028-2026-07-04-real-copilot-P1-egress-governance.md`. **Successor: `030-2026-07-05-real-copilot-P2.3-P2.4.md`** (P2.3 + P2.4 DONE — the resume plan below was executed).
> Everything below is DONE + pushed to `origin/main` at **HEAD `8e39265`**. The next unit is **P2.3** (the worker synthesis adapter). The single richest context file is the memory `sow-copilot-real-model-direction` — read it first.

---

## ▶ RESUME PROMPT (paste this to start the next session)

```
Continue the System of Work Assistant BUILD — the REAL Copilot model path, Phase 2. Done + pushed
(HEAD 8e39265 on origin/main): §9.8 Approvals; real-Copilot P1 (egress governance + the visible
Employer-Work cloud-egress notice, end-to-end, adversarially reviewed, M-1 discharged); P2.1 (the
veto-cleared route threaded into synthesis); P2.2 (the Claude-SUBSCRIPTION completion client — the SDK
"transport" — TDD'd). Auth is FRICTIONLESS: the machine already has an authenticated Claude Code
session and the Agent SDK auto-uses it (owner chose the subscription path, informed of the ToS
gray-area — personal use, own login).

NEXT = P2.3: the WORKER synthesis adapter. Implement the real CopilotSynthesisPort (in apps/worker)
using the `ClaudeSubscriptionCompletion` client from @sow/providers:
  - build the Copilot SYSTEM prompt (answer grounded ONLY in the retrieved context; cite by
    citationId; NO invention — REQ-F-017 no-inference; refuse/empty when nothing is found) + the USER
    prompt (the question + the numbered context blocks tagged with their citationIds) + the JSON schema
    for { answer: string[], citations: [{citationId, title}] };
  - call client.complete({ model: route.model, systemPrompt, userPrompt, outputSchema });
  - map structuredOutput → CandidateCopilotAnswer, FAIL-CLOSED on malformed (the toUiSafeCopilotAnswer
    gate re-validates downstream, so a bad shape is dropped, never served);
  - TDD the DETERMINISTIC parts (prompt building, output mapping, error folding) with a FAKE completion
    client. The real query() call is eval-tested, not unit-tested (LLM/provider posture).
  CARRY-FORWARDS to honor (from the P2.2 review): route CompletionError.message through the §16
  redaction layer before ANY log sink (SDK-origin, may carry content); pass ONLY the veto-cleared
  route (decision.route, already threaded in P2.1) to the adapter — the veto gates upstream in
  answerCopilotQuestion, and this client unconditionally bills the cloud.

Then P2.4 (wire it behind a config flag with a real CLOUD RUNTIME route selector so the veto
classifies it as egress and the NOTICE FIRES for real — replace boot's createLocalRouteSelector for
the real path; the route is a runtime route {runtime:"claude-agent-sdk", endpoint, egressClass:"cloud"}
→ processorOfRoute labels it by the runtime id, consider a friendlier notice label) and P2.5 (the
model-prose eval — grounding + citation correctness, labeled corpus).

Read FIRST: memory `sow-copilot-real-model-direction` (the richest context — auth decision, SDK facts,
slice plan, carry-forwards) + this doc + docs/sessions/028-…-real-copilot-P1-egress-governance.md.

Method (standing): TDD for deterministic/security slices (failing test first); LLM/model work is
EVAL-tested via packages/evals. Commit per slice (explicit git add <path>, never -A; Conventional
Commits + Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>); ultracode; dispatch
security-reviewer + code-quality-reviewer per security-touching slice; run REPO-WIDE
`pnpm -w turbo run typecheck test` after any port/contract change (cross-package consumers). Don't
touch the parallel worktree ../SoW-build-evalsec (Phase-12 eval track). Push at close-out.
```

---

## Current state — DONE + PUSHED (HEAD `8e39265` on origin/main)

**§9.8 Approvals page** — `770f2f0`…`eca2660` + close-out `06e4bbf`. Routable Approvals inbox on the AppShell/Route foundation; the backend pre-existed; fixed a real leak (command.decideApproval was returning the raw Approval). Session doc `027`.

**Real Copilot P1 — egress governance + notice** — `56e9731`…`27aa649` + close-out `efba9b7`. Session doc `028`. End-to-end + adversarially reviewed (M-1 discharged):
- P1.1 `UiSafeCopilotAnswer.egressProcessor?` (the notice carrier).
- P1.2a `decideCopilotEgress` (pure) — fail-closed veto + the **leak-safe `processorOfRoute` predicate** (catches tunneled-local egress `egressClass` would miss).
- P1.2b wired into `answerCopilotQuestion` (authoritative posture by workspaceId, veto BEFORE synthesis, notice threaded through the strict-schema gate).
- P1.3 the visible **notice banner** in the Copilot sidebar.

**Real Copilot P2 (in progress):**
- P2.1 `7a96b7e` — `CopilotSynthesisPort.synthesize` now receives `decision.route` (the veto-cleared route); orchestration passes it. Discharges the P1.2b carry-forward.
- P2.2 `6e6104d` (dep) + `8e39265` (transport) — **`packages/providers/src/model/claude-subscription-completion.ts`**: a generic Claude-subscription completion via the SDK `query()`. Pure `extractCompletion` (TDD, 7 tests, fail-closed); real `complete()` = thin `query()` shell. **`tools: []`** disables tools (the HIGH review fix — `allowedTools:[]` is only auto-approve; LESSONS §1 recurring).

Gate at HEAD: repo-wide `turbo typecheck test` **31/31** (worker 424 · contracts 630 · desktop 172 · providers 239 · evals 148).

## The load-bearing DESIGN DECISION (P2.2)

Copilot synthesis uses a **dedicated subscription completion client**, NOT the ref-based `ModelProviderPort`/`AgentRuntimePort`. Both of those carry `inputRefs`/`contextRefs` (references into a persistent store, redaction-safe), but Copilot's retrieved context is **ephemeral + inline** — so that design doesn't fit, and the agentic tool-loop is overkill for synthesis-only (tools are P4). Redaction is preserved by **never logging the prompt**. The general `AgentRuntimePort` transport (with tools) is the RIGHT abstraction for **P4** (full tools), built then.

## What's left in the real Copilot path

- **P2.3** — the worker synthesis adapter (prompt + schema + mapping; TDD w/ a fake client). Detail in the resume prompt + the memory.
- **P2.4** — wire it live: a cloud runtime route selector + the real synthesis behind a config flag → the **notice fires for real**. Replace boot's `createLocalRouteSelector`; the runtime route labels the processor by its runtime id (consider a friendlier notice label).
- **P2.5** — model-prose eval (grounding + citation correctness; labeled corpus; PRD §20.1 / EVAL-1 floors).
- **P3** GBrain retrieval (owner ran `/setup-gbrain`; Voyage `voyage-3` key set → semantic retrieval functional). **P4** full tools (Tool Gateway API connectors, per-workspace Google accounts, propose→§9.8-Approvals — the agentic AgentRuntimePort transport lands here). **P5** = the eval.

## Load-bearing reminders (any slice)

- **Auth is frictionless** — the machine has an authed Claude Code session; the SDK auto-uses it. No cutover setup. (ToS gray-area: personal use / own login — owner accepted.)
- **The notice is DORMANT until P2.4** — the interim runs over a LOCAL route, so `decideCopilotEgress` allows with no notice. P2.4's cloud route makes it fire.
- **`tools: []` not `allowedTools: []`** to disable tools (LESSONS §1 — providers). Applies again at P4.
- **Safety invariants** (root CLAUDE.md): one-writer / candidate-data gate / external-write envelope / WS-8 isolation / Employer-Work egress veto (OpenRouter is its own processor; no cloud fallback) / ING-7 tool-stripping / secrets via SecretsPort.
- **Don't touch `../SoW-build-evalsec`** (parallel Phase-12 eval track) or the youtube-source/capture-source/PHASE-13 files.
- **Redaction** (§16): the P2.3 adapter must route `CompletionError.message` through the redaction layer before any log sink.

## Key files

- `packages/providers/src/model/claude-subscription-completion.ts` — the transport (P2.2). `ClaudeSubscriptionCompletion` + `createClaudeSubscriptionCompletion()` + `extractCompletion`.
- `apps/worker/src/api/procedures/copilot.ts` — `CopilotSynthesisPort` (route threaded), `answerCopilotQuestion` (the wired egress decision), `decideCopilotEgress`, `toUiSafeCopilotAnswer` (the candidate gate), the interim factories + `createStubSynthesis` (P2.3 adds the REAL adapter alongside).
- `apps/worker/src/boot.ts` — the interim wiring (`createLocalRouteSelector` → P2.4 swaps the real cloud route).
- `apps/desktop/renderer/surfaces/copilot/Copilot.tsx` — the notice banner (P1.3).
- SDK types: `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.201_*/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`query`, `Options`, `SDKResultSuccess.structured_output`, `tools`/`allowedTools`).
```

# RESUME HANDOFF — Phase C (tool-enabled Copilot / full agent), continue at C3

> **PROSPECTIVE handoff** for the next session (post-compaction). Predecessor: `035-2026-07-05-phase-c-tool-enabled-copilot-survey-and-c1.md`. **Successor (executed): `037-2026-07-05-phase-c-c3-c4-agentic-copilot.md`** (C3 + C4 landed).
> Everything CODE is DONE + pushed to `origin/main` at **HEAD `3fec0d6`**. Phase C (owner chose Option C — full agent) is **2 of 6 slices done: C1 + C2**. NEXT = **C3** (the agent-runtime Copilot synthesis adapter). Read the memory `sow-copilot-real-model-direction` FIRST — it has the full survey map + gotchas.

---

## ▶ RESUME PROMPT (paste this to start the next session)

```
Continue the System of Work BUILD — Phase C (tool-enabled Copilot / FULL AGENT, the owner's P4 choice),
now at slice C3. Everything before is DONE + pushed (origin/main HEAD 3fec0d6). Phase C = 6 slices;
C1 + C2 are DONE + security-reviewed + pushed:
- C1 (88b0f7d) packages/policy/src/copilot-tool-catalog.ts — the tool catalog + isMutatingCopilotTool
  fail-safe classifier + copilotReadToolPolicy/copilotAgentToolPolicy + copilotReadOnlyPolicyIsPure. It's
  the ING-7 MECHANISM; enforcement is wired in C4 (don't treat ING-7 as "closed" yet).
- C2 (bee9d8e) packages/providers/src/runtime/claude-agent-sdk-transport.ts — the concrete
  ClaudeAgentTransport (real SDK query() WITH tools), GOVERNED by a deterministic canUseTool deny-by-default
  (the security review proved `tools:[]` is NOT a real SDK option / no-op — canUseTool is the real guard) +
  explicit permissionMode:'default'. buildAgentQueryOptions/extractAgentRawResult/foldAgentSdkThrow/
  buildCanUseTool/detectForbiddenToolAttempt all pure+TDD'd; createClaudeAgentSdkTransport takes an
  injectable queryFn (real query() eval-gated) + a promptBuilder dep (the invocation carries refs, not text).

BUILD C3 — createAgentRuntimeCopilotSynthesis: a NEW implementation of the SAME CopilotSynthesisPort
(synthesize(workspaceId, question, context, route) => MaybeAsyncResult<CandidateCopilotAnswer>) that drives
the AgentRuntimePort (createClaudeAgentSdkRuntime + the C2 transport) with READ TOOLS, instead of the
tool-less completion client. Swap it in at buildCopilotDeps behind a new flag (e.g. copilotAgentMode),
alongside the existing realCopilot branch. HARD CONSTRAINTS (from the survey — do NOT relax):
  1. BIND the passed veto-CLEARED `route` — never re-select a route inside the adapter (that makes the
     egress veto advisory). Build the AgentJob's providerRoute from `route` as a RUNTIME route
     {runtime:'claude-agent-sdk', model, endpoint, egressClass} (buildClaudeAgentInvocation REQUIRES a
     runtime route — the current cloud route is a {provider:'claude'} route, so map it).
  2. The read tools come from gbrain's serve --http MCP endpoint (from #2 — createGbrainHttpExec/
     createGbrainDcrTokenProvider already exist): wire it as an SDK mcpServer {type:'http', url:
     `${baseUrl}/mcp`, headers:{Authorization:`Bearer ${token}`}}. GOTCHA: SDK MCP tool names are
     `mcp__<server>__<tool>` (e.g. mcp__gbrain__query), so MAP C1's dotted ToolIds (gbrain.search →
     mcp__gbrain__query, etc.) into allowedToolNames for buildCanUseTool/allowedTools — a mismatch
     fail-safes to deny-all.
  3. Preserve the downstream candidate gate: answer array bounded 1..40, citations ≤20; the model's
     candidateOutput must still flow through mapCompletionToCandidate (citation reconciliation) → the
     UiSafeCopilotAnswer gate in answerCopilotQuestion. Don't touch answerCopilotQuestion's gate ordering.
  4. TDD the DETERMINISTIC parts (route→runtime-route mapping, the ToolId→mcp-name mapping, the
     promptBuilder, mapping AgentResult.candidateOutput → CandidateCopilotAnswer) with a fake
     AgentRuntimePort/transport; the real query() is eval-gated.

Then C4 (ING-7: build the Copilot AgentJob with copilotReadToolPolicy/copilotAgentToolPolicy, admit via
admitJob(job, isMutatingCopilotTool) + copilotReadOnlyPolicyIsPure; untrusted ask ⇒ read_only — this
ACTIVATES C1's enforcement) → C5 (propose-writes → §9.8 Approvals: concrete BuildProposalPort +
QaRouteToApprovalPort → RecordPendingPort; DERIVED action never client-supplied; idempotency by derived
Approval id) → C6 (skills + wire behind the flag + governance/grounding eval).

Read FIRST: memory `sow-copilot-real-model-direction` (full survey map + all gotchas) + docs/sessions/036
(this) + 035 + apps/worker/src/api/procedures/copilot.ts (CopilotSynthesisPort, CandidateCopilotAnswer,
answerCopilotQuestion, buildCopilotDeps seam) + copilotClaudeSynthesis.ts (createClaudeCopilotSynthesis —
the sibling this parallels, incl. mapCompletionToCandidate + the route guard) + packages/providers/src/
runtime/claude-agent-sdk-runtime.ts (createClaudeAgentSdkRuntime + buildClaudeAgentInvocation) +
claude-agent-sdk-transport.ts (C2) + packages/policy/src/copilot-tool-catalog.ts (C1).

Method (standing): TDD deterministic/security slices (failing test first); LLM/model work EVAL-tested.
Commit per slice (explicit git add, never -A; Conventional Commits + Co-Authored-By: Claude Opus 4.8
(1M context) <noreply@anthropic.com>); ultracode; security-reviewer + code-quality-reviewer per
security-touching slice (all of C3–C6 are); repo-wide `pnpm -w turbo run typecheck test` after any
port/contract change. Don't touch the parallel worktree ../SoW-build-evalsec. Push at close-out.
```

---

## Current state — DONE + PUSHED (HEAD `3fec0d6`)

This session ("do all of them" on the 3 P3-live follow-ups + the owner's Option-C pick) landed, all pushed:
- **#1** (`dd4398b`) app-reachability — `resolveCopilotWorkspaces` decouples Copilot from devProvision.
- **#2** (`452e359`) http-grant transport — read gbrain over `serve --http` (OAuth/DCR/MCP, loopback-only, single-flight); **fixes the PGlite lock**, proven live. `createGbrainHttpExec` + `createGbrainDcrTokenProvider` in `apps/worker/src/api/procedures/copilotGbrainHttp.ts`.
- **C1** (`88b0f7d`) tool catalog + classifier (Phase-C).
- **C2** (`bee9d8e`) concrete ClaudeAgentTransport (Phase-C) — the hardest slice; critical `tools:[]`-no-op finding fixed via `canUseTool`.
- Session docs 033/034/035; all round docs pushed. Repo-wide gate 31/31 throughout.

## Phase C — 2 of 6 done

| Slice | Status |
|---|---|
| C1 — tool catalog + `isMutatingCopilotTool` | ✅ `88b0f7d` |
| C2 — concrete `ClaudeAgentTransport` | ✅ `bee9d8e` |
| **C3 — `createAgentRuntimeCopilotSynthesis`** | **NEXT** |
| C4 — ING-7 wiring (activates C1) | todo |
| C5 — propose-writes → §9.8 Approvals | todo |
| C6 — skills + flag + eval | todo |

## Survey map — the surfaces C3+ plug into (all confirmed real)

- **AgentRuntimePort**: `createClaudeAgentSdkRuntime(transport)` (packages/providers) — wire C2's transport into it → an AgentRuntimePort. `buildClaudeAgentInvocation(job)` maps AgentJob→invocation (REQUIRES a `{runtime:...}` route). The adapter maps `mutatingToolAttempted && readOnly → tool_policy_violation`.
- **Copilot synthesis seam**: `createClaudeCopilotSynthesis` (the tool-less sibling C3 parallels) + `answerCopilotQuestion` + `buildCopilotDeps` (apps/worker). Egress veto runs BEFORE synthesis; `route` is the veto-cleared one.
- **ING-7**: `admitJob(job, isMutatingTool?)` (packages/policy) — REAL + wired. C4 injects `isMutatingCopilotTool`.
- **§9.8 Approvals + Tool Gateway**: REAL + wired (`createRecordPendingActivity`, `dispatchExternalWrite`); the Copilot propose→Approvals ports (`BuildProposalPort`/`QaRouteToApprovalPort`) are the C5 gap (test fakes only).

## Load-bearing reminders

- **C2's `tools:[]` is a no-op** — the containment guarantee is `canUseTool` (deny-by-default) + `permissionMode:'default'`. Any C3 wiring MUST supply `allowedToolNames` as `mcp__<server>__<tool>` names or it fail-safes to deny-all.
- **Bind the veto-cleared route** (C3 constraint 1) — the #1 security pitfall the survey flagged.
- Safety invariants unchanged (root CLAUDE.md): one-writer / candidate gate / external-write envelope / **WS-8** (cross-workspace reads via the GCL Visibility Gate, never a direct agent tool) / Employer-Work egress veto / **ING-7** / secrets via SecretsPort.
- ⚠ Concurrency: `../SoW-build-evalsec` (track/eval-security) commits Phase-12 work to shared `main` history — interleaves but no file collision (it edits plan/knowledge; this track edits copilot/providers/policy).

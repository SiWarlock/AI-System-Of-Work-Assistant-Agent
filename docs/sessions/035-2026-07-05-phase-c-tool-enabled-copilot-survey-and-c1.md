# Session 035 — Phase C (tool-enabled Copilot / full agent): survey + C1 (tool catalog)

- **Date:** 2026-07-05 · **Mode:** single-operator (build, ultracode) · **Tracks:** policy (C1) · providers/worker (C2+ ahead)
- **Predecessor:** `034-2026-07-05-copilot-reachability-and-http-grant-transport.md`
- **Successor:** _(none yet — Phase C continues at C2)_
- **HEAD at close:** `88b0f7d` (C1) atop `abaa1b3`.
- **Gate at close:** repo-wide `turbo typecheck test` **31/31** (policy 224, +14 C1). #2/#1 pushed; C1 committed (push at continuation).

## Why this session existed

The owner chose **Option C — the full agent** for #3 (P4 "full tools"): the Copilot gets read + write-via-Approvals + skills. That's a **phase**, not a slice. This session ran a parallel survey to map the surfaces, then built the foundational slice **C1**.

## The survey (6-agent parallel fan-out) — the accurate map

- **AgentRuntimePort is STUB-ONLY.** The pure `buildClaudeAgentInvocation(job)` mapper (AgentJob→ClaudeAgentInvocation: allowedTools/readOnly) is built + tested, but there is **NO concrete `ClaudeAgentTransport`** — only `SpyTransport` in tests. `createClaudeAgentSdkRuntime(transport)` is never wired in production. The LIVE Copilot uses `createClaudeSubscriptionCompletion` (`tools:[]`, `maxTurns:1` — structurally tool-less).
- **ING-7 admission is FULLY REAL + wired.** `admitJob(job, isMutatingTool?)` (packages/policy/src/admission.ts) — untrusted + mutating → HARD REJECT `UNTRUSTED_CONTENT_MUTATING_TOOL`; trust fail-closed. **arch_gap: no tool catalog / no `isMutatingTool` supplier** (ToolId is an open branded string). ← C1 fills this.
- **Tool Gateway + external-write envelope FULLY IMPLEMENTED** (`dispatchExternalWrite`, `resolveExisting`, `receiptStore.reserve()` atomic — exactly-once). Reached ONLY after an 'approved' CAS via `createDispatchApprovedActivity`. Per-vendor adapters are the only stubs.
- **§9.8 Approvals REAL + wired** (ProposedAction → `createRecordPendingActivity` → pending Approval → `decideApproval` CAS → dispatch). **BUT the Copilot propose→Approvals wiring is NOT built** — `BuildProposalPort` + `QaRouteToApprovalPort` are interfaces with only test fakes. ← C5.
- **Copilot synthesis seam:** `answerCopilotQuestion` orders posture → route → **egress veto (BEFORE synthesis)** → retrieval → synthesize → candidate gate. Cleanest integration: a new `createAgentRuntimeCopilotSynthesis` implementing the SAME `CopilotSynthesisPort`, swapped in at `buildCopilotDeps` behind a flag. HARD CONSTRAINTS: bind the veto-cleared `route` (don't re-select); answer bounded 1..40, citations ≤20; `mapCompletionToCandidate` reconciliation survives.
- **Big shortcut:** gbrain's `serve --http` (wired in #2, session 034) is itself an **MCP server the Agent SDK can consume directly** — so read tools largely come "for free" by pointing the SDK at that endpoint (DCR/OAuth already built). Cross-workspace reads still go through the GCL Visibility Gate, never a direct agent tool.

## C1 — the Copilot tool catalog + `isMutatingCopilotTool` classifier (`88b0f7d`)

**File:** `packages/policy/src/copilot-tool-catalog.ts` (+ test, + barrel). The MECHANISM for the ING-7 arch_gap:
- `COPILOT_READ_TOOLS` (gbrain read surface + vault.read; all non-mutating, frozen) + `COPILOT_PROPOSE_TOOL` (classified **mutating** — an untrusted agent must not propose writes even though they route to Approvals).
- `isMutatingCopilotTool` — **fail-safe** (unknown tool → mutating).
- `copilotReadToolPolicy()` (read_only) / `copilotAgentToolPolicy()` (scoped_write) / `copilotReadOnlyPolicyIsPure()` (the deferred "read_only ⇒ no mutating tool" clause — catches a read_only policy secretly listing a mutating tool).

**Security review (ING-7 axis): classifier + purity helper individually correct + fail-safe. HIGH finding: the slice is a MECHANISM and is INERT — nothing wires it into enforcement yet, so the ING-7 clause it targets stays UNENFORCED as-shipped.** Addressed honestly: corrected the comments to NOT claim "closed"; the enforcement is **C4**. Low finding fixed (froze the specs). 14 tests.

## Phase C roadmap (remaining)

| Slice | What | Risk |
|---|---|---|
| **C2** | Concrete `ClaudeAgentTransport` — real SDK `query()` WITH tools (`tools:` availability list from `inv.allowedTools`, MCP server = gbrain `serve --http`); streams a `ClaudeAgentRawResult`; sets `mutatingToolAttempted`. Wire `createClaudeAgentSdkRuntime`. **Highest-risk real-I/O boundary** — pure option-mapping TDD'd (already have `buildClaudeAgentInvocation`), real call eval/integration-gated. Redaction: never log the prompt/tool I/O. | HIGH |
| **C3** | `createAgentRuntimeCopilotSynthesis` (CopilotSynthesisPort over the runtime + read tools). Preserve the veto-cleared route + `mapCompletionToCandidate` + the 1..40/≤20 bounds. | med |
| **C4** | ING-7 wiring for the Copilot AgentJob: build the job with `copilotReadToolPolicy`/`copilotAgentToolPolicy`, admit via `admitJob(job, isMutatingCopilotTool)` **+ `copilotReadOnlyPolicyIsPure`**; untrusted (imported-content) ask ⇒ read-only. (Closes C1's enforcement gap.) | med |
| **C5** | Propose-writes → §9.8 Approvals: concrete `BuildProposalPort` (derive ProposedAction from the cited answer — never client-supplied) + `QaRouteToApprovalPort` → `RecordPendingPort`. NEVER a direct write. Idempotency by DERIVED Approval id. | med |
| **C6** | Skills exposure + wire behind a flag (`copilotAgentMode`) + a governance/grounding eval for the agentic path. | med |

## Decisions made

- **Phase C, built incrementally** — the AgentRuntimePort stub + the write-envelope/Approvals machinery already exist; C reuses them, doesn't rebuild.
- **gbrain `serve --http` as the SDK's MCP tool source** — read tools for free (the #2 transport doubles as the agent's tool endpoint).
- **C1 is mechanism-only, honestly labelled** — enforcement is C4; don't record ING-7 "closed" yet.

## Open follow-ups

- **C2–C6** (the roadmap above). C2 next; do it carefully (real-I/O + safety invariants).
- **General read_only-smuggle gap** (flagged by the C1 review): the broker/runAgentJob unary admit seam `(job)=>decision` can't carry a per-tool predicate, so a read_only policy listing a mutating tool is admitted on THOSE paths too. Needs a catalog for those tools + a seam widening — tracked, separate from the Copilot path.
- **`gbrain.contained_synthesis`** — cross-check its non-mutating assertion against the serve policy's `GbrainReadGrant.allowedOps` when C4 wires the tool.

## TDD compliance

Clean. C1 RED→GREEN (14 deterministic tests: classifier, policies, purity check, ING-7 admission payoff, freeze). No violations. The survey is read-only analysis (no code).

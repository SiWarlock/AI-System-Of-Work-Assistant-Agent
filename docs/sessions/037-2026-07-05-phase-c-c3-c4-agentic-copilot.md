# Session 037 — Phase C (tool-enabled Copilot / full agent): C3 + C4 + C5.1 + C5.2a

- **Date:** 2026-07-05 · **Mode:** single-operator (build, ultracode) · **Track:** worker (`apps/worker`)
- **Predecessor:** `036-2026-07-05-RESUME-phase-c-c3-agent-runtime-synthesis.md` (the RESUME handoff this session executed)
- **Successor:** _(next session — C5.2b: route the propose action → §9.8 Approvals)_
- **HEAD at close:** `2d3988b` (C5.2a) atop `7c1e9ff` (C5.1) atop `dac4f95` (C4) atop `a5e62dd` (C3) atop the pre-session `cf160d1`.
- **Gate at close:** repo-wide `turbo typecheck test` **31/31**; worker **596** (+ 55-test C3/C4/C5.1 module + 13-test C5.2a module); pushed at close-out.
- **Owner decision this session:** for C5 (write-via-Approvals), the owner picked **"the model calls a propose tool"** (Option B — most agentic). That makes content-derived trust a hard prerequisite → **C5.1** built it.

## Why this session existed

The owner chose **Option C — the full agent** for P4 "full tools." Phase C is a 6-slice phase; C1 + C2 landed earlier (survey + tool catalog + the concrete `ClaudeAgentTransport`). This session executed the RESUME handoff (036) to build **C3** (the agent-runtime Copilot synthesis) and continued into **C4** (the ING-7 admission wiring that activates C1).

## What was built

### C3 (`a5e62dd`) — `createAgentRuntimeCopilotSynthesis` (agentic Copilot synthesis)

**File created:** `apps/worker/src/api/procedures/copilotAgentSynthesis.ts` — a SECOND `CopilotSynthesisPort` (sibling of the tool-less `createClaudeCopilotSynthesis`) that drives the AgentRuntimePort (`createClaudeAgentSdkRuntime` + the C2 transport) with the Copilot's READ tools sourced from the gbrain `serve --http` MCP endpoint (from #2). Exports: the ToolId→SDK-MCP-name map (`copilotToolToMcpName`/`copilotReadToolMcpNames`/`copilotGbrainReadToolMcpNames`), `buildGbrainMcpServers`/`gbrainMcpEndpoint`, `toClaudeAgentRuntimeRoute` (BIND the veto-cleared route; provider→runtime discriminant only; non-Claude fails closed), `buildCopilotAgentJob` (read_only, ING-7-pure, `maxCostUsd` cap), `foldRuntimeError` (redaction-safe), `mapAgentResultToCandidate` (reuses `mapCompletionToCandidate` — identical grounding reconciliation), `createAgentRuntimeCopilotSynthesis` (over a `CopilotAgentRunner` seam), `createClaudeAgentCopilotRunner` (token → mcpServers → transport → runtime; real SDK/token = eval boundary).

**Files modified:** `copilotClaudeSynthesis.ts` (`buildCopilotDeps` gains an `agentSynthesis?` factory — swaps in the agent synthesis on the real path, lazily; avoids a circular import) · `boot.ts` (`BootConfig.copilotAgentMode` OFF by default + the `agentSynthesisFactory` + a shared DCR token provider).

**Reviews (2, parallel):** both independently flagged the **same critical/high WS-8 finding** — the agent's gbrain tool was a *second, unscoped* cross-workspace read path (unlike the retrieval seam's `servedWorkspaceId` guard); with `copilotAgentMode` on, a non-served-workspace ask could query the single combined brain and surface another workspace's raw content. **Fixed in-slice:** the runner is bound to `servedWorkspaceId` — only that workspace's ask gets the gbrain tool; every other runs **tool-less** (deny-all), exactly mirroring `createGbrainSubprocessRetrieval`. Also fixed: server-side `maxCostUsd` cap, one shared DCR token provider across the http-exec + agent factories, gbrain-only allow-list (vault.read excluded), redaction-safe error fold, `auth_unavailable` on token failure.

### C4 (`dac4f95`) — ING-7 admission wiring (activates C1)

**File modified:** `copilotAgentSynthesis.ts` — new `admitCopilotAgentJob(job)` composes the C1 catalog into the ING-7 gate that shipped **inert**: `isToolPolicyConsistent` (read_only ⇒ !allowsMutating, DiD on the public surface) + `admitJob(job, isMutatingCopilotTool)` (untrusted + mutating tool → HARD REJECT) + `copilotReadOnlyPolicyIsPure` (catches a read_only policy that secretly lists a mutating tool — the ING-7 tool-stripping smuggle vector `admitsMutating`'s read_only early-return is structurally blind to). Gated into `synthesize` **before** the runner.

**Reviews (2, parallel):** ING-7 correctly enforced, fail-closed, redaction-safe, **no crit/high**. Security confirmed the purity check is the **only catalog-aware ING-7 layer** (the runtime-layer check is catalog-blind) → a real, LIVE activation of C1, discharging the C1 review's "mechanism, unwired" HIGH. Both flagged the same test-gap (the untrusted-smuggle case passed for the wrong reason) — **fixed:** added the load-bearing untrusted+impure-read_only case, the unknown-tool fail-safe case, the inconsistent-policy case, and the admit-path identity assertion.

### C5.1 (`7c1e9ff`) — content-derived trust + capability (the propose prerequisite)

The owner picked Option B ("the model calls a propose tool") for C5, which makes the C4 carry-forward a hard prerequisite: a `scoped_write` propose tool may only be granted on affirmed-trusted content.

**File modified:** `copilotAgentSynthesis.ts` — new `resolveCopilotAgentCapability({contentTrust, proposeEnabled})` (fail-closed: `propose` ONLY when trusted AND enabled, else `read_only`). `buildCopilotAgentJob` now derives capability **through the resolver** (the only funnel — a caller can't hand-pick `propose` or build an inconsistent trust/policy pair): a `read_only` job is content-derived `trustLevel:"untrusted"` (ING-7-safe), a `propose` job is `trusted` + `copilotAgentToolPolicy` (scoped_write + the `copilot.propose_action` tool). **Trust is now CONTENT-derived, not question-derived** — the correction the C4 review demanded.

**Reviews (2, parallel):** no crit/high; the **untrusted-content-can-never-propose invariant holds** (fail-closed resolver + the C4 admit backstop + the invocation-time ING-7 check, which now runs on the untrusted read_only job and passes — strictly safer than the old `trusted` label). Confirmed the propose capability is **inert** this slice (resolver has no production caller; runner allow-list is gbrain-reads-only, so `copilot.propose_action` is not callable). **Folded in-slice:** security#1 (make the resolver the sole funnel — a bypass caller could otherwise build a trusted propose job directly) + the code-quality docstring/header accuracy + the `capability` param-shadow.

### C5.2a (`2d3988b`) — the propose-action derivation (server-derived keys, never model-supplied)

**File created:** `apps/worker/src/api/procedures/copilotPropose.ts` — `deriveCopilotProposedAction(intent: unknown)`, the "write-via-Approvals" security heart. The model supplies only a `CopilotProposeIntent` (targetSystem + operation + object `identity` + `payload` — **no keys**); the server DERIVES the canonical `ProposedAction`: `canonicalObjectKey`/`idempotencyKey` via `@sow/domain`'s frozen SHA-256 builders, `actionId` = the derived idempotencyKey, `approvalPolicy` forced `requires_approval`, re-validated through `ProposedActionSchema`. A mis-targeted write is **impossible by construction** (no model value becomes a key verbatim; the key binds to `identity`).

**Review (security, focused):** the derived-never-client-supplied invariant **holds by construction** (no crit). **Fixed the one HIGH** (fail-closed on the UNTRUSTED intent): the module claimed never-throws but consumed `.trim()`/`Object.keys` before any gate — a numeric identity value (the natural update case) threw in `normalizeIdentity`. Now a **hand-written strict guard** `parseCopilotProposeIntent` (the worker has no zod dep, per `copilotClaudeSynthesis`) folds a malformed/non-string/extra-key intent to a typed `COPILOT_PROPOSE_MALFORMED`. Added a payload size cap. _(Code-quality subagent skipped for this micro-slice — cost tuning; self-reviewed.)_

## Decisions made

- **Agent path swapped at `buildCopilotDeps` behind `copilotAgentMode` (OFF by default), via an `agentSynthesis` factory** (not by importing the agent module into `copilotClaudeSynthesis.ts`) — breaks the circular import; the real runtime is built only when the flag is on.
- **WS-8 by construction (parity with the retrieval seam):** the agent's gbrain tool is bound to `servedWorkspaceId`; non-served workspaces run tool-less. Chosen over failing closed (keeps reachability, matches the retrieval fallback).
- **C4 gate location = `synthesize`, before the runner** (before any SDK call / egress). The C3 job is always trusted+read_only today, so the gate passes for the live path — but the purity + consistency checks are live-active on every call, and the untrusted-rejection branch is ready for future variants.

## Decisions explicitly NOT made (deferred)

- **C5's content-derived trust model.** `buildCopilotAgentJob` hardcodes `trustLevel:"trusted"` ("the question is trusted") while the agent reads untrusted brain content via tools. Safe today (no mutating tool). **The security review's MEDIUM (load-bearing for C5): trust must become CONTENT-derived before C5 grants the propose (scoped_write) tool** — else an untrusted-brain-content proposal would be admitted (`admitJob` skips the mutating check for a trusted job). See Open follow-ups.
- **The real SDK `query()` path** — eval-gated (not unit-tested), like the sibling completion client.

## TDD compliance

Clean. C3 + C4 both RED→GREEN (46 deterministic tests: route/tool-name/prompt/job/error-fold/output mappings, the synthesis over a fake runner, the runner wiring over an injected token+queryFn, the WS-8 tool-less-for-non-served case, and the full ING-7 admission matrix). The real SDK call is the eval boundary. No violations.

## Reachability

`answerCopilotQuestion` (copilot.ts) → `deps.synthesis.synthesize` → (when boot sets `copilotAgentMode`) `createAgentRuntimeCopilotSynthesis` → `admitCopilotAgentJob` (C4 gate) → `runner.run` → `createClaudeAgentSdkRuntime(createClaudeAgentSdkTransport(...))` → `runJob` → SDK `query()` with the gbrain MCP tools (served workspace only). **Wired end-to-end; dormant by default** (worker-host does not set `copilotAgentMode`; needs a running `gbrain serve --http`). This is a flag-gated feature, not a silent gap — same posture as `copilotRealModel` before P2.4b.

## Open follow-ups

- **[Finding — WS-8 residual, shared + pre-existing]** the served gbrain brain is a single COMBINED store; a query against it is not yet filtered to the served workspace's own content. This is the SAME gap the retrieval seam has (`gbrain call query` / the http exec pass no workspace filter) — safe today (the seed holds only the served workspace's content) but needs per-workspace query filtering or a partitioned brain before the store grows to hold multiple workspaces. **Not C3-specific; escalate for both paths.**
- **[C5 guard-rail — trust model DONE in C5.1 (`7c1e9ff`)]** `job.trustLevel` is now CONTENT-derived (read_only ⇒ untrusted; propose ⇒ trusted, resolver-gated). **REMAINING precondition for C5.2/C5.3 (security#2, LOAD-BEARING):** `contentTrust:"trusted"` is sound ONLY if the ENTIRE tool-reachable content surface is trusted-provenance (a propose job keeps the gbrain READ tools, so it can fetch more brain content mid-run beyond the seed). Derive `contentTrust` PER-CONTENT over that whole surface (if ANY reachable passage is non-KnowledgeWriter/untrusted-provenance → `untrusted`) — NOT per-workspace (an owner's brain holds ingested untrusted notes) — and eval it BEFORE the propose tool is wired callable.
- **[deferred hardening, documented in-code]** token-TTL staleness of the held MCP bearer header (liveness, not a leak — an expired token 401s fail-closed); `route.endpoint` not consumed by the SDK (processor-identity is the operative binding); the static idempotency key (inert — Broker bypassed today).
- **C5.2a DONE (`2d3988b`)** — `deriveCopilotProposedAction` (server-derived keys). **Remaining C5:**
  - **[C5.2b carry-forward — security MEDIUM #1]** the human gate must be **STRUCTURAL**: route EVERY Copilot proposal to §9.8 Approvals **unconditionally** (via the LIVE-wired `RecordPendingPort`/`createRecordPendingActivity`) — never branch auto/human on the decorative `approvalPolicy` string.
  - **[C5.2b/C5.3 carry-forward — security MEDIUM #2]** the `idempotencyKey` excludes `payload`, so a 2nd different-content **UPDATE** to the same object+operation silently dedupes — the intent must carry a content/revision token in `identity` for updates (or the caller supersedes, not drops).
  - **C5.2b** route → Approvals · **C5.2c** the in-process SDK MCP server (`copilot.propose_action`, eval-gated) · **C5.3** wire the propose tool + compute `contentTrust` per the C5.1 precondition · **C6** skills + flag + governance/grounding eval. Design ref: the 7.17 `copilotQa` `BuildProposalPort`/`QaRouteToApprovalPort` ports.

# Handoff 001 — resume the WS-8 scoping build (SC5b → SC6–SC9)

- **Date:** 2026-07-06 · **From session:** `docs/sessions/042-2026-07-06-ws8-scoping-design-sc1-gates-bcd.md`
- **HEAD:** `2c330b5` (SC5b + SC7a/SC7b landed on main; push at close-out). **Gate:** repo-wide `turbo typecheck test` 31/31.
- **Design of record:** `docs/planning/ws8-workspace-scoping.md` (the full survey→design→4-verifier output + BUILD-ORDER VERDICT + OWNER-GATED). **Memory:** `sow-copilot-skill-catalog`, `sow-copilot-real-model-direction`.

## What is DONE (this session, all pushed + dual-reviewer-clean)

**§13.10 go-live gates:** (b) verified live vs gbrain v0.35.1 (per-op read/write/admin scope; the frozen `GbrainReadGrant.allowedOps` enum is a SoW-side Path-1 gate the agentic Path-2 bypasses ⇒ growing it is NOT required). (c) a 5-point read-path eval contract in `docs/runbooks/copilot-propose-go-live.md` §13.10 gate (c) for the eval-security track. (d) de-phantomed the catalog (`245e4fd`).

**WS-8 gate (a):**
- **P1 unit LIVE + INERT** — SC1 core (`a0870bb`, `packages/policy/src/copilot-workspace-scope.ts`) · SC2 filter (`369a3b1`, `apps/worker/.../copilotGbrainSubprocess.ts`) · SC3 boot (`8092d80`) · **flipped live** (`12ea650`, worker-host `copilotWorkspaceScoping:true` + `{assign,personal-business}`). On today's single-workspace brain every hit is kept — no change to Copilot output; enforcement live for future prefixed/multi-workspace content.
- **P2 layer built + DORMANT** (behind `copilotAgentMode` OFF) — SC4 catalog narrowing (`2795a7d`, `copilotScopedReadToolIds`) · SC5a arg policer (`ef369f6`, `packages/policy/src/copilot-arg-policy.ts`) · **SC5b result redactor DONE (`fffd78d`, `packages/policy/src/copilot-result-redaction.ts`)** — `redactGbrainToolResult` folds A2/A3/A4 + fail-closed drop-all; dual-reviewer clean, F1 (non-array `links` fail-OPEN → neutralized to `[]`) + F3 (unscopable op DROPS-ALL on a non-partitioned brain via `copilotToolScopingClass`, mirrors SC5a M2) fixed in-slice; 22 tests; repo-wide 31/31. **⚠ F2 CARRY-FORWARD → gate-(c) eval:** per-op FIELD allow-listing of kept hits/nodes (nested foreign refs under non-`links` keys) needs gbrain's pinned per-op result schema; documented in-code, not reachable today.

## RESUME HERE → SC8 (runner wiring — bind the proxy to the served workspace)

SC5a+SC5b (pure guards) and SC7a+SC7b (the proxy that composes them) are DONE. **SC6 was DECIDED-OUT** (SDK finding: `canUseTool` supports `updatedInput` but PostToolUse result-replacement is UNCONFIRMED — so the in-process proxy, SC7, is the primary path with no SDK-hook dependency; SC6's canUseTool arg-policing is deferred defense-in-depth, redundant with the proxy). Remaining: **SC8** (wire) → **SC9** (admission backstop) → then `copilotAgentMode` can flip.

**SC7 DONE:** SC7a `d8fc89d` (`apps/worker/.../copilotGbrainProxy.ts` — `handleCopilotGbrainToolCall`, SC5a→exec→SC5b, structural never-throws) · SC7b `2c330b5` (`packages/providers/.../copilot-gbrain-proxy-mcp.ts` — `createCopilotGbrainProxyMcpServer`, one tool per scoped op under server `gbrain`, thin/unparsed-forwarding). Dual-reviewer clean; 22 tests.

**SC8 spec (3 sub-slices — verified against the runner `copilotAgentSynthesis.ts` + the http transport `copilotGbrainHttp.ts`):**

⚠ **KEY FINDING (why SC8 is not a small adapter):** `createGbrainHttpExec` (copilotGbrainHttp.ts) is **query-ONLY** (`buildMcpQueryRequest` hardcodes `name:"query"`) and returns **pre-parsed hits** (`parseMcpToolCallResult` does `JSON.parse(result.content[0].text)`). SC7's `CopilotGbrainToolExec` needs a **generic op** call that returns the **RAW MCP result envelope** `{content:[{type:"text",text:"<JSON>"}]}` — because SC5b's redactor parses that envelope itself. So SC8 needs a NEW generic exec, not the existing one.

- **SC8a — the generic http MCP-call exec** (NEW in copilotGbrainHttp.ts, TDD vs a fake fetch/token): `createGbrainMcpToolCallExec(deps) => CopilotGbrainToolExec = (mcpToolName, args) => Promise<Result<raw MCP envelope, FailureVariant>>`. Op = `mcpToolName.slice("mcp__gbrain__".length)` (the proxy op names ARE the gbrain MCP tool names — that's why COPILOT_GBRAIN_PROXY_OPS uses `"query"` not `"search"`). Build a generic `tools/call` `{name: op, arguments: args}`; REUSE the exported pure primitives `isLoopbackUrl` + `parseMcpSseBody` + the token/401-refresh-retry/status loop; RETURN the raw JSON-RPC `result` object (the envelope) — do NOT call `parseMcpToolCallResult` (it strips to hits). Fail-closed (loopback guard, JSON-RPC error, missing result) → a stable code; never throws. (The token+401 loop duplicates ~25 lines of `createGbrainHttpExec`; either share a small `postMcp` helper or accept the dup + a DRY follow-up — don't destabilize the tested query exec.)
- **SC8b — runner wiring** (`createClaudeAgentCopilotRunner`, copilotAgentSynthesis.ts): add OPTIONAL deps mirroring the propose wiring — `gbrainProxyScope?: CopilotWorkspaceScope` + `buildGbrainProxyMcpServer?: (handler) => McpServerConfig` (boot injects `createCopilotGbrainProxyMcpServer`) + the exec (or an exec factory bound to the minted token/url). In the `served && !proposeGranted` branch, when the proxy deps are present: build `handler = (name,args)=>handleCopilotGbrainToolCall(name,args,{scope, exec})`, register `buildGbrainProxyMcpServer(handler)` into `mcpServers` under key **`"gbrain"`** (REPLACING `buildGbrainMcpServers` — do NOT also add the raw http entry), and push `COPILOT_GBRAIN_PROXY_MCP_NAMES` into `toolNames` (instead of `copilotGbrainReadToolMcpNames()`). Absent proxy deps ⇒ today's raw-http path (back-compat). ⚠ **MAP-KEY CONTRACT (security L2): the wiring test MUST assert the raw http `gbrain` server is ABSENT when the proxy is wired** — a different key leaving it present ⇒ model sees BOTH scoped `mcp__gbrain-proxy__*` + UNSCOPED `mcp__gbrain__*` (full WS-8 bypass).
- **SC8c — boot wiring** (apps/worker/src/boot.ts / composition): behind the existing `copilotWorkspaceScoping` flag (already flipped ON for P1) + `copilotAgentMode`, build the `CopilotWorkspaceScope` (reuse `buildInterimCopilotScopeRegistry` + the served-id + the LegacyContentPolicy already wired for P1) and the SC8a exec (over `createGbrainDcrTokenProvider` + the loopback base URL), and pass them + `createCopilotGbrainProxyMcpServer` into `createClaudeAgentCopilotRunner`. Preserve seed-only propose (a propose job still strips gbrain read tools).

All dormant behind `copilotAgentMode` (OFF). Then **SC9** admission backstop → flip.

### (superseded) SC5b spec — DONE, kept for reference

**Goal:** `redactGbrainToolResult(mcpToolName, result, scope) => updatedOutput` — a pure fn (NEW `packages/policy/src/copilot-result-redaction.ts`) that scopes a gbrain tool's RESULT to the served workspace, folding the three RESULT-LEAKAGE verifier findings. Reuses SC1's `decideHitScope` + `CopilotWorkspaceScope`. TDD; dual-review; commit.

**gbrain MCP result shape** (verified live): `{content:[{type:"text", text:"<JSON string>"}]}`. The redactor parses `text`, filters, re-serializes into the same envelope. **Malformed / unparseable ⇒ drop-all (fail-closed): return an empty-hits envelope, never the raw result.**

**Per-tool result JSON (from the live probe — map by op):**
- `query` / `get_recent_salience`: a JSON array of hits `[{slug, chunk_text, title, source_id, score, …}]` → drop each hit whose `decideHitScope({slug, sourceId:source_id})` ≠ keep.
- `traverse_graph`: array of nodes `[{slug, title, type, depth, links:[…]}]` → **A2: drop foreign NODES by slug AND filter each kept node's `links[]`/edges — drop an edge whose target slug is foreign, and strip link `context` strings** (nodes-only is a leak).
- `find_contradictions`: `{contradictions:[{a, b, severity, axis, confidence, resolution_command, …}]}` → **A3: drop a pair if EITHER side's slug is foreign OR unattributable (FAIL-CLOSED far-side — a side with only a page_id/title and no resolvable in-workspace slug ⇒ treat as foreign ⇒ drop the pair)** + **A4: strip `resolution_command` and every page/path/title-naming field, keep only severity/axis/confidence + opaque in-workspace refs**.
- `get_timeline`: per-page (the seed slug was already validated by SC5a's arg policer) → entries are for the in-workspace seed page; minimal filtering, but still fail-closed on a malformed shape.

**Seams to reuse:** `decideHitScope` / `attributeSlug` / `CopilotWorkspaceScope` (`copilot-workspace-scope.ts`); the SC5a op-extraction pattern `gbrainReadToolOf` (mirror it — `mcp__gbrain__<op>`, `query`→`gbrain.search`). Keep the redactor pure + never-throw; stable redaction-safe cause codes only.

## Then SC6 → SC9 (all dormant behind `copilotAgentMode`)

- **SC6** transport seams — extend `ClaudeAgentSdkTransportDeps`/`buildCanUseTool` (`packages/providers/.../claude-agent-sdk-transport.ts`) with an OPTIONAL argPolicer (compose SC5a into `canUseTool`: name-allow-list FIRST, then policer allow+updatedInput/deny; drop arg-policed names from the SDK `allowedTools` auto-approve so canUseTool must fire) + an OPTIONAL PostToolUse hook (SC5b redactor over the result). Never return null (a null hangs the run). **⚠ verify SDK 0.3.201: does `canUseTool` return `updatedInput`, and does PostToolUse `updatedMCPToolOutput` REPLACE a result?** — the SC7 in-process proxy avoids this dependency.
- **SC7** the in-process gbrain-proxy MCP server (PRIMARY delivery) — mirror `createCopilotProposeMcpServer` (`packages/providers/.../copilot-propose-mcp.ts`): one `tool()` per exposed op, identity names, registered under key `gbrain` REPLACING the http entry; handlers call the worker exec + shared DCR token provider and enforce SC5a+SC5b server-side per call.
- **SC8** runner wiring (`apps/worker/.../copilotAgentSynthesis.ts`) — drive `allowedToolNames` from `copilotScopedReadToolIds(brainPartitioned=false)`; wire the proxy (SC7) OR the argPolicer+redactor (SC6) bound to the served workspace; preserve seed-only propose (gbrain tools stripped).
- **SC9** admission backstop — extend `admitCopilotAgentJob` to reject a job whose allow-list holds an unscopable tool for the partition state / whose scope is unresolved.

After SC5b–SC9 land + the SC6 SDK-conformance check, `copilotAgentMode` can flip (a security-review-gated deliberate flip).

## Carry-forwards / deferred (NOT blockers)

- SC5a deferred lows: verify gbrain seeds traverse_graph/get_timeline ONLY on `slug` before flipping `copilotAgentMode`; `vault.read` path-scoping is SC6's job (denied by the gbrain-only arg policer today).
- The **A1 residual** (body-embedded foreign content) — owner-facing, ingest-time fix only (KnowledgeWriter classification + per-workspace source partitioning); accepted for the runtime layer.
- The **ingest-exit** (de-stub KW→gbrain reindex + re-seed from KnowledgeWriter + per-workspace `sources_add`) — the durable WS-8 enabler + the assign-bridge exit; a larger separate thread (knowledge-track + owner-run migration).
- Untouched from 041: 13.10a (Copilot→KMP propose path), the real serving oracle (C5.4b go-live), the ~8 Phase-9/10 owner-calls + a Phase-10 `/phase-exit`, Tiers 2–5 + 13.10c Gmail.

## Method reminders (standing)

survey→design→adversarial-verify Workflow for cross-cutting/design-uncertain slices; TDD deterministic/security slices; commit per slice (explicit `git add`, never `-A`; Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`); security-reviewer + code-quality-reviewer per security-touching slice; repo-wide `pnpm -w turbo run typecheck test` after any port/contract change; reconcile the plan at each slice boundary; don't touch the parallel worktree `../SoW-build-evalsec`; push at close-out.

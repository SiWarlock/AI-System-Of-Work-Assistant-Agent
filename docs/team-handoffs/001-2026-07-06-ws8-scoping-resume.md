# Handoff 001 — resume the WS-8 scoping build (SC5b → SC6–SC9)

- **Date:** 2026-07-06 · **From session:** `docs/sessions/042-2026-07-06-ws8-scoping-design-sc1-gates-bcd.md`
- **HEAD:** `12ea650` (origin/main, clean tree). **Gate:** repo-wide `turbo typecheck test` 31/31.
- **Design of record:** `docs/planning/ws8-workspace-scoping.md` (the full survey→design→4-verifier output + BUILD-ORDER VERDICT + OWNER-GATED). **Memory:** `sow-copilot-skill-catalog`, `sow-copilot-real-model-direction`.

## What is DONE (this session, all pushed + dual-reviewer-clean)

**§13.10 go-live gates:** (b) verified live vs gbrain v0.35.1 (per-op read/write/admin scope; the frozen `GbrainReadGrant.allowedOps` enum is a SoW-side Path-1 gate the agentic Path-2 bypasses ⇒ growing it is NOT required). (c) a 5-point read-path eval contract in `docs/runbooks/copilot-propose-go-live.md` §13.10 gate (c) for the eval-security track. (d) de-phantomed the catalog (`245e4fd`).

**WS-8 gate (a):**
- **P1 unit LIVE + INERT** — SC1 core (`a0870bb`, `packages/policy/src/copilot-workspace-scope.ts`) · SC2 filter (`369a3b1`, `apps/worker/.../copilotGbrainSubprocess.ts`) · SC3 boot (`8092d80`) · **flipped live** (`12ea650`, worker-host `copilotWorkspaceScoping:true` + `{assign,personal-business}`). On today's single-workspace brain every hit is kept — no change to Copilot output; enforcement live for future prefixed/multi-workspace content.
- **P2 layer built + DORMANT** (behind `copilotAgentMode` OFF) — SC4 catalog narrowing (`2795a7d`, `copilotScopedReadToolIds`) · SC5a arg policer (`ef369f6`, `packages/policy/src/copilot-arg-policy.ts`).

## RESUME HERE → SC5b (the result redactor — biggest, most security-critical)

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

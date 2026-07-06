# Session 042 — §13.10 go-live gates (b/c/d) + WS-8 gate (a): design + SC1–SC5a + P1 flipped LIVE

- **Date:** 2026-07-06 · **Mode:** single-operator (build + docs, ultracode → opus) · **Tracks:** policy · worker · desktop · docs
- **Predecessor:** `041-2026-07-06-skill-catalog-canonical-docs-audit.md`
- **Successor:** `docs/team-handoffs/001-2026-07-06-ws8-scoping-resume.md` (SC5b + SC6–SC9)
- **HEAD at close:** `12ea650` (pushed to origin/main). Session arc: `cf2e973` → `12ea650` (13 commits).
- **Gate at close:** repo-wide `turbo typecheck test` **31/31** green; every code slice dual-reviewer-clean.

## Why this session existed

Continued the owner's §13.10 go-live work. NEXT-item 2 (the four `copilotAgentMode` go-live gates before flipping the agentic read path) — three are self-contained and clear the way for the hard one (gate a, WS-8). Landed gates (b)/(c)/(d) + the full gate-(a) design + its foundation slice.

## What was built / done (commits)

- **`245e4fd` — gate (d): de-phantom the Copilot read-tool catalog.** Empirically probed live gbrain **v0.35.1** (`serve --http --enable-dcr`, DCR→token→`tools/list`+`tools/call`). Renamed `gbrain.graph`→`traverse_graph`, `gbrain.timeline`→`get_timeline` (real read tools); pruned `schema_read`/`contained_synthesis` (no live tool) + `health` (real op `get_health` requires ADMIN scope, unreachable to the read-pinned DCR client). Established **servable-under-read-scope** as a catalog precondition; fail-safe preserved. Dual-reviewer clean (0 crit/high/med; 1 quality MEDIUM folded — narrowed the `search`→`query` exception comment; swapped an arbitrary phantom test fixture).
- **`eca4760` — docs: reconcile plan/runbook/catalog for gates (b)/(c)/(d).** NEW §13.10 section in `docs/runbooks/copilot-propose-go-live.md` (the authority for all four gates in ladder order); plan §13.10 gate line + §13.11 cross-doc note; `docs/planning/copilot-skill-catalog.md` de-phantomed.
- **`a0870bb` — gate (a) SC1: the WS-8 workspace-scope core** (`packages/policy/src/copilot-workspace-scope.ts`). `attributeSlug` (segment-wise longest-prefix, boundary-correct + traversal-fail-closed), `attributeHit` (source_id-first/slug), `decideHitScope` (keep/drop under served workspace + `LegacyContentPolicy`), `WorkspaceScopeRegistry` (split-ready descriptor). 27 tests. Dual-reviewer clean (security 0 crit/high/med — fail-closed on every attacked axis; quality 2 mediums folded — tie-reset + multi-prefix + empty-prefix regression tests). Design durable in `docs/planning/ws8-workspace-scoping.md`.
- **`369a3b1` — gate (a) SC2: the P1 WS-8 scope filter** (`apps/worker/src/api/procedures/copilotGbrainSubprocess.ts`). `createWorkspaceScopeFilter` + optional `scopeFilter?` on `createGbrainSubprocessRetrieval`, applied over the RAW hits BEFORE `normalizeGbrainHits` (both the subprocess AND http transports flow through this ONE composite). Fail-closed `readRawScopeHit`; non-array passthrough. Dual-reviewer clean (security PASS on all 6 WS-8 attack axes, 0 crit/high/med; quality typeof-guard hardening folded). 662 worker tests green.
- **`8092d80` — gate (a) SC3: the P1 boot wiring** (`copilotClaudeSynthesis.ts` + `boot.ts`). `buildInterimCopilotScopeRegistry` + `gbrainWorkspaceScope?` on `buildCopilotDeps` (filter bound to the SAME served-id const) + `BootConfig.copilotWorkspaceScoping` (default OFF) + `copilotLegacyContentPolicy` (default fail-closed `{deny}`). **The P1 unit (SC1+SC2+SC3) is COMPLETE + default-OFF.** ⚠ Review surfaced: enabling the flag requires `{assign,personal-business}` (the default `{deny}` would zero retrieval on today's unprefixed brain) — NOT flipped live (inert-today, footgun; deliberate owner enablement). Dual-reviewer clean (security 0 crit/high/med; quality 2 mediums folded — comment corrected + `{deny}` end-to-end test).
- **`2795a7d` — gate (a) SC4: the P2 catalog narrowing** (`packages/policy/src/copilot-tool-catalog.ts`). `COPILOT_TOOL_SCOPING` (frozen) + `copilotScopedReadToolIds(brainPartitioned)` denies the unscopable whole-brain tools (find_experts/anomalies/orphans, takes_*, **and code_*** — conservative: code-intel over a combined brain leaks cross-workspace structure) on a non-partitioned brain. Dormant behind `copilotAgentMode`. Dual-reviewer clean (security PASS, over-denial-biased; quality totality/frozen hardening folded). 270 policy tests.
- **`ef369f6` — gate (a) SC5a: the P2 arg policer** (`packages/policy/src/copilot-arg-policy.ts`). `policeGbrainToolArgs` — the independent WS-8 arg guard: deny unknown/mutating/malformed; deny scope-widening (type/case-robust + neutralizes); deny foreign traverse_graph/get_timeline seed; force get_recent_salience.slugPrefix + pin query/code_* source_id; **independently deny unscopable tools on a non-partitioned brain** (M2, no SPOF). Added `CopilotWorkspaceScope`/`descriptorFor`/`singleSlugPrefixOf` to the SC1 module. Dual-reviewer clean (M1 widening-robustness + M2 folded). 288 policy tests. Dormant behind `copilotAgentMode`.

## Build-order decision (owner-delegated) — RUNTIME-FIRST

The owner delegated the ingest-first-vs-runtime-first call to me ("do what's most architecturally correct… if 2 is correct before 1 then do 2 then 1, otherwise do 1") + picked `{assign, personal-business}`. A focused survey of the concrete ingest→gbrain→retrieval path settled it: **ingest-attribution is INERT today** — the KnowledgeWriter→gbrain reindex is a stub (`createStubIndexApplyClient`), the KW commit path runs only under degraded/unregistered Temporal workflows, and the Copilot reads a **separately hand-seeded, unprefixed brain** (session-032 `gbrain import docs/`, bypassing KnowledgeWriter) that ingest attribution cannot retroactively re-slug. Per-workspace `source_id` is an owner-run gbrain migration; no authoritative registry populates slug-prefixes. **Verdict: runtime-first (SC2–SC9); ingest-attribution is the documented EXIT from the assign-bridge** (needs de-stubbing KW→gbrain + a re-seed). Full survey verdict in `docs/planning/ws8-workspace-scoping.md` "BUILD-ORDER VERDICT".

## Gate (b) — the empirical serve --http finding (verified, no code)

`serve --http` advertises **63 tools** to any DCR client (writes included) but **enforces per-op scope at INVOCATION** in three classes **read/write/admin**: a write op under a read token → `insufficient_scope`; `get_health`/`get_stats` require **admin**. Scope is **client-asserted at DCR REGISTRATION** (the `/token` scope param is ignored in v0.35.1); SoW's `createGbrainDcrTokenProvider` already pins `scope=read`. **Conclusion:** the frozen `GbrainReadGrant.allowedOps` enum is a SoW-side Path-1 gate gbrain never sees; the agentic Path-2 allow-list bypasses it → **growing that frozen enum is NOT a required go-live change** (previously framed as one; corrected in the plan).

## Gate (a) — the WS-8 design (durable in docs/planning/ws8-workspace-scoping.md)

Workflow `wf_039163e8-07d` (survey→3-designs→judge→4 adversarial verifiers). One verifier (RESULT-LEAKAGE) failed on a session-limit and was **re-run standalone** — the right call, because it delivered the load-bearing finding. Chosen: Design-3 (data-partitioning) spine + Design-2 arg-policer/result-redactor (defense-in-depth) + Design-1 in-process gbrain-proxy MCP (P2 delivery). One shared pure `decideHitScope` core (SC1) reused at P1 (live retrieval raw-hit filter) + P2 (dormant agentic enforcement); default-OFF, fail-closed; descriptor split-ready.

**The A1 finding (load-bearing, owner-facing):** `decideHitScope` attributes the **container** (slug/source), not the **contents** — a page whose slug attributes in-workspace but whose body verbatim quotes another workspace's content is KEPT. **No runtime post-filter can fix this**; full WS-8 ("0 raw foreign content") needs ingest-time attribution (KnowledgeWriter classification) + per-workspace source partitioning. A2/A3/A4 (traverse_graph edge/target filtering; find_contradictions fail-closed far-side; strip `resolution_command` server-side because the UI-safe gate is shape-only) were folded into the SC5 requirements.

## Decisions made

- Gate order: cleared the three self-contained gates (b/c/d) first, then designed + founded the hard one (a).
- SC1 is the owner-decision-free foundation; SC2+ machinery is owner-gated at SC3.
- Stopped building at SC1 rather than building SC2–SC9 dormant machinery toward an unresolved owner posture.

## Decisions explicitly NOT made (owner-gated — surfaced at close)

1. **The A1 residual:** accept runtime slug-scoping as WS-8-partial (body-embedded foreign content leaks until ingest-time attribution exists) vs treat A1 as a hard blocker requiring the ingest rule + source partitioning BEFORE flipping `copilotAgentMode`.
2. **Legacy content policy at flag-flip:** `{deny}` (airtight, kills the live personal-business path until migration) vs `{assign,personal-business}` (preserves the live path, carries the fail-OPEN leak surface if multi-workspace content ever lands unprefixed).
3. When/which legacy migration (owner-run, writes to gbrain).
4. P2 delivery mechanism (in-process proxy vs SDK-native hooks); aggregator reclassification; retire-vs-align the dormant adapter; the 3-brain split. (Full list in the design doc's OWNER-GATED section.)

## Owner decisions this session

- **Build order = RUNTIME-FIRST** (owner delegated "do what's most architecturally correct"). A survey found ingest-attribution INERT today (stubbed KW→gbrain reindex + a separately hand-seeded unprefixed brain), so it's the assign-bridge EXIT, not a prerequisite.
- **Legacy posture = `{assign, personal-business}`.**
- **Flip P1 scoping LIVE** — owner directed ("you can flip it on"). Done (`12ea650`).

## Reachability / current state

- §13.10 gates: (b) verified, (c) eval-contract noted for eval-security, (d) done.
- **Gate (a) — the P1 unit (SC1 core + SC2 filter + SC3 boot) is LIVE** in worker-host: `copilotWorkspaceScoping: true` + `{assign, personal-business}`. On today's single-workspace brain (99 personal-business pages, all embedded) it is **INERT** — every hit is kept, so the Copilot's answers are unchanged; the enforcement mechanism is now active for future prefixed / multi-workspace content. The tool-less synthesis Copilot path is unaffected.
- **P2 layer (SC4 catalog-narrowing + SC5a arg-policer + SC5b result-redactor) built + DORMANT** behind `copilotAgentMode` (OFF). SC6–SC9 remain.
- All work pushed to origin/main; working tree clean but for the user's graphify config (`.claude/settings.json`, `CLAUDE.md`, `graphify-out/`) — intentionally not staged.

## Continuation — SC5b result redactor (`fffd78d`, dual-reviewer clean)

`redactGbrainToolResult(mcpToolName, result, scope)` (`packages/policy/src/copilot-result-redaction.ts`) — the last-line runtime guard that scopes a gbrain MCP tool RESULT to the served workspace before the (dormant) agentic Copilot forwards it. Pure; never throws; never returns null. Parses the live `{content:[{type:"text",text:"<JSON>"}]}` envelope, reuses SC1's `decideHitScope`, and folds all three RESULT-LEAKAGE findings — **A2** (traverse_graph: drop foreign NODES by slug + filter each kept node's edges [drop foreign-target edge + strip edge `context`]), **A3** (find_contradictions: drop a pair if EITHER side is foreign, FAIL-CLOSED far-side), **A4** (strip `resolution_command`/title, keep only severity/axis/confidence + opaque in-workspace slug refs). search/get_recent_salience = generic per-hit filter; get_timeline = in-workspace-seed passthrough. Malformed/unparseable/unknown-tool/wrong-shape ⇒ DROP-ALL empty envelope. 22 unit tests; repo-wide 31/31.

**Dual review (security + code-quality) — both load-bearing MEDIUMs fixed in-slice:**
- **F1 (fail-OPEN → fixed):** a present-but-non-array `links` field was returned VERBATIM (a malformed `links:{to:"employer-work/x",context:"…"}` blob could leak). Now neutralized to `[]` — the in-workspace node is kept, the malformed blob dropped.
- **F3 (independence → fixed):** an `unscopable` whole-brain op (find_experts/anomalies/orphans, takes_*, code_*) now DROPS-ALL on a non-partitioned brain via `copilotToolScopingClass`, mirroring SC5a's M2 — a genuine independent last-line guard, never leaning on SC4's allow-list or SC5a's arg deny.
- **F2 (carry-forward, NOT in-slice):** a kept in-workspace hit/node is forwarded whole, so a nested foreign slug ref under a key OTHER than the scrubbed `links[].to`/`target` + edge `context` (e.g. `backlinks`/`related` arrays, edge free-text named `snippet`/`excerpt`) would survive. Tightening to a per-op FIELD allow-list needs gbrain's PINNED per-op result schema (over-aggressive whitelisting strips legit in-workspace body) → **deferred to the gate-(c) governance eval** (documented in-code + runbook §13.10 gate (c) point 2). Not reachable today (SC4 allow-list + SC5a arg policer gate the surface; module dormant).

The **pure-guard trio (SC5a args + SC5b results) is now COMPLETE.** SC6–SC9 are the WIRING slices.

## Continuation — SC6-vs-SC7 decision + SC7 the in-process gbrain-proxy (`d8fc89d`, `2c330b5`)

**SC6-vs-SC7 decision (SDK conformance verified via Context7 `@anthropic-ai/claude-agent-sdk`):** `canUseTool` supports `{behavior:"allow", updatedInput}` (arg-rewrite works), but **PostToolUse result-replacement is UNCONFIRMED** — so SC6 (canUseTool + PostToolUse redaction) can't deliver the RESULT-redaction guarantee. **SC7 (the in-process gbrain-proxy MCP server) is therefore the PRIMARY path and was built first**, enforcing BOTH guards server-side with no SDK-hook dependency. **SC6 (canUseTool arg-policing) is deferred** as redundant defense-in-depth (the proxy already arg-polices) whose value hinges on unverified canUseTool-fires-for-allow-listed semantics. This is a build-order refinement grounded in a verified SDK fact — no UX/API/contract-surface change, so not escalated.

**SC7 DONE (dual-reviewer clean; 0 crit/high/med):**
- **SC7a** (`d8fc89d`, `apps/worker/src/api/procedures/copilotGbrainProxy.ts`) — `handleCopilotGbrainToolCall(mcpToolName, args, {scope, exec})` = SC5a police → injected exec(scope-corrected args) → SC5b redact. Deny/exec-fault/exec-throw/redacted-empty ALL collapse to one leak-safe empty result (`"[]"`); the internal cause is never surfaced. Security L1 fixed in-slice: the whole body is wrapped in an outer try/catch so never-throws is STRUCTURAL. 14 tests.
- **SC7b** (`2c330b5`, `packages/providers/src/runtime/copilot-gbrain-proxy-mcp.ts`) — `createCopilotGbrainProxyMcpServer` mirrors the propose-MCP precedent: one `tool()` per scoped read op (query/traverse_graph/find_contradictions/get_recent_salience/get_timeline) under server name `gbrain`, delegating to the injected structural handler. NO mutating/unscopable op exposed; args forwarded UNPARSED; the full `mcp__gbrain__<op>` name is server-reconstructed. 8 tests.
- **Code-quality M1 (documented in-code):** the SDK zod-parses+STRIPS undeclared model args (`all_sources`/`source_id`) UPSTREAM of the handler, so the per-op shapes double as a positive arg allow-list — SC5a's widening-deny is defense-in-depth on the wired path while its foreign-seed/slugPrefix/source-pin work stays load-bearing.
- **Security L2 → SC8 MAP-KEY CONTRACT (documented + carried forward):** SC8 must register the proxy under map key `"gbrain"` AND ensure the raw `gbrain serve --http` entry is absent — a different key leaving it present ⇒ model sees BOTH scoped + unscoped tools (full WS-8 bypass); SC8's wiring test must assert the http entry's absence.

**NEXT = SC8** (runner wiring in `copilotAgentSynthesis.ts`) → **SC9** (admission backstop) → then `copilotAgentMode` can flip.

## Continuation — SC8 the runner + boot wiring (`e9b577e`, `27aa0c0`, `6b47192`, dual-reviewer clean)

SC8 wires the SC7 proxy so the agent reaches gbrain ONLY through it. A 3-part slice (the existing `createGbrainHttpExec` is query-only + returns parsed hits, so a NEW generic exec was needed):
- **SC8a** (`e9b577e`, `copilotGbrainHttp.ts`) — `createGbrainMcpToolCallExec`: a generic gbrain MCP `tools/call` over http returning the RAW MCP result envelope (op = the `mcp__gbrain__<op>` suffix), which SC5b's redactor parses. Shared `postMcpRequest` extracted from the query exec (rewired, regression-caught by its 30 tests); `extractMcpResultEnvelope` is the shared JSON-RPC→result step. Fail-closed: loopback-before-fetch (Rule 5), op-strip, JSON-RPC/tool-`isError`, never throws. 8 tests.
- **SC8b** (`27aa0c0`, `copilotAgentSynthesis.ts`) — the runner's proxy branch. When the proxy deps are present, it registers `createCopilotGbrainProxyMcpServer(handler)` under the SAME `gbrain` map key (REPLACING `buildGbrainMcpServers` — never both), drives `allowedTools` from the scoped `COPILOT_GBRAIN_PROXY_MCP_NAMES` (no unscopable ops), and mints NO token (the exec does, per call). A PARTIAL proxy config FAILS CLOSED (`invalid_job`). 4 tests.
- **SC8c** (`6b47192`, `boot.ts`) — builds the served `CopilotWorkspaceScope` + the SC8a exec + the proxy factory behind `copilotWorkspaceScoping` + `copilotAgentMode` (dormant); lazy-closure forward-reference to `copilotWorkspaceScope` (safe — invoked post-boot).

**Dual review (security + code-quality) — security 0 crit/high/med:** the **MAP-KEY CONTRACT verified HOLDS** (proxy and raw-http branches mutually exclusive under one `gbrain` key; the test asserts the raw http entry is absent + no token minted + the scoped allow-list). Fixes folded in-slice: M1 (one `servedWorkspaceIdStr` feeds both the runner gate and the proxy scope, kept in lockstep), M2 (both partial-config permutations tested), L5 (a mis-routed tool name → `validation_rejected`, not a transient fault).

**The runtime WS-8 tool path is now FULLY BUILT** (SC5a args + SC5b results + SC7 proxy + SC8 wiring), all dormant behind `copilotAgentMode`. **NEXT = SC9** (admission backstop — the 4th defense-in-depth layer) → then the security-review-gated flip.

## Open follow-ups (NEXT) — full detail in `docs/team-handoffs/001-2026-07-06-ws8-scoping-resume.md`

1. ~~**SC5b** result redactor~~ **DONE (`fffd78d`)** · ~~**SC6** transport seams~~ **DECIDED-OUT** · ~~**SC7** gbrain-proxy MCP~~ **DONE (`d8fc89d`+`2c330b5`)** · ~~**SC8** runner+boot wiring~~ **DONE (`e9b577e`+`27aa0c0`+`6b47192`, MAP-KEY CONTRACT verified)**. NEXT = **SC9** admission backstop (extend `admitCopilotAgentJob` to reject an unscopable-tool/unresolved-scope agentic job — the 4th defense-in-depth layer) → then `copilotAgentMode` can flip (security-review-gated; the runtime path is fully built + dormant).
2. The flagged future work (other tracks): the **ingest-side workspace-attribution rule** (the real WS-8 enabler + the only A1 mitigation); the legacy-migration runbook (owner-run); the workspace-leakage governance eval (eval-security, per the runbook §13.10 gate (c) contract); the SDK-0.3.201 conformance test; `WorkspaceConfigRepository`; Global-scope via the GCL Visibility-Gate union; the Appendix-A `GbrainReadGrant.allowedOps` truth-pass (now OPTIONAL).
3. Untouched from 041: 13.10a (Copilot→KMP propose path), the real serving oracle (C5.4b go-live), the ~8 Phase-9/10 owner-calls + a Phase-10 `/phase-exit`, Tiers 2–5 + 13.10c Gmail.

## Carry-forward triage (deferred lows — not blockers)

- SC5a security lows (deferred): the alternate-seed-key assumption for traverse_graph/get_timeline (verify gbrain seeds only on `slug` before flipping `copilotAgentMode`); `vault.read` path-scoping is SC6's job (correctly denied by the gbrain-only arg policer today).
- The A1 residual (body-embedded foreign content) — owner-facing, ingest-time fix; documented, accepted for the runtime layer.

## Reference

Memory: `sow-copilot-skill-catalog`, `sow-copilot-real-model-direction`. Canonical docs: `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md` (§13.10), `docs/runbooks/copilot-propose-go-live.md` (§13.10), `docs/planning/ws8-workspace-scoping.md` (NEW), `docs/planning/copilot-skill-catalog.md`. Workflow: `wf_039163e8-07d` (WS-8 design) + a standalone result-leakage verifier re-run.

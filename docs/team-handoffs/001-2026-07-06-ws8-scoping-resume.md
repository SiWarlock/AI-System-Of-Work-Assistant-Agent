# Handoff 001 — WS-8 scoping build (SC5b → SC6–SC9 → multi-served → F2 → cert → vault.read)

- **Date:** 2026-07-06 · **From session:** `docs/sessions/042-2026-07-06-ws8-scoping-design-sc1-gates-bcd.md` (+ session 043 `docs/sessions/043-2026-07-06-ws8-multi-served.md`)
- **HEAD:** `9d3b1f4` — everything pushed to origin/main (0/0). Tree clean except the owner's `.claude/settings.json`, `CLAUDE.md`, `graphify-out/`. **Gate:** repo-wide `turbo typecheck test` 31/31.

## ⏩⏩⏩ RESUME HERE (session 048, 2026-07-07) — §13.10a Copilot→KMP bridge, STOPPED at the Approval-shape decision

**HEAD `d38a319` (4 commits this session, NOT pushed at handoff-write; push at close-out). Gate 31/31 throughout. Canonical tracker: memory `sow-copilot-kmp-bridge`. Session doc: `docs/sessions/048-2026-07-07-create-vs-patch-and-copilot-kmp-bridge.md`. Plan: `~/.claude/plans/snazzy-honking-stearns.md`.**

This session: (1) **create-vs-patch split `9288bcd`** — finished the deterministic dashboard build (the P3e always-NoteCreate re-sync clobber bug, fixed via a WS-8 note-exists probe → NoteCreate|NotePatch; dual-reviewer CLEAR; closed the WS-8 workspace-segment LOW). (2) **Composition Finding** — task #31's "wire the concrete trio" premise is FALSE (6/9 projectSync ports unbuilt, `runProjectSync` composed nowhere; real-integration + Temporal-gated). Owner **picked §13.10a** over the Temporal path. (3) **§13.10a Slices A+B** — the frozen round `ProvenanceOrigin += copilot_propose` (`dd2915b`) + the PURE `deriveCopilotProjectKnowledgePlan` (`d38a319`, `apps/worker/.../copilotProposeKnowledge.ts`): untrusted model project intent → a validated, human-gated KMP for the project note (reuses the create-vs-patch machinery; dual-reviewer security CLEAR). ⚠ the pre-impl design Workflow STALLED — fell back to inline-design→TDD→dual-reviewers (robust).

**⏸ NEXT = the OWNER'S Approval-shape decision (the plan's flagged stop-point), THEN slices 3-7.** `Approval.actionRef` is external-action-only; how does a pending KMP ride §9.8 Approvals? (A) HONEST: pending-KMP store + `Approval` gains a semantic subject (frozen + desktop); (B) LIGHTER: reuse `actionRef` as an opaque ref (no frozen change). After the decision: pending-KMP store → sink→§9.8 Approvals → on-approval→KnowledgeWriter executor (NEW) → `copilot.propose_knowledge` tool/catalog/runner → desktop card. **2 go-live residuals in-code:** verify frontmatter projectId on patch (routing slice); YAML-escape frontmatter (KnowledgeWriter track). Full detail: memory `sow-copilot-kmp-bridge`.

**Dashboard arc (prior) status unchanged:** deterministic build DONE; R5/P4/full-composition DEFERRED (task #31, owner-fork, real-integration+Temporal). Memory `sow-dashboard-real-producers`.

---

## ⏩⏩ RESUME (state at compaction, 2026-07-07) — the real-dashboard frontier

**Canonical tracker for the current work: memory `sow-dashboard-real-producers`** (fully current). Session docs: 044 (skill-intro), 045 (recent-changes Arc R), 046 (typed Project P1–P3b), 047 (the projectSync projection P3e). Plan: `~/.claude/plans/snazzy-honking-stearns.md`.

**Both dashboard arcs' DETERMINISTIC build is COMPLETE + fully reviewed — what's left is composition wiring + a Temporal decision, not more building.**
- **Arc R (recent-changes, audit-driven):** R1–R4 DONE (`66c3bde`→`534c7ed`). ⏳ R5 (always-on wiring) Temporal-gated.
- **Arc P (Projects, typed Project model §13.5):** P1 seam (`517659c`) · P2 7th state machine (`1ddbf10`) · P3a dashboard builder (`63a8d0b`) · P3b read-model update port (`7ba1892`) · P3c ValidateNarrativePort (`ccaebf5` — the schema-gate-redundancy question RESOLVED by investigation: broker owns the schema gate, no-inference is owned here) · P3d provenance arch_gap (`f919565`) · **P3e the concrete `SyncOutputsProjection` (`0ca8dd0`+`30bcfbf`+`05df188`) — design-verified via a survey→design→adversarial-verify Workflow that CAUGHT 3 safety MAJORs (WS-8 slug-as-path traversal, REQ-F-011 note percent, no-inference render dup), all fixed + dual-reviewer RE-VERIFIED HELD (0 crit/high/med).**

**NEXT — task #31 (composition wiring + P4/R5 activation, Temporal-gated):**
1. Wire the concrete trio (`createProjectSyncOutputsProjection` + `createValidateNarrativePort` + `createProjectDashboardUpdatePort`) into the projectSync activity/driver composition (boot/worker-host), replacing the fakes (`FakeBuildSyncOutputsPort`/`FakeValidateNarrativePort`/`FakeUpdateDashboardPort` in `project-sync-fakes.ts`).
2. Driver **create-vs-patch re-run split** (the projection always returns `NoteCreate`; on re-sync the driver should region-PATCH `project-status`, not re-create — named follow-up).
3. **P4** = register the projectSync activities + trigger `runProjectSync`; **R5** = wire the `projectRecentChanges` projector to live audit appends. BOTH need Temporal (app boots degraded) — this is the **owner's deployment fork** (bring Temporal up vs a degraded-mode trigger), not a code-design problem.
- Deferred: assert the `workspaceId` note-path segment is path-safe (security LOW, defense-in-depth); pin the `sow:project-sync-output` narrative-draft schema + wire it on `createValidateNarrativePort`'s `narrativeSchema` hook (the P3c go-live gate).

**Other high-leverage direction (owner fork):** §13.10a — the **Copilot→KnowledgeMutationPlan bridge** (the Copilot still can't propose a Markdown edit; blocks the whole semantic-write class — the typed Project model now gives it a clean first target). Memory `sow-copilot-skill-catalog` §5.1.

---

## Earlier ⏩ RESUME (state at compaction, 2026-07-06) — the WS-8 / C6 arc

This session (043) landed, on top of the WS-8 arc, in order — all pushed, all dual-reviewed:
1. **Multi-served** (`daab098`+`73592be`+`31adae0`) — Option A single-brain multi-served; ANY registered workspace reads the one brain scoped per-ask. LIVE on boot. See memory `sow-copilot-multi-served`.
2. **F2 field-fidelity CLOSED** (`0e6b000`) — `allowItemFields` reduces every kept gbrain result to own-content+scalars (schema-agnostic; dissolved the pinned-schema blocker).
3. **WS-8 separation CERTIFIED** (`2601b69`) — end-to-end test, one brain / 3 workspaces / both read paths / all directions.
4. **Owner accepted employer-work in the combined brain** (`27aa94a`) — guard reversed; A1 body-quote + A1-under-personal-cloud-ask are the accepted residuals; Option B (separate brains) deferred.
5. **§13.10d `vault.read` BUILT** (`75cf6a8` providers MCP + `f7feb95` worker + `08a470b` docs) — symlink-safe WS-8-scoped page read behind the `copilotVaultRead` boot flag (**OFF**). A symlink-escape CRITICAL was found + fixed in-slice (realpath re-attribution) + RE-VERIFIED CLOSED.
6. **§13.10d SKILL INTROSPECTION BUILT** (`bf994e6` policy catalog + `bdf4170` worker handler + `d693e32` providers MCP/wiring, boot flag `copilotSkillIntrospection` **OFF**) — completes the owner's "vault page-reads + skill introspection" C6 pick. `skills.list`/`skills.get` (`mcp__skills__*`) let the agent enumerate its own read-skills + read one skill's metadata; a NEW 4th `CopilotToolScopingClass` `"workspace-agnostic"` (reads the STATIC catalog, touches NO workspace data ⇒ nothing to scope, no leak, kept on any brain). The handler NEVER reveals the write-proposing tool (reads `COPILOT_READ_TOOLS`, not the combined `CATALOG`), never-throws. Dual-reviewer clean (security 0 crit/high/med; 1 by-design low). Mirrors the vault/gbrain-proxy MCP. See memory `sow-copilot-skill-catalog`.

**NEXT (owner-directed "C6 then the real dashboard") — C6 DONE; the dashboard is in progress.** Full detail in memory `sow-dashboard-real-producers` + the plan `~/.claude/plans/snazzy-honking-stearns.md`. Read path is real; the PRODUCER is stub. Owner chose the canonical heavy paths (typed Project model; audit-driven recent-changes + `workspaceId`).
- **✅ Arc R (recent-changes, audit-driven) DETERMINISTIC CORE DONE (R1–R4, `66c3bde`→`534c7ed`, dual-reviewer clean):** `AuditRecord.workspaceId` optional (R1 frozen-contract) → audit DB column + query filter both dialects + `0002` migration (R2) → populate at the KnowledgeWriter commit + tombstone audits (R3) → the pure WS-8-fail-closed + Lesson-§5-redacted `projectRecentChanges` projector (R4). **⏳ R5 (always-on wiring) is Temporal-gated, DEFERRED.**
- **⏳ Arc P (Projects, typed Project model, §13.5) — NEXT, not started:** P1 the `Project` frozen seam contract (frontmatter + bi-temporal timeline + lifecycle enum) + `project_capture` on `ProvenanceOrigin` → P2 the 7th state machine `packages/domain/src/state/project.ts` (`defineMachine` convention) → P3 the concrete projectSync→`UiSafeProjectDashboard` seam (the driver + no-inference gate EXIST; the gap is the opaque `dashboard` payload + no concrete read-model-upsert port) → P4 activation (Temporal-gated, deferred). Sub-forks to confirm at Arc-P start are in the memory + plan.
- **To ACTIVATE the C6 read tools** (both zero/low-risk, flag-gated for a deliberate agentic surface): set `copilotVaultRead: true` (needs the Obsidian vault path wired as `vaultRoot`) and/or `copilotSkillIntrospection: true` (no vault dep — zero-leak) in `apps/desktop/worker-host/index.ts`, alongside the live `copilotAgentMode`/`copilotWorkspaceScoping`.

Standing method: survey→design→adversarial-verify for design-uncertain slices; TDD; per-slice commit (explicit `git add`, never `-A`; Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`); security+code-quality reviewers per security-touching slice; repo-wide `turbo typecheck test` after any contract change; don't touch `../SoW-build-evalsec`; push at close-out. Canonical trackers: memory `sow-copilot-multi-served`, `sow-copilot-skill-catalog`, `sow-copilot-real-model-direction`.

## ✅ MULTI-WORKSPACE SERVING — DONE (Option A, single-brain multi-served)

Owner picked **Option A** ("fine with a single brain for now"). Landed in 3 slices (all WS-8 security-reviewed CLEAR, 0 crit/high/med):

- **MS1 `daab098`** — `createMultiServedGbrainRetrieval` (`copilotGbrainSubprocess.ts`): the retrieval gate is now registry membership (`descriptorFor`), not a fixed `servedWorkspaceId`. ANY registered workspace reads the ONE brain, scoped PER-REQUEST to its own slug prefix via a MANDATORY filter (no passthrough); unregistered → fixture fallback (no brain read).
- **MS2 `73592be`** — `gbrainProxyScopeFor` resolver on `createClaudeAgentCopilotRunner` (`copilotAgentSynthesis.ts`): the agentic proxy scope binds per-ASK to the asked workspace (proven by driving the bound handler — a foreign hit is dropped). Precedence over the fixed single-served gate; unregistered → tool-less; partial config → invalid_job.
- **MS3 `31adae0`** — wiring (`buildCopilotDeps` + `boot.ts`): scope-present ⇒ multi-served composite + `gbrainProxyScopeFor` built from the registry+policy. Scope-absent keeps single-served (byte-identical back-compat).

**LIVE NOW:** worker-host already has `copilotWorkspaceScoping: true` + `{assign, personal-business}`, so multi-served is ACTIVE on boot. Each of the 3 well-known workspaces reads the brain scoped to itself; only personal-business has content today, so personal-life/employer-work asks read the brain filtered-to-empty (safe, honest "nothing found"). `decideHitScope` keeps `{assign}` sound (unprefixed served only to personal-business).

**How to ADD a workspace's content NOW:** `printf '…' | gbrain put "personal-life/<topic>"` — the `personal-life/` slug prefix attributes it, and multi-served surfaces it the next time you ask personal-life. **OWNER ACCEPTED employer-work in the combined brain (2026-07-06, "separate brains later")** — save it PREFIXED (`employer-work/…`). F2 structural field-fidelity is CLOSED so cross-workspace SURFACING is scoped out; the accepted residuals of ONE shared brain are A1 (a page whose body verbatim quotes another workspace) and — since employer-work egresses to the Claude cloud WITH a notice — A1 employer text in a PERSONAL page egressing under a PERSONAL ask WITHOUT the notice. Option B (separate brains) removes both, deferred per owner.

## ✅ F2 field-fidelity — CLOSED at runtime (`0e6b000`, security-reviewer CLEAR for WS-8)

`allowItemFields` in the SC5b redactor (`packages/policy/src/copilot-result-redaction.ts`) reduces EVERY kept hit / traverse_graph node+edge / timeline entry to allow-listed own-content strings + all numeric/boolean scalars, DROPPING every array, nested object, and non-allow-listed string — the structural foreign-ref carriers (a `backlinks`/`related`/`neighbors` array, a nested foreign node, a `related_to` slug string, an edge `snippet`/`excerpt`). Edges emit ONLY the single keepSlug-validated target under a canonical `to` (closes a dual-alias-key leak the reviewer found). **Schema-agnostic** — dissolves the old "needs gbrain's pinned per-op result schema" blocker (unknown scalars survive, unknown containers/ref-strings drop). Dual-reviewer clean; 29 policy redaction tests; repo-wide 31/31. Path DORMANT + INERT on single-workspace content.

## NEXT (owner-gated / deferred — not blockers)

- **A1 body-embedded foreign content — the remaining gate before employer-work joins the combined brain.** A kept in-workspace page whose BODY verbatim quotes another workspace (F2 handles structural fields; A1 is prose, so NOT runtime-fixable). Ingest-time fix: KnowledgeWriter classification + per-workspace source partitioning.
- **gate-(c) certification** — ✅ the COPILOT read paths are now CERTIFIED end-to-end in `apps/worker/test/integration/copilot-ws8-separation.test.ts` (`2601b69`): ONE brain holding all 3 workspaces + legacy, driven through both P1 (answerCopilotQuestion) + P2 (agentic proxy) for every ask direction, exact citation/slug-set + foreign-marker-exclusion assertions (fails on any leak). The BROADER catalog-wide governance eval in `packages/evals` (every cataloged read op, corpus-driven, adversarial) remains eval-security territory — coordinate.
- **Option B (per-workspace brains + serve + routing)** — the stronger-isolation target if you ever want employer-work in the Copilot without waiting on A1; WS-8 by construction, no A1 exposure. Bigger (a supervisor + serve + token + exec per brain). Deferred; single brain is fine per owner.
- Prior deferrals still open: real Copilot model verification end-to-end in the running app; propose go-live (C5.4b real serving oracle + the 5 preconditions); C6 skills (owner-decision-gated).

## (prior) RESUME context
- **Design of record:** `docs/planning/ws8-workspace-scoping.md` (the full survey→design→4-verifier output + BUILD-ORDER VERDICT + OWNER-GATED). **Memory:** `sow-copilot-skill-catalog`, `sow-copilot-real-model-direction`.

## What is DONE (this session, all pushed + dual-reviewer-clean)

**§13.10 go-live gates:** (b) verified live vs gbrain v0.35.1 (per-op read/write/admin scope; the frozen `GbrainReadGrant.allowedOps` enum is a SoW-side Path-1 gate the agentic Path-2 bypasses ⇒ growing it is NOT required). (c) a 5-point read-path eval contract in `docs/runbooks/copilot-propose-go-live.md` §13.10 gate (c) for the eval-security track. (d) de-phantomed the catalog (`245e4fd`).

**WS-8 gate (a):**
- **P1 unit LIVE + INERT** — SC1 core (`a0870bb`, `packages/policy/src/copilot-workspace-scope.ts`) · SC2 filter (`369a3b1`, `apps/worker/.../copilotGbrainSubprocess.ts`) · SC3 boot (`8092d80`) · **flipped live** (`12ea650`, worker-host `copilotWorkspaceScoping:true` + `{assign,personal-business}`). On today's single-workspace brain every hit is kept — no change to Copilot output; enforcement live for future prefixed/multi-workspace content.
- **P2 layer built + DORMANT** (behind `copilotAgentMode` OFF) — SC4 catalog narrowing (`2795a7d`, `copilotScopedReadToolIds`) · SC5a arg policer (`ef369f6`, `packages/policy/src/copilot-arg-policy.ts`) · **SC5b result redactor DONE (`fffd78d`, `packages/policy/src/copilot-result-redaction.ts`)** — `redactGbrainToolResult` folds A2/A3/A4 + fail-closed drop-all; dual-reviewer clean, F1 (non-array `links` fail-OPEN → neutralized to `[]`) + F3 (unscopable op DROPS-ALL on a non-partitioned brain via `copilotToolScopingClass`, mirrors SC5a M2) fixed in-slice; 22 tests; repo-wide 31/31. **⚠ F2 CARRY-FORWARD → gate-(c) eval:** per-op FIELD allow-listing of kept hits/nodes (nested foreign refs under non-`links` keys) needs gbrain's pinned per-op result schema; documented in-code, not reachable today.

## RESUME HERE → OWNER: enable + verify Option A, then the multi-workspace WS-8 gaps

**`copilotAgentMode` is FLIPPED LIVE** (`35b8ad4`): the runtime WS-8 tool path (SC5a+SC5b+SC7+SC8) is ACTIVE — tools routed ONLY through the scoped proxy. WS-8-safe today (single-workspace brain ⇒ scoping + F2 inert).

**Option A (app-managed serve + unify transport) is BUILT** (owner-picked; makes the agentic tools functional end-to-end by having the app own ONE `gbrain serve --http` that both retrieval + tools share, resolving the PGlite DB-lock contention): **SS1** supervisor (`e029115`) + **SS2** (already the `copilotGbrainTransport:"http"` flag) + **SS3** worker-host wiring (`7554086`).

**⚠ NEXT = an OWNER runtime step (not code): enable + verify Option A.** `MANAGE_GBRAIN_SERVE` (`apps/desktop/worker-host/index.ts`) ships DEFAULT OFF because two things couldn't be validated at ship time: (1) that `gbrain serve --http` actually spawns + becomes ready in the deployment env, and (2) ⚠ **SECURITY** that it binds LOOPBACK (gbrain has NO `--host` flag → bind interface is its default; a 0.0.0.0 bind on an untrusted LAN would expose the brain, bypassing WS-8 + egress veto). **Verify: first boot with the flag on, run `lsof -iTCP:8899 -sTCP:LISTEN` (expect 127.0.0.1, NOT `*`) + confirm tools return results.** Then keep it on. If serve doesn't come up, boot degrades gracefully (CLI retrieval + fail-closed tools) after a 10s bound. Deferred robustness (SS1/SS3 review lows): a SIGTERM→SIGKILL escalation on dispose, an `uncaughtException` dispose hook, backoff + restart-reset.

**Then the MULTI-workspace WS-8 hardening (only bites once the brain holds >1 workspace; INERT today):** the **F2** field-fidelity gap (per-op field allow-listing pinned to gbrain's real result schema → the gate-(c) governance eval, `packages/evals`) + the **A1** body-embedded residual (ingest-time).

**Then the MULTI-workspace WS-8 hardening (only bites once the brain holds >1 workspace):** the **F2** field-fidelity gap (per-op field allow-listing pinned to gbrain's real result schema → the gate-(c) governance eval, `packages/evals`) + the **A1** body-embedded residual (ingest-time). Both are INERT on today's single-workspace brain.

**Prior decisions (for context):** **SC6 DECIDED-OUT** (SDK: PostToolUse result-replacement unconfirmed). **SC9 REASSESSED-OUT (do NOT build as spec'd).**

**⚠ SC9 finding (why it was dropped):** the originally-planned admission backstop — "reject an agentic job whose allow-list holds an `unscopable` tool on a non-partitioned brain" — is **mis-targeted**. An agentic job's `toolPolicy.allowedTools` is `copilotReadToolIds()` = the **FULL read catalog INCLUDING the unscopable tools** (it is the ING-7 mutating-classification surface, NOT the exposure set), so that check would reject **every** agentic job. The unscopable vector is correctly defended at the SDK-exposure layer at **4 points already**: SC4 `copilotScopedReadToolIds(false)` narrows the read set · SC8b drives the SDK allow-list from the fixed 5-op `COPILOT_GBRAIN_PROXY_MCP_NAMES` (never an unscopable op) · SC5a arg-denies · SC5b result-drops-all. A job-policy admission check adds nothing.

**NEXT is the `copilotAgentMode` flip — an OWNER decision (security-review-gated), not a code slice.** Before proposing it, the owner-facing gaps remain: the **F2 field-fidelity carry-forward** (per-op field allow-listing pinned to gbrain's real result schema → the gate-(c) governance eval) and the **A1 body-embedded residual** (ingest-time). If the owner wants one more admission-layer check, the only non-redundant candidate is a **scope-resolution consistency check** (served workspace resolves in the registry) — but SC8b's partial-config fail-closed + the served-workspace-only-gets-tools rule largely cover it; propose, don't build speculatively.

**SC7 DONE:** SC7a `d8fc89d` · SC7b `2c330b5`. **SC8 DONE (dual-reviewer clean, security 0 crit/high/med):** SC8a `e9b577e` (`copilotGbrainHttp.ts` `createGbrainMcpToolCallExec` — generic MCP call, RAW envelope, shared `postMcpRequest`) · SC8b `27aa0c0` (`copilotAgentSynthesis.ts` — proxy replaces the http entry under the `gbrain` key; partial-config fail-closed) · SC8c `6b47192` (`boot.ts` — builds scope+exec+factory behind the flags). MAP-KEY CONTRACT verified HOLDS (mutually-exclusive branches; test asserts the raw http entry absent).

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

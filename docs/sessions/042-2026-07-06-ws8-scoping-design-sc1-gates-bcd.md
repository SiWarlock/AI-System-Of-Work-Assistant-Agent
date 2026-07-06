# Session 042 — §13.10 `copilotAgentMode` go-live gates: (b) verified, (c) noted, (d) done + gate (a) WS-8 design + SC1

- **Date:** 2026-07-06 · **Mode:** single-operator (build + docs, ultracode) · **Tracks:** policy · docs
- **Predecessor:** `041-2026-07-06-skill-catalog-canonical-docs-audit.md`
- **Successor:** _(next session)_
- **HEAD at close:** `369a3b1`+ (pushed to origin/main). Session arc: `cf2e973` → SC2 + doc reconcile.
- **Gate at close:** repo-wide `turbo typecheck test` **31/31** green; all code slices dual-reviewer-clean.

## Why this session existed

Continued the owner's §13.10 go-live work. NEXT-item 2 (the four `copilotAgentMode` go-live gates before flipping the agentic read path) — three are self-contained and clear the way for the hard one (gate a, WS-8). Landed gates (b)/(c)/(d) + the full gate-(a) design + its foundation slice.

## What was built / done (commits)

- **`245e4fd` — gate (d): de-phantom the Copilot read-tool catalog.** Empirically probed live gbrain **v0.35.1** (`serve --http --enable-dcr`, DCR→token→`tools/list`+`tools/call`). Renamed `gbrain.graph`→`traverse_graph`, `gbrain.timeline`→`get_timeline` (real read tools); pruned `schema_read`/`contained_synthesis` (no live tool) + `health` (real op `get_health` requires ADMIN scope, unreachable to the read-pinned DCR client). Established **servable-under-read-scope** as a catalog precondition; fail-safe preserved. Dual-reviewer clean (0 crit/high/med; 1 quality MEDIUM folded — narrowed the `search`→`query` exception comment; swapped an arbitrary phantom test fixture).
- **`eca4760` — docs: reconcile plan/runbook/catalog for gates (b)/(c)/(d).** NEW §13.10 section in `docs/runbooks/copilot-propose-go-live.md` (the authority for all four gates in ladder order); plan §13.10 gate line + §13.11 cross-doc note; `docs/planning/copilot-skill-catalog.md` de-phantomed.
- **`a0870bb` — gate (a) SC1: the WS-8 workspace-scope core** (`packages/policy/src/copilot-workspace-scope.ts`). `attributeSlug` (segment-wise longest-prefix, boundary-correct + traversal-fail-closed), `attributeHit` (source_id-first/slug), `decideHitScope` (keep/drop under served workspace + `LegacyContentPolicy`), `WorkspaceScopeRegistry` (split-ready descriptor). 27 tests. Dual-reviewer clean (security 0 crit/high/med — fail-closed on every attacked axis; quality 2 mediums folded — tie-reset + multi-prefix + empty-prefix regression tests). Design durable in `docs/planning/ws8-workspace-scoping.md`.
- **`369a3b1` — gate (a) SC2: the P1 WS-8 scope filter** (`apps/worker/src/api/procedures/copilotGbrainSubprocess.ts`). `createWorkspaceScopeFilter` + optional `scopeFilter?` on `createGbrainSubprocessRetrieval`, applied over the RAW hits BEFORE `normalizeGbrainHits` (both the subprocess AND http transports flow through this ONE composite). Fail-closed `readRawScopeHit`; non-array passthrough. DORMANT (not yet at the live composite — SC3). Dual-reviewer clean (security PASS on all 6 WS-8 attack axes, 0 crit/high/med; quality typeof-guard hardening folded). 662 worker tests green.

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

## Reachability / current state

- §13.10 gates: (b) verified, (c) eval-contract noted for the eval-security track, (d) done. (a) design done + SC1 landed; SC2–SC9 owner-gated.
- SC1 is DORMANT (nothing consumes it yet; default-OFF). The live Copilot (tool-less synthesis) is unaffected. `copilotAgentMode` stays OFF.
- All work pushed to origin/main (HEAD `a0870bb`); working tree clean but for the user's graphify config (`.claude/settings.json`, `CLAUDE.md`, `graphify-out/`) — intentionally not staged.

## Open follow-ups (NEXT)

1. **Owner decisions above** (esp. the A1 residual + the legacy-policy posture) — they gate SC3 and the whole flag-flip.
2. SC2–SC9 machinery once the posture is chosen (SC5 must fold in A2/A3/A4).
3. The flagged future work (other tracks): the **ingest-side workspace-attribution rule** (knowledge — the real WS-8 enabler + the only A1 mitigation); the legacy-migration runbook (docs, owner-run); the workspace-leakage governance eval (eval-security, per the runbook §13.10 gate (c) contract); the SDK-0.3.201 conformance test; `WorkspaceConfigRepository`; Global-scope via the GCL Visibility-Gate union; the Appendix-A `GbrainReadGrant.allowedOps` truth-pass (now OPTIONAL).
4. Untouched from 041: 13.10a (Copilot→KMP propose path), the real serving oracle (C5.4b go-live), the ~8 Phase-9/10 owner-calls + a Phase-10 `/phase-exit`, Tiers 2–5 + 13.10c Gmail.

## Reference

Memory: `sow-copilot-skill-catalog`, `sow-copilot-real-model-direction`. Canonical docs: `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md` (§13.10), `docs/runbooks/copilot-propose-go-live.md` (§13.10), `docs/planning/ws8-workspace-scoping.md` (NEW), `docs/planning/copilot-skill-catalog.md`. Workflow: `wf_039163e8-07d` (WS-8 design) + a standalone result-leakage verifier re-run.

# Session 041 — §13.10 Copilot Skill Catalog + canonical-doc pass (ARCH + PLAN) + Phase 9/10 audit

- **Date:** 2026-07-05 → 2026-07-06 · **Mode:** single-operator (build + docs, ultracode) · **Tracks:** policy · worker · docs
- **Predecessor:** `040-2026-07-05-c54b-provenance-stamping-seam.md`
- **Successor:** _(next session)_
- **HEAD at close:** `da85371` (all pushed to origin/main). Session arc: `b310eac` → `da85371`.
- **Gate at close:** repo-wide `turbo typecheck test` **31/31** green (last run before the doc-only commits); all code slices dual-reviewer-clean.

## Why this session existed

Continued the owner's "do all 3" (C5.4b landed as blocker 2 in session 040). Then the owner said **"I want all the skills"** → a skill-catalog review → the §13.10 Copilot Skill Catalog + Tier-1 build. Then **"keep the plan canonical … update the architecture doc … + an in-depth sanity check"** → the ARCH + PLAN canonical passes + the Phase 9/10 checkbox audit.

## What was built / done (commits)

**§13.10 Copilot Skill Catalog (C6 — the owner's blocker 3, scoped + partly built):**
- `b310eac` — plan amendment: NEW §13.10 (Tier 0–5 by governance class) + 13.10a (Copilot→KMP propose path) + 13.10b (analysis surface) + 13.10c (Gmail) + the §13.8 dream-cycle SENSE→REASON→EFFECT loop. Driven by a 6-agent gbrain+osb gap-analysis review (`wf_093b9eb5-8f1`). **Decisive finding: the gap is EXPOSURE/CATALOG, not machinery.**
- `b186d82` — Tier-1 slice 1: `gbrain.find_contradictions/find_anomalies/find_orphans` (workflow-designed `wf_6ff86546-b81`; drift-lock is a fail-CLOSED read-op allowlist).
- `9c0ba53` — Tier-1 slice 2: `find_experts` + `takes_×4` + `code_×6` (`code_flow`/`blast` = benign traversal cache; `code_traversal_cache_clear` EXCLUDED as D8-destructive).
- `24174a3` — Tier-1 slice 3: `get_recent_salience` (`get_recent_transcripts` EXCLUDED — local-only). **15 net-new analysis reads cataloged**, all verified pure-read vs the live gbrain MCP, additive (no adapter/grant/enum/runner/boot edit — auto-flow catalog→ING-7→runner allow-list; seed-only propose strip preserved). DORMANT behind `copilotAgentMode` (OFF).
- `926831b` — reconcile §13.10 with the build + the go-live gates.
- `417121c` — **NEW `docs/planning/copilot-skill-catalog.md`** — the full gap analysis, durable in-repo (was only a claude.ai artifact + memory). Author + verify workflow (`wf_7cf50f0c-4f8`).

**Canonical-doc pass (owner: "represent reality, be canonical"):** driven by a ground-truth survey (`wf_10b1e27b-1b2`).
- `8054cf2` — **ARCHITECTURE.md** (19 edits): the whole Phase-C Copilot machinery woven into §5 (catalog + catalog-aware ING-7), §6 (retrieval transports + serving-oracle seam), §7 (runtime containment + agentic runner), §8 (propose wiring + Gmail/vault connectors), §9 #13 (pipeline rewrite) + #8 (scoped inbox), §10 (UiSafeCopilotAnswer), §11 (Copilot **sidebar**, not a page), §13 (enablement ladder), §15 (Gmail in-plan), §2.5 (cross-seam note), Appendix A (UiSafeCopilotAnswer row + worker-internal inventory + GbrainReadGrant.allowedOps annotation). Risk-guarded: no invented frozen contracts, all DORMANT, nothing over-claimed.
- `22a5aa8` — **IMPLEMENTATION_PLAN.md**: **NEW §13.11** promotes the Log-only Phase-C arc (C1–C5.4b + §9.6-real P1–P3.1) to first-class `[x]` tasks; header count/deliverable-map/DAG/track-map/merge-order reconciled. **Structural call: Option B** — the arc lives under Phase 13 (§13.10 catalog + §13.11 machinery), NOT a new Phase 14, because §13.10 was already referenced everywhere (reversible if the owner prefers Phase 14).

**Phase 9/10 in-depth audit + reconciliation:** a 9-agent per-checkbox verification (`wf_70a115f3-d38`, 176 boxes).
- `da85371` — applied the owner-approved reconciliation: **TICKED 24** (the whole §9.1–§9.3 Electron shell/session-token/event-stream spine was built + prod-reachable but ALL unchecked — doc-lag; + §9.8 cards, §9.13 warm-load, §9.14 preload-snapshot); **UN-TICKED 16** (the §10.4/§10.5/§10.6/§10.7 supervision/degraded/backup-doctor/config-guard cluster + §10 acceptance boxes + §9.5 audit-links — all **tested-but-unwired**: algorithms pass conformance but have NO production caller); **4 Files-path fixes** (cross-track paths). Nothing flipped without file:line evidence.

## Decisions made

- **§13.10 additive-catalog pattern** proven across 3 slices (no runtime edits; auto-flow).
- **The Copilot arc lives under Phase 13** (§13.10 + §13.11), not Phase 14 — reference consistency (Option B, reversible).
- **Audit reconciliation is faithful to code reality** — un-ticking tested-but-unwired boxes is the conservative/correct direction (means "not wired into the running app," not "code missing").
- The full skill catalog is now **durable in-repo** (`docs/planning/copilot-skill-catalog.md`), not just an artifact/memory.

## Decisions explicitly NOT made (deferred / owner-calls)

- **~8 ambiguous Phase-9/10 audit items left UNCHECKED pending the owner's judgment:** §9.14 XSS/desktop-side-auth/renderer-log adversarial tests (hardened but named tests absent); §9.2 non-distinct auth-failure UI; §9.10 System Health folded into Today vs the named surface; §10.6 periodic-backup (machinery built, CRON intentionally Phase-11-deferred); §10.6 Keychain-doctor documented-but-unwired; §9.8 "Approval unchanged" note stale (gained `workspaceId`). *(Full list + evidence in the audit output + the Log entry.)*
- **The §10 acceptance/phase-level boxes** must NOT be re-checked on task-level evidence — needs a clean Phase-10 `/phase-exit` once the production drivers land.
- **Tier-1 remainder + go-live gates** (below) — not built this session.

## Reachability / current state

- **§13.10 Tier-1 gbrain-read surface:** cataloged, DORMANT (`copilotAgentMode` OFF; the live Copilot is the tool-less synthesis path, unaffected). Reachable only via the agentic runner when the flag flips.
- **The real Copilot cloud path** is LIVE behind flags (`copilotRealModel` — Sonnet-5 1M); agent/propose/provenance modes built but OFF.
- All work pushed to origin/main (HEAD `da85371`); working tree clean.

## Open follow-ups (what's NEXT)

1. **§13.10d — the vault MCP connector** (the rest of Tier-1: `vault.read` + `list_skills/get_skill` + the §13.4 vault reads) — a distinct runner-wiring slice needing a read-only vault MCP server + path-safety gate. Its own design pass.
2. **The 13.10 GO-LIVE GATES** (before flipping `copilotAgentMode`): (a) WS-8 combined-brain per-workspace partitioning; (b) `serve --http` allowedOps enum scoping verification; (c) the C6 governance eval (eval-security track); (d) phantom-name cleanup (`gbrain.graph/timeline/health/schema_read/contained_synthesis`).
3. **13.10a — the Copilot→KnowledgeMutationPlan propose path** (the sharpest gap; unblocks the whole semantic-write skill class + the dream-cycle propose tier).
4. **The real `admitForServing`-backed serving oracle** (C5.4b go-live — the last propose gate).
5. **The ~8 deferred Phase-9/10 owner-calls** (above) + a Phase-10 `/phase-exit`.
6. **Tiers 2–5** of the skill catalog (synthesis · ingest-trigger · semantic-write · external-action) + **13.10c Gmail connector**.
7. The tested-but-unwired **Phase-10 production drivers** (supervisor crash-loop guard, lease-at-startup, `recoverRun` caller, Temporal reconnect, Keychain-unlock hook, periodic-backup CRON, `loadConfig` call site) — Phase-11-adjacent.

## Reference

Memory: `sow-copilot-skill-catalog`, `sow-copilot-real-model-direction`. Canonical docs: `ARCHITECTURE.md` (§5–§13 + Appendix A), `IMPLEMENTATION_PLAN.md` (§13.10/§13.11), `docs/planning/copilot-skill-catalog.md`, `docs/runbooks/copilot-propose-go-live.md`. Workflows: `wf_093b9eb5-8f1` (catalog review), `wf_6ff86546-b81` (Tier-1 design), `wf_10b1e27b-1b2` (doc survey), `wf_70a115f3-d38` (Phase-9/10 audit).

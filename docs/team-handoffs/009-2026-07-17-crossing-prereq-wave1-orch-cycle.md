# Orch handoff 009 — 2026-07-17 — Phase-18 CROSSING-PREREQUISITE round / Wave-1→Wave-2 ORCH cycle

> Written by the outgoing **orch2** before a same-name cycle at the **Wave-1→Wave-2 boundary** (cycle-by-workload — `/context-check` is BLIND for these Agent-tool subagents, so we cycle by workload, not a reading; this session carried the full Phase-18 close-out + `/phase-exit 18` + the doc-flush + this round's scoping + Wave-1). **You are the incoming `orch2` (SAME NAME — the lead terminates me, then spawns you reusing `orch2`, so contract-impl / worker-impl3 / integrations-impl keep addressing `orch2` with ZERO re-routing; do NOT announce a rename — there isn't one).** Read this, then drive Wave 2.

## ⏱️ IMMEDIATE STATE — verify first
- Repo `/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build`, single-track `main`, single shared checkout.
- **origin/main = `6d6d94bd`** (the Phase-18 safe-build close, pushed). **Unpushed local commits (Wave 1 + this handoff):** CP-1 `beb77b6d` (contract-impl) · CP-4 `f9e5417d` (worker-impl3) · CP-6 `bfd477cd` (worker-impl3) · + my round-close/handoff commit (the tip). **Push is ROUND-CLOSE-ONLY** — you push at the FULL round-close (`/orchestrate-end` after all 7 CP slices land), NOT at this cycle. (Local commits survive a crash; the ~4 unpushed commits are recoverable — if the lead wants a safety push, that's their call.)
- **NEVER-STAGE** (never `git add`): `.claude/settings.json`, root `CLAUDE.md`, `graphify-out/` + `apps/worker/graphify-out/`.
- Team = `Agent`-tool background subagents (SendMessage to name). No heartbeat — cycle by workload at slice boundaries.

## 🎬 THE ROUND — owner Path B (FULL crossing, SAFE ORDER)
The owner chose the **full crossing** (go all the way to the first real model call + spend), executed in the SAFE ORDER: **build the gates + must-fixes DORMANT/NO-SPEND first (this round), then the LEAD provisions the real key + flips LAST.** 7 slices (**18.11–18.17**), all behind the existing default-OFF gates + fake transports; byte-equivalent shipped default until the flip. **GATE-2 / multi-workspace DEFERRED** (single-workspace Claude-first crossing; it only gates the multi-ws arming bundle #5).

**DAG:** CP-1 (18.11) blocks CP-2/CP-3 (18.12/18.13). The must-fixes (CP-4/5/6/7) are independent, parallel-eligible.

## ✅ WAVE 1 — DONE (all dormant / no real key/endpoint/spend)
| Slice | Task | Commit | What / gate |
|---|---|---|---|
| CP-1 | 18.11 | `beb77b6d` | **GATE-1** (the REQ-F-017 hard gate). First-class `agent_extraction` **evidence-PRESERVING** `sow:agent-extraction` Appendix-A schema + `AgentExtractionCandidate` type (contract-impl). The KMP stand-in discarded `evidenceRef`, so a real model's invented owner/date would've bypassed `validateNoInference` — now closed. Schema STRUCTURAL only (empty `{fields:{}}` valid; non-emptiness = the worker MeetingSchemaGate's job, L46); `value = anyOf` via `z.number().finite()` (keeps the shared registry ajv-strict, byte-pristine); `__proto__`/`constructor`/`prototype` `propertyNames` blocklist. security PASS (7/7, verified vs real ajv 8.20 + Zod 3.25). worker LESSON 51. |
| CP-4 | 18.14 | `f9e5417d` | Real HEALTH source **AND-locked** to the `providerTransport` arming (one flip arms run + health); armed-without-`healthSource` ⇒ fail-closed `UNAVAILABLE`, NEVER stub-green (reverse split-brain closed); a runtime-deny-with-OBS-2-HealthItem over a boot-throw (§16). security PASS (deny-gate false-green invariant). worker LESSON 52. |
| CP-6 | 18.16 | `bfd477cd` | missing-key credential-unavailable **observability** (mint on the accessor's `missing` resolution — best-effort/never-alters-the-Err §16, distinct-from-locked via a `credential:` subjectRef over the SAME `worker_down` FailureClass [no frozen-taxonomy expansion, L25], value-free rule 7) + `recordPark` deterministic `auditRef` mint (never null, idempotent). security PASS. worker LESSON 53. |

Doc-routing DONE this round: worker LESSONS §51-53 + CLAUDE index; ARCHITECTURE Appendix-A `sow:agent-extraction` row + `packages/contracts/CLAUDE.md` cross-doc row (CP-1 mirror); plan tasks 18.11–18.17; briefs 125/126/127; the "Currently in progress" status bullet; #13 arming items.

## ▶️ WAVE 2 — REMAINING (yours to drive; briefs NOT yet authored)
- **CP-2 / 18.12 — meeting extraction leg over `agent_extraction`** (integrations-impl providers leg + worker-impl3 wiring). DEPENDS on CP-1 (landed). ISOLATE (REQ-F-017). Switch the 18.3 meeting leg onto the `AgentExtractionCandidate` so `evidenceRef` flows run-leg→candidate→MeetingSchemaGate→`validateNoInference` faithfully, then projects to KMP for commit. **The 1-line `agent_extraction` `BrokerCandidate` union member add (`packages/providers/src/broker/broker.ts:147`) folds in HERE** (providers territory — that's why it wasn't in CP-1). Model quality = eval-at-flip; the deterministic wiring is TDD.
- **CP-3 / 18.13 — source extraction leg over `agent_extraction` + source `stubExtraction` threading** (integrations-impl + worker-impl3). DEPENDS on CP-1. ISOLATE (REQ-F-017 + ING-7). Same switch for the 18.4 source leg; thread the source `stubExtraction` to the worker-host so auto-ingest doesn't fail the source closed at the schema gate (#13 precondition).
- **CP-5 / 18.15 — BUDGET real pricing + COST-1 dollar cap** (integrations-impl pricing + worker-impl3 wire). Independent. ISOLATE. Real per-model pricing (tokens→USD) so an over-budget route denies on `BudgetCap.maxCostUsd`, not just runtime-seconds.
- **CP-7 / 18.17 — rule-7 reject-message field-key redaction** (worker-impl3). Independent. ISOLATE (rule 7). Extraction/schema reject messages carry field KEYS only, never VALUES.

## 🔒 LOCKED DESIGN DECISIONS — carry these into the CP-2/CP-3 briefs (non-negotiable)
1. **Union member → CP-2** (not CP-1): the `agent_extraction` `BrokerCandidate` member is a 1-line additive providers edit (`broker.ts`) that lands with its first producer in CP-2.
2. **Schema id from `AgentJob.outputSchemaId`** — the `AgentExtractionCandidate` type deliberately OMITS `schemaId` (redundant + YAGNI on a frozen surface). CP-2/CP-3 source the schema id from the JOB, never the candidate. (If a genuine drop-in need surfaces, a scoped re-freeze is acceptable mid-round — but plan is omit.)
3. **Consume the Zod-PARSED object, never raw ajv JSON** — belt-and-suspenders on the `__proto__` blocklist; bake this as a hard rule into the CP-2/CP-3 briefs.
4. **Claude structured-output** — the extraction REQUEST uses `output_config.format = { type: "json_schema", schema }` (Context7/Anthropic; strict, `additionalProperties:false`). `evidenceRef` = a verbatim source span. **NO pre-probe** — the schema is our contract; `evidenceRef` faithfulness is **eval-at-flip** (the extraction eval, run at the owner's flip). Claude-first — defer openai/openrouter/voyage.

## 🚧 #13 CROSSING PACKAGE (the owner's LAST step, lead-run) — status
- **GATE-1 [REQ-F-017/rule 2]: now BUILT** (CP-1 `beb77b6d` closed the evidence-preserving surface; CP-2/CP-3 wire the legs onto it). This was the hard prerequisite.
- **GATE-2 [WS-8/rule 4]: DEFERRED** (multi-ws arming; not needed for the single-workspace Claude-first crossing). Carries the phase-boundary security **medium** finding — `buildWorkspace` returns the worker-default posture while `buildMatrix`/`buildEgress` re-scope to `ctx.workspaceId`, so under multi-ws arming a cross-typed-workspace source could skip the employer-raw egress veto (rule 5). INERT today (single-ws + dormant resolver + local-only route). See `docs/audits/18-security.md`.
- **ARMING CAVEAT (CP-4):** `config.healthSources` takes PRECEDENCE over the health-source AND-lock — when arming `providerTransport`, do NOT also bind a green `config.healthSources` (re-opens the false-green). Add to the §19.5 arming runbook.
- **Operational must-fixes:** CP-4 (HEALTH) done; CP-5 (BUDGET dollar cap) + CP-3-half (source stubExtraction) + CP-7 (rule-7 redaction) are Wave 2. The remaining #13 preconditions (missing-key observability CP-6 ✅, recordPark CP-6 ✅) are done.
- **Provision NOTHING.** The real key (`security add-generic-password providers/claude` etc.) + the flip + first spend + the leakage/extraction evals are the LEAD's LAST step, owner-gated. Full #13 detail is in the task-#13 metadata + handoff 008 "OWNER CROSSING PACKAGE".

## 👥 ROSTER
- **contract-impl** — CP-1 DONE. Re-usable if a genuine contracts touch surfaces (unlikely in Wave 2 — the union member is providers, the legs are providers+worker). The lead spawns/stands-down.
- **integrations-impl** (LIVE) — CP-2/CP-3 providers legs (the Claude extraction request + prompt + output schema in `packages/providers/src/model`) + CP-5 pricing.
- **worker-impl3** (LIVE) — CP-2/CP-3 worker wiring (`mapCandidate` consumes the accepted `AgentExtractionCandidate`) + CP-7. **Excellent Wave-1 implementer** — every Step-1 caught a real premise gap (the CP-1 ajv-strict contamination; the CP-6 missing-vs-invalid_ref taxonomy fork). Reward that rigor.

## ⚙️ HOW TO OPERATE (what worked this round)
- Per-slice `/tdd`: dispatch (TaskCreate + brief path, spec-lint the brief) → **Step-2.5** (magic words `APPROVED.`/`TWEAK:`/`ADD:`) → GREEN → Step 7.5 → Step 8 (**security-reviewer = invariant/MANDATORY** on the REQ-F-017/rule-5/rule-7 slices; code-quality every-slice) → **Step-9 commit-message-first** + hot-route flags → commit. **Next brief # = 128.** Next LESSON # = §54.
- **Slice task-ids are 18.11–18.17** (Phase-18 crossing-prereq continuation — keeps spec-lint happy; the brief Task-ID must match a plan task heading or spec-lint FAILs).
- **Brief spec-lint gotcha:** the Task-ID line needs a numeric `18.N` (not "CP-2") + that task must exist in the plan; cited §s must be a subset of Phase-18's Spec-anchors line (§19.5 §7 §5 §9 §6 §16 + Appendix A). Avoid bare `§8`/`§2.5` glyphs.
- **Shared-checkout coordination pattern (learned this round):** uncommitted WIP contaminates the shared full-suite gate. **Land the foundational/contract slice (CP-1) BEFORE dependent full-suite gates** — CP-1's broken-ajv WIP failed ~30 tests in worker-impl3's CP-4 gate until CP-1 committed. CP-2/CP-3 both depend on CP-1 (now landed) so they're clear; if you run two suite-touching slices concurrently, sequence their commits.
- **codegraph MCP** for live symbol/trace (not graphify — stale). **Context7** for the Claude structured-output shape (`/llmstxt/platform_claude_llms_txt`).
- **Owner directive:** on a BUILD design fork, pick best-practice + proceed; escalate only genuine go-live/irreversible/real-spend (the crossing). ISOLATE the REQ-F-017/spend/rule-7 slices (CP-2/3/5/7); when an impl pushes back with evidence, DEFER to the evidence (happened repeatedly — the CP-1 union-home territory, the CP-6 taxonomy fork).
- **Ping the LEAD** (`team-lead`/`main`) only on: the 4 escalation categories, the round-close, OR **when ALL 7 CP prereqs are landed + gate-verified and you judge us ready for the flip** — the lead then takes the owner key-provisioning + arming.

## 📝 WHAT THE SUCCESSOR OWES
Author briefs 128+ for CP-2/CP-3/CP-5/CP-7 (bake in the locked decisions above) → drive them → at the FULL round-close run `/orchestrate-end` (+ `/phase-exit 18` re-run if the phase-exit surface changed — the crossing-prereqs extend §19.5) + **push** → then ping the lead for the flip. LESSONS candidates for CP-2/CP-3/CP-5/CP-7 accrue as they land.

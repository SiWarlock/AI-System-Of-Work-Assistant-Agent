# Orch handoff 010 — 2026-07-17 — Phase-18 CROSSING-PREREQ round / Wave-2 ORCH cycle (mid-round)

Outgoing **orch2** → incoming **orch2** (SAME NAME reuse; lead terminates me + respawns `orch2` so worker-impl3/integrations-impl keep addressing you — do NOT announce a rename). Cycling mid-round at the **4/7 boundary** (Agent-tool sessions have NO heartbeat → silent-overflow risk after ~30 dense turns + 7 review cycles + 6 findings; cycle-by-workload). Everything you need is here + in **task #13 metadata** (the canonical crossing-preconditions store) + the briefs.

## ⏱️ IMMEDIATE STATE — verify with `git log --oneline -8`
- Repo `/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build`, single-track `main`, single shared checkout.
- **origin/main = `691378af`** (Wave-1 pushed). **Push is ROUND-CLOSE-ONLY** — do NOT push mid-round; push once at `/orchestrate-end`.
- **Wave-2 UNPUSHED local commits (origin/main=`691378af`; verified via git log):** CP-7 `8f69a528` (18.17) · CP-2a `9958f4b9` (18.12a) · CP-3a `c4c714e6` (18.13a) · CP-2b `904ddfde` (18.12b) · CP-5a `81399fb8` (18.15a). = **5/7 committed.** REMAINING: CP-3b (#30, worker-impl3 — in flight) + CP-5b (#32, worker-impl3 — queued). integrations-impl DONE with providers → standby. Working tree clean except never-stage trio + untracked orch docs (briefs 128–131, handoff 010) awaiting the /orchestrate-end round-close commit.
- **NEVER-STAGE** (never `git add`): `.claude/settings.json`, root `CLAUDE.md`, `graphify-out/`, `apps/worker/graphify-out/`, + pre-existing handoff `007` mod. This handoff (`010`) + your doc-routing accumulate uncommitted until `/orchestrate-end`.

## ⚠ CP-3b RECOVERY (worker-impl3 DIED mid-CP-3b on context overflow — lead is spawning worker-impl4)
CP-3b (#30) is **INCOMPLETE — no clean commit** (the 5 commits above are intact + clean). **FIRST ACTION:** `git status` — worker-impl3 may have left uncommitted CP-3b WIP (RED tests / partial `registerWorker` edits) in the shared checkout. **Discard any stray CP-3b WIP** (verify against the 5 clean commits; `git checkout -- <file>` / `git clean` the untracked CP-3b test files — but PRESERVE the never-stage trio + briefs 128–131 + this handoff) so **worker-impl4 restarts CP-3b CLEAN** per the **Option-a ruling in #30 metadata** (thread the source stub SEAM only; dormant stays empty/fail-closed; ING-7 admission pins; **NO outputSchemaId switch** — that's the owner-gated arming bundle, Finding C). Do NOT build on half-written WIP. Then CP-5b (#32, full scope in its metadata). This overflow death = why we cycle proactively; cycle worker-impl4 ~every 3 slices + yourself before ~30 turns.

## 🎯 THE ROUND — 7 crossing-prereq slices, all NO-SPEND/dormant (owner does the flip LAST)
Task-ids 18.11–18.17. DAG: CP-1(done Wave1) → CP-2a → {CP-2b, CP-3a} → CP-3b ∥ CP-5a → CP-5b ∥ CP-7. Sub-slice = one /tdd cycle = one commit (providers→integrations-impl, worker→worker-impl3). **security-reviewer MANDATORY on every CP (all ISOLATE); code-quality every-slice.**

| Slice | Task | Status | Hash |
|---|---|---|---|
| CP-7 / 18.17 (rule-7 reject key-only, worker) | #33 | ✅ committed | `8f69a528` |
| CP-2a / 18.12a (agent_extraction producer, providers) | #27 | ✅ committed | `9958f4b9` |
| CP-3a / 18.13a (source request leg, providers) | #29 | ✅ committed | `c4c714e6` |
| CP-2b / 18.12b (meeting consumer, GATE-1 payoff, worker) | #28 | ✅ committed (4/7) | check #28 metadata/git log |
| **CP-3b / 18.13b (source stub thread, worker)** | #30 | **IN FLIGHT (worker-impl3)** — Step-2.5 pending | — |
| **CP-5a / 18.15a (pricing projection helper, providers)** | #31 | **APPROVED (Option B reshape), GREEN→Step8→Step9** — HOLD commit for sequencing | — |
| **CP-5b / 18.15b (wire config→cap, worker)** | #32 | pending (blocked on #31) | — |

## 👥 ROSTER (all LIVE; routing unchanged)
- **worker-impl3** (worker) — excellent implementer, catches real premise gaps every slice (FLAG-A shared-mapper, the reachability/arming-bundle gap). On **CP-3b** next.
- **integrations-impl** (providers) — sharp; its Context7 grounding caught the 2× pricing bug. On **CP-5a (Option B reshape)**.
- **contract-impl** — STOOD DOWN (lead confirmed; CP-2 needed no contracts change — BrokerCandidate is a providers type_alias importing the CP-1 type). Lead re-spawns only if a crossing-time schema refinement surfaces (see Finding A / owner Path B).

## 🔒 LOCKED DECISIONS / RULINGS you must carry
1. **Accessor convention (CP-2):** `BrokerCandidate` 3rd member = `{ kind:"agent_extraction"; extraction: AgentExtractionCandidate }`; worker reads `candidate.extraction.fields`. LANDED in CP-2a/CP-2b.
2. **CP-2 request leg:** resolve `AgentJob.outputSchemaId` → INLINE the schema (never a bare `{$id}` — Anthropic rejects `$ref`; L3), fail-closed `schema_unresolved`. LANDED CP-2a.
3. **CP-2b FLAG-A = REUSE the shared mapper** (`mapAcceptedMeetingExtraction` serves BOTH meeting :455 + source :812; L5). So **CP-3b does NOT re-implement the mapper** — it ONLY threads the source stub + source/ING-7 tests (see #30 metadata). Dead `extraction` param removed from both callers (FLAG-B).
4. **CP-5 = Option B** (single source of truth = config): 18.15a = a PURE `conservativeProviderPricing(perModelTable): TokenPricing` projection helper (element-wise MAX, fail-safe never under-count, empty-table fail-closed), fixture-tested. Pricing DATA + config staleness fix + maxCostUsd default + runtime-route handling ALL live in 18.15b (worker/config territory).
5. **Reachability posture:** CP-1/CP-2a producer + CP-2b reconstruction are reachability-WAIVERED (L11) — production reachability = the arming bundle (Finding C). The GATE-1 LOGIC is unit-proven (WITH evidenceRef ⇒ ok / WITHOUT ⇒ inferred_owner_or_date).

## 🔎 #13 CROSSING PACKAGE — 6 FINDINGS + 2 TODOs (canonical detail in task #13 metadata; owner-gated, LAST)
All surfaced DORMANT before spend — the round working as designed. Read #13 metadata verbatim; summary:
- **Finding A** (owner decision, load-bearing): CP-1 agent-extraction schema NOT Anthropic-structured-output-compatible (open `fields` record / `anyOf` / propertyNames). Candidate-data gate is the safety backstop regardless → flip-compatibility, NOT a safety hole. **Path A** (rely on candidate gate; my rec) vs **Path B** (build a §9 structured-output projection → contract-impl re-spawn). **Escalated to lead → owner.**
- **Finding C** (REQ-F-017 arming HARD-precondition): the arming slice is a COHERENT 3-PART BUNDLE — (1) switch job outputSchemaId→`sow:agent-extraction` (buildActivities:783), (2) register schema in CANDIDATE_MODEL_SCHEMAS (backends.ts:580/798), (3) bind NoInferenceView at broker (none today). Any subset alone = broken or REQ-F-017 hole.
- **Finding E** (spend-safety): config opus pricing 2× stale ($5/$25 vs Context7-live $10/$50). FIXED fail-safe in CP-5b. Owner verifies pricing current at flip.
- **Finding F** (spend-safety): `meeting.close.cloudPreferred` is a RUNTIME route (no `provider`) → dollar cap doesn't cover the primary route (runtime-seconds only). Owner decision at flip.
- **Finding B** (arming): existing claude-provider.ts:68 bare-`{$id}` — real transport must resolve→inline at arming.
- **TODOs:** projectRegistry.ts:79 slug in a reject (LOW rule-7, arm-time, L45); pricing-table sync (keep conservative max ≥ priciest configured model).
- **A/E/F escalated to the lead** for the owner (bundle into flip-prep; no AskUserQuestion needed yet). B/C/D + TODOs are build/arm-time preconditions in #13.

## 📝 WHAT YOU OWE
1. **Verify CP-2b committed** (git log / #28) — if mid-commit failed, re-route.
2. **Review CP-3b Step-2.5** (worker-impl3) — confirm scope stays (stub-thread only, no mapper re-touch); ING-7 route-through-admission pins (L47) + non-vacuous. security-reviewer MANDATORY.
3. **Review CP-5a reshaped Step-2.5** (integrations-impl, Option B projection helper) → then dispatch **CP-5b** (#32) to worker-impl3: config read + apply helper + **fix config opus $5/$25→$10/$50 + add fable-5** (Finding E) + owner-config-sourced maxCostUsd default + document the runtime-route gap (Finding F). E2E deny over the REAL assembled gate (L50); budgetBreachHealthItem redacted (rule 7).
4. **Sequence commits** on the shared checkout (worker vs providers = low collision; land one, other re-runs full suite). Only ONE at the gate at a time so far — easy.
5. **`/orchestrate-end`** at 7/7: doc-flush + tick CP slices + round commit + **push** (round-close). Then **ping the LEAD** "all 7 landed + gates verified — ready for the flip." Lead takes owner key-provision + arming (#13 bundle) + first spend. You do NOT provision/flip.

## 📄 DOC-ROUTING accumulated for /orchestrate-end (write hot into working tree, commit at round-close)
- **ARCHITECTURE.md §7/§19.5:** `BrokerCandidate` gains the `agent_extraction` 3rd union member (providers-internal; Appendix-A `sow:agent-extraction` row already exists from CP-1).
- **§19.5 arming runbook:** add the 3-part arming bundle (Finding C) + the CP-4 health-source caveat + the pricing/runtime-route notes (E/F).
- **LESSONS** (next # = **§54**): providers — resolve→INLINE→fail-closed structured-output request leg (L3 back-verify; candidate gate stays backstop); providers — conservativeProviderPricing element-wise-max fail-safe over the config single-source (Option B). worker — CP-7 rule-7 field-key-only pin; CP-2b faithful evidenceRef reconstruction closes the GATE-1 consumer (L46 was safe only dormant). Confirm each impl's `/session-end` proposals.

## ⚙️ HOW TO OPERATE (what's working)
- Per-slice /tdd: dispatch (brief path + `@<hash8>` spec-lint stamp) → Step-2.5 (`APPROVED.`/`TWEAK:`/`ADD:`) → GREEN → Step-7.5 (wiring flags) → Step-8 (security-reviewer MANDATORY + code-quality) → Step-9 commit-message-first + route flags/findings → Step-10 commit (impl stages only its files). **Briefs 128–131 authored (128 CP-2, 129 CP-3, 130 CP-5, 131 CP-7), all spec-lint PASS.** Next brief # = 132 if you need one (unlikely).
- **codegraph MCP** for live code; **Context7** for Claude/Anthropic wire shapes + pricing (the pricing bug proves: NEVER trust the skill-cache/memory for pricing). graphify = stale snapshot, broad-nav only.
- Route every Finding into **#13 metadata verbatim** (it's the canonical crossing store the lead reads at flip). Escalate owner-decisions/load-bearing/safety to the lead only.
- Terse SendMessage; status on the task board; don't nag (one send = the wake). Watch your own context — cycle again at a clean boundary if you approach ~30 turns.

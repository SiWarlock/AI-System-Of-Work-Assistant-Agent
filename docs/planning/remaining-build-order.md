# Remaining Build Order — SoW (proposed, owner-review)

**Authored:** 2026-07-25 · lead-synthesized from IMPLEMENTATION_PLAN.md @ `4a6ad8eb` · **status: PROPOSAL (not yet executing)**

Separates **buildable-now dormant work** (the real build queue, ordered by dependency + keystone value) from **owner-gated crossings** (arming *decisions*, not build order). At-risk "done" items get a verify-first step.

---

## A. Remaining-work inventory (by phase)

**Done phases with only minor residuals:** 1,2,3,4,5,6,8,10 (small; several are FailureClass-enum members → batch in ARC 2).

| Phase | State | Remaining (not-done) | Buildable now? |
|---|---|---|---|
| **7** | done | **7.19 retention-pruning — AT-RISK** (files confirmed absent; false-tick) | ✅ verify+rebuild |
| **9** | active | 9.9 Calendar (open) · 9.10 egress-ack+audit-link (partial, ⚠safety) · 9.14 renderer-isolation/redaction specs · 9.21 idempotent scaffold repair · 9.8/9.5 follow-ups · then **/phase-exit 9** (first desktop gate) | ✅ |
| **11** | active | 11.2 schema-refusal wiring (at-risk partial) · 11.5 install doctor · 11.6/11.7 packaging · 11.8 live sourceIngestion | ✅ mostly |
| **12** | active | 12.4–12.23 eval suites (several gated on real gbrain 0.35.1 = 12.7/12.22/12.23) | ✅ mostly |
| **13** | active | **13.3 local retrieval** · **13.5 typed Project model (frozen-contract)** · **13.8a–g living-vault synthesis** · 13.9 NotebookLM · 13.10c · **13.15 Task model+priority (frozen-contract)** · 13.16 priority read-model · 13.17 re-ranker · 13.2/13.4/13.13/13.14 extractor+research dormant | ✅ (13.8e sched = gated) |
| **19** | open | 19.1–19.11 gbrain write-back engines (dormant vs fake clients; real bind = §ARM-GBRAIN) | ✅ dormant |
| **21** | open | 21.1–21.4 write-registry (pure build); 21.5–21.10 (§ARM-21 gated) | ✅ 21.1–21.4 |
| **24** | open | 24.1 OS one-writer · 24.2 arming-guard tests · 24.3 health round-trip · 24.5 arming runbook (24.4 packaging needs 19+) | ✅ pure-build |
| **25** | open | 25.1–25.6 register/schedule output workflows (deterministic legs; schedule arming owner-gated) | ✅ deterministic legs |

**Gated phases (crossings, §B):** 17, 18-breadth, 20, 22, 23, 26.

**Phase 19–26 coverage (nothing dropped):** 19 = ARC 6 engines + §ARM-GBRAIN bind · 20 = §ARM-GBRAIN crossing · 21 = ARC 5 (21.1–4) + §ARM-21 · 22 = §ARM-GBRAIN crossing · 23 = ARC 5 (23.8 SPINE) + §ARM-23 pull · 24 = ARC 7 · 25 = ARC 5 (deterministic legs) + arming · 26 = ARC 3/5 dormant + §ARM-RESEARCH. Dormant machinery builds in the arcs; live arming is the crossing track (§C).

## Execution: PARALLEL across areas (owner-directed)
Arcs are a dependency skeleton, not a serial queue — run concurrently across areas; the ONE hard bottleneck is ARC 2 (frozen contracts) before any Task/Project-dependent work.
- **Wave 1 (parallel now):** contract → ARC 2 (bottleneck) ∥ desktop → ARC 1 ∥ worker → ARC 0 ∥ (retrieval 13.3 can start — no Task-model dep).
- **Wave 2 (ARC 2 sealed):** knowledge → ARC 3→4 keystone ∥ prov-int → ARC 5 ∥ worker → ARC 6/7 ∥ eval-security → ARC 6 suites.
Single working tree on `main`; parallel = concurrent implementers on DISTINCT areas (proven this session), `git add <path>` never `-A`.

---

## B. Proposed build order (buildable-now, dependency-honoring)

**ARC 0 — Integrity sweep (verify-first, small).** Rebuild **7.19 retention-pruning** (RET-1/REQ-F-018 — confirmed absent) + wire **11.2 startup schema-refusal**. *Why first: restore plan trust before building on it; both are small false-tick/partial repairs.*

**ARC 1 — Close Phase 9 → `/phase-exit 9`.** 9.9 Calendar · 9.10 egress-ack (⚠ lead-reviews design — touches rule-5 veto) · 9.21 repair · 9.14 adversarial specs · 9.8/9.5 follow-ups → **first desktop phase-exit gate.** *Why: active + closest to done; certifies the dashboard arc as a clean milestone.*

**ARC 2 — Frozen-contract foundation batch (forced-serial, do ONCE).** **13.5** typed Project model + **13.15** typed Task model+priority + **§DEC-CAT4 / FailureClass enum cluster** (`db_unavailable`, `provider_routing_unavailable`, `outbox/write_through` distinct members) — one schema-snapshot + repo-wide typecheck round. *Why early: frozen-contract changes disrupt everything downstream; batch them so the rest of the build lands on a stable contract.*

**ARC 3 — Retrieval foundation.** **13.3** local retrieval + eval harness (GBrain-aligned, recall@10 bar) + **13.17** re-ranker. *Why here: §13.8 synthesis + the Copilot both depend on good, measured retrieval — build + eval-gate it before the keystone leans on it.*

**ARC 4 — ⭐ KEYSTONE: §13.8 living-vault synthesis + task surfacing.** 13.8a EntityResolver → 13.8b LinkHealer → 13.8c confined planner → 13.8d ingest-rewrite → 13.8f meeting-path → 13.8g attendee→person; **13.16** priority-task read-model + "highest-priority tasks" surfacing. *Why: THE payoff — OSB parity (auto-link + entity-update) + intelligent connector behavior + a real task list + a genuinely useful daily brief. Depends on ARC 2 (contracts) + ARC 3 (retrieval). 13.8e scheduled-synthesis is owner-gated → §B.*

**ARC 5 — Dormant machinery build-out (behind the line, for later arming).** 13.2 extractor real-parse legs · 13.4 vault MCP · 13.13/13.14 research provider (dormant) · 21.1–21.4 external-write registry (pure build) · 25.1–25.6 output-workflow register/schedule (deterministic legs). *Why: builds every mechanism the owner-gated crossings later arm — no crossing to build them.*

**ARC 6 — Phase 19 dormant gbrain-write-back engines + Phase 12 eval completion.** 19.1–19.11 vs fake clients (real bind = §ARM-GBRAIN) · remaining 12.x suites (non-gbrain-gated). *Why: dormant parity/provenance/cost machinery + eval coverage; real binding is a crossing.*

**ARC 7 — Phase 24 pure-build hardening + Phase-exit sweep.** 24.1 OS one-writer enforcement · 24.2 arming-guard tests · 24.3 health round-trip · 24.5 Part-II arming runbook; then run **`/phase-exit`** on 11, 12, 13 to certify them. *Why: pure-build hardening + documents the safe turn-on order; late is fine.*

---

## C. Owner-gated crossings (DECISIONS, not build order)

These are arming events you confirm per-crossing — each unblocks live behavior once its machinery (built above) exists:

| Crossing | Unblocks | Machinery built in |
|---|---|---|
| **§ARM-17** Keychain provisioning | real secrets/HMAC everywhere | Phase 17 (done) |
| **§ARM-18** breadth | meeting.close live · eval-class runs | ARC 4 + Phase 18 |
| **§ARM-GBRAIN** | gbrain write-back live · serving-oracle (20) · propose (22) | ARC 6 |
| **§ARM-21** external write | first real external side-effect | ARC 5 (21.1–4) |
| **§ARM-23** per-vendor connectors | **Granola** & others live pull | ARC 5 + 23.8 |
| **§ARM-RESEARCH** | /research live · scheduled synthesis (13.8e) | ARC 3/5 + 13.8 |

**Count:** ~8 buildable-now arcs vs 6 owner-gated crossing tracks.

---

## D. Integrity caveats (re-check, don't trust the tick)
- **7.19** retention-pruning: files absent — ARC 0 rebuild (not a re-tick).
- **11.2** schema-refusal: partial, unwired — ARC 0.
- **10.x** residuals assert *production* behavior of dormant-built halves — re-check at a Phase-11 app-shell wiring wave / re-run Phase-10 exit.
- **9.6** real Copilot model + **13.11** agentic arc: partially live behind flags — treat as Copilot-arc follow-ups, not Phase-9-exit blockers.

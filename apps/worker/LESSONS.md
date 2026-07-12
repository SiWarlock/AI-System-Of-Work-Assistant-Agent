<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (control-plane worker (storage · Temporal · API))

> Full prose for every lesson logged during work in `apps/worker/`. The compact index lives in `apps/worker/CLAUDE.md` "Lessons logged" table.
>
> **Lesson numbers are stable IDs.** New lessons get the next sequential number. Numbers may be referenced from code comments, commit messages, and cross-references between lessons. **Don't reorder; don't reuse a deleted number's slot.**
>
> **Lessons start at §1.** Each code area has its own lesson sequence — lessons don't carry across code areas.

---

## Lesson format

```markdown
## <a id="N"></a>N. <Short topic> — <one-line rule>

**Date:** YYYY-MM-DD.
**Source slice:** <slice-id or commit hash>.

<2-5 paragraphs explaining: what was discovered, why it matters, how to
apply the rule, what edge cases are still open. Cite file:line references
where applicable.>

**Rule:** <one-sentence summary, same as the heading subtitle>.
```

---

## <a id="1"></a>1. On-request Copilot synthesis skills reuse a single-sourced governed core — never re-implement the gate

**Date:** 2026-07-12.
**Source slice:** C6 (b)-1 `b1048c3` (brief 040) + confirmed by (b)-2 `048d13e` (brief 041).

An on-request Copilot synthesis SKILL (Q&A, briefing, concept-synthesis, …) is a tRPC `.query()` procedure that **supplies its own retrieval** and then routes through the **one shared governed core** — never a re-implemented egress/gate. In `apps/worker/src/api/procedures/copilot.ts` that core is `runGovernedCopilotSynthesis(deps, workspaceId, question, scopedContext)` over `GovernedCopilotSynthesisDeps {synthesis, workspacePosture, routeSelector}`: WS-8 re-guard (`enforceRetrievalScope`) → authoritative server-side posture → route select → egress veto BEFORE synthesis → synthesize on the **veto-cleared route** (`decision.value.route`, never re-selected — the P1.2b binding) → `toUiSafeCopilotAnswer` candidate/UI-safe gate. `CopilotDeps` is just `GovernedCopilotSynthesisDeps` + `retrieval`.

What VARIES per skill is only the **retrieval source** and the **directive**; the safety machinery does not. Briefing (`copilotBriefing.ts`) supplies a `CopilotBriefingRetrievalPort` that assembles the §9.4 Today read-model into a `RetrievedContext` (already-UiSafe items + counts only — no-raw by construction) and a server-fixed `BRIEFING_DIRECTIVE`. Concept (`copilotConcept.ts`) reuses `CopilotRetrievalPort` (workspace knowledge) + a `CONCEPT_DIRECTIVE` framing — reusing the core so verbatim that `copilot.ts` was byte-unchanged (both Step-8 reviewers confirmed). Extracting the core once means the egress veto + candidate gate + WS-8 re-guard **cannot drift** between skills; adding a skill is a retrieval + a directive + a mount, reviewed against the same invariants each time.

Two corollaries worth keeping: (1) a skill with a **client-supplied** term (concept) carries the Q&A injection posture — bound it at the transport parser (`parseConceptInput`, ≤200 + single-line via a code-point guard, LESSONS Unicode-in-regex) — while a **server-fixed** directive (briefing) has a smaller surface. (2) When a retrieval reads a read-model whose **port** returns raw (e.g. `approvalInbox`→raw `Approval`), redact at the retrieval (read `.length` only), so no raw content enters the egressed `blocks` — no-raw *by construction* beats trusting a downstream projection.

**Rule:** an on-request Copilot synthesis skill supplies its own retrieval + reuses the single-sourced governed core (`runGovernedCopilotSynthesis`) — never a re-implemented gate; the retrieval source varies, the safety machinery does not.

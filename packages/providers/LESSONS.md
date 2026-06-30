<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (providers, policy & integration gateways)

> Full prose for every lesson logged during work in `packages/providers/`. The compact index lives in `packages/providers/CLAUDE.md` "Lessons logged" table.
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

## <a id="1"></a>1. Hermes empty toolset → full mutating fallback — read-only Hermes runs MUST pass an explicit minimal toolset

**Date:** 2026-06-30.
**Source slice:** Phase-0 spike 0.3 — Hermes adapter surface (`docs/spikes/0.3-hermes-surface.md`).

During the Phase-0 Hermes adapter-surface spike (run live against the installed Hermes 0.17.0 via OpenRouter/DeepSeek-V4-Pro), the bounded meeting-close mock confirmed Hermes can be driven as a one-shot CLI subprocess with controlled tools (`hermes chat -q <prompt> -Q -t <toolset> -m <model> --provider <p> --max-turns N`), and that `-Q` emits clean parseable JSON, stop/cancel works (a SIGTERM mid-inference exits 124 with zero stdout → nothing reaches the schema gate = COST-1 cancel-with-no-partial-side-effect), and `-t clarify` restricts the run to a minimal toolset.

The sharp caveat: Hermes's `oneshot.py` `_normalize_toolsets` returns `None` for an **empty** `-t`, which falls back to the user's **full configured toolset — including mutating tools.** So "I passed `-t`, therefore the run is contained" is **false** when the toolset is empty: an empty toolset is maximally permissive, not minimally. This directly threatens the ING-7 untrusted-content invariant (a job consuming imported/untrusted content must run read-only / no mutating tools) and the candidate-data gate (a mutating Hermes tool could create an external side effect outside the Tool Gateway envelope).

Apply this when wiring the `HermesRuntimeAdapter`: a read-only or untrusted-content (ING-7) Hermes run MUST construct an **explicit minimal toolset** (seeded at a known read-only set, e.g. `clarify`) and assert it is **non-empty** before dispatch; admission must reject a Hermes `AgentJob` whose resolved toolset is empty or whose `ToolPolicy.allowsMutating` disagrees with the passed `-t`. Open edge case: the toolset semantics are a Hermes-version-specific behavior (observed on 0.17.0) — re-verify against the pinned Hermes version in the §12 runtime-adapter conformance suite, and treat a version bump as a re-validation trigger.

**Rule:** A read-only / untrusted-content (ING-7) Hermes run MUST pass an explicit, asserted-non-empty minimal toolset; an empty `-t` silently falls back to the user's full (mutating) config toolset.

<!--
  TEMPLATE: docs/tdd-brief-template.md → write to docs/.
  The format orchestrators use to author /tdd briefs. The "Template format",
  "Where briefs live", "Why this format works", and the GENERAL pitfalls
  (don't-bundle-safety-critical, every-brief-has-a-Step-2.5-question,
  acceptance-criteria-as-behaviors, no-/session-start-in-briefs) are workflow
  machinery — keep VERBATIM. The worked example and the project-specific pitfalls
  are EXAMPLE BLOCKs — keep them as labelled illustrations at bootstrap; the
  project swaps in its own as recurring pitfalls emerge. Delete this comment.
-->

# /tdd Brief — Template

> The orchestrator session uses this template to author hand-offs to the implementer session. The implementer session reads the brief as context, then runs `/tdd <feature>` — the slash command's Step 0 (Restate) confirms the brief was parsed correctly; Steps 1–10 execute against the spec.

This doc is the canonical reference both sessions use:

- **Orchestrator** writes briefs in this format. The "Things to flag at Step 2.5" section is pre-loaded with design questions + default votes.
- **Implementer** reads the brief, runs `/tdd`, and at Step 9 surfaces categorized flags per the brief's "Lessons-logged candidates anticipated" section.

**TDD scope:** applies to deterministic code — code where a failing test can pin the behavior before the implementation exists. When a slice involves non-deterministic work (LLM-driven generation, pure visual changes), drop the `/tdd` brief in favor of the project's non-deterministic-coverage brief format (e.g. eval-fixture-first, or design-fixture-first).

Briefs scale down for trivial slices — drop sections that don't apply rather than truncating remaining ones.

---

## Where briefs live

Every `/tdd` brief is authored as a **file** in `docs/briefs/`, not just pasted ephemerally into the implementer session. Briefs are a permanent artifact — the design-decision audit trail for every slice the project has run.

**Naming:** `docs/briefs/NNN-<task-id>-<short-topic>.md` — e.g. `024-P3-2-payment-retry-logic.md`.

- **`NNN`** — a stable, zero-padded, sequential id on its own counter (parallel to `docs/sessions/`). Compute it the way session docs do: `ls docs/briefs/`, find the highest `NNN` prefix, increment. Numbers are stable IDs — never reused, never reordered. **Multi-track mode (the orchestrator carries a `<track>-` name prefix): prefix the filename with the track** — `docs/briefs/<track>-NNN-<task-id>-<topic>.md` — and compute `NNN` within the track (`ls docs/briefs/<track>-*`), so parallel tracks' briefs don't collide on merge (root `CLAUDE.md` "Naming + numbered-doc collision prevention").
- **`<task-id>`** — the `IMPLEMENTATION_PLAN.md` task this brief implements. Ties the brief to its phase.
- **`<short-topic>`** — kebab-case feature topic.

**Who writes + commits it:** the orchestrator authors the brief file; it rides the orchestrator's `/orchestrate-end` round terminal commit (`docs/briefs/` is orchestrator territory — the implementer never edits it). When a stale brief is refreshed for a re-run, **edit the existing file in place** rather than spawning a new number — the brief tracks the slice, not the attempt.

---

## Template format

```markdown
# /tdd brief — <feature_name>

## Feature
<one sentence: what's being built>

## Use case + traceability
- **Task ID:** <e.g. P3.2>
- **Architecture sections it implements:** <`ARCHITECTURE.md §X.Y`>
- **Related context:** <other docs / prior slices the implementer should know>

<!-- REQ IDs derive from the cited §s via the ARCHITECTURE.md Spec Anchor Index — add an explicit
     `Implements: REQ-x` line ONLY when overriding (one § maps to many REQs and this slice covers a
     strict subset). -->

## Acceptance criteria (what "done" means)
- [ ] <concrete behavior pin 1>
- [ ] <concrete behavior pin 2>
- [ ] All unit tests in `<path>` pass
- [ ] Integration test in `<path>` passes
- [ ] `/preflight` clean
- [ ] If applicable: cross-doc invariant updated atomic with the model change

## Wiring / entry point (Step 7.5)
<the production entry point this slice lands behind — route / job / CLI command / exported API — and
what calls the new code. If wiring genuinely belongs to a later slice, say exactly:
`none — wiring lands in <slice-id>`. `spec-lint brief` fails a brief without this section.>

## Files expected to touch
**New:**
- `<path>` — <what it does>

**Modified:**
- `<path>` — <what changes>

If implementation needs files beyond this list, **flag at Step 2.5** before going GREEN.

## RED test outline (Step 2)
Tests to write in `<test_path>`:

1. **`test_<name>`** — <one-sentence contract>
   - Asserts: <specific assertion>
   - Why: <pin to `ARCHITECTURE.md §X` or a LESSONS entry>

2. **`test_<name>`** — ...

## Cross-doc invariant impact (implementer flags at Step 9; orchestrator writes the docs)
- **Model field changes:** <none / list of contract models touched>
- **Orchestrator doc rows to write hot (Step 9 routing):** <none / which `packages/contracts/CLAUDE.md` cross-doc rows + `ARCHITECTURE.md` Appendix A rows the orchestrator authors atomic with the round>
- **§2.5-seam (shared-contract) model touched?** If this slice's NEW/extended invariant touches an
  Appendix-A model whose `§` is crossed by a `§2.5` dependency edge, the RED outline MUST include the
  **schema-snapshot test** (model field-name set == checked-in snapshot, tagged `spec(§X)`) — the
  implementer authors it in this same `/tdd` cycle; Step 2.5 reviews it like any test.

> **Orchestrator territory** (canonical list: the `packages/contracts/CLAUDE.md` "must NOT touch" list — hook-enforced in team mode): flag at Step 9 categorized; the orchestrator writes hot during the same session and commits at `/orchestrate-end`.

## Things to flag at Step 2.5
Open design questions the implementer should surface before going GREEN. Pre-loaded with default votes — the implementer can take defaults or ping back with disagreement.

1. **<Question>.** <Two or three plausible answers.> My default vote: **<recommendation>**. <one-sentence rationale>.
2. **<Question>.** ...

## Dependencies + sequencing
- **Depends on:** <prior slices that must have landed>
- **Blocks:** <future slices that need this>

## Estimated commit count

**Prefer bundling when safe** — default to 2-4 related tasks per slice when bundling makes sense. A "slice" is one focused feature OR a small bundle of related features that share a commit. Bundling saves time + reduces Step-2.5 review overhead + commit verbosity without losing rigor.

**Bundle when ALL apply:**
- All features touch the same code area
- Total size is manageable (rough heuristic: < 100 lines added, < 30 min of TDD work)
- Features share context (similar setup, related concepts, overlapping test files)
- None of the features touch a safety invariant (per root `CLAUDE.md` "Key safety rules")
- Bisectability stays meaningful (the bundle is one logical unit)
- A reviewer can grok the whole thing in one sitting

**Do NOT bundle when ANY apply:**
- A safety-critical pin is in the slice (gets its OWN commit, always)
- Cross-area work
- Features have conflicting Step-2.5 design questions
- Each feature is large on its own (≥ 30 lines added each)
- Features have independent caller bases and might be cherry-picked separately
- A cross-doc invariant change is involved (atomic doc-edit pairing wants traceability)

Examples:
- ❌ DON'T: "add staleness check to oracle + add operator role to factory" (mixes safety invariants)
- ✅ DO: "add idempotency key + add retry helper + wire into payment handler" (3 related features, same module)>

## Lessons-logged candidates anticipated
Pre-bets the orchestrator is making about what Step 9 will surface.

- **Convention candidate** — <pattern likely to recur>
- **Future TODO — operational** — <perf/scaling consideration>
- **Architecture-doc note candidate** — <behavior consumers will depend on>

## How to invoke

> Do NOT prescribe `/session-start` here. Implementer sessions are reused across slices within a round — the session is already oriented. `/session-start` belongs only in the FIRST slice of a session, or after an explicit session swap. Jump straight to pre-flight checks + `/tdd <feature_name>`.

1. **Read this brief end-to-end.** Don't skip "Things to flag at Step 2.5" — design questions need answers before tests.
2. **Run `/tdd <feature_name>`** in the implementer session.
3. **Step 0 (Restate)** — confirm the restatement matches the Feature line.
4. **Step 1 (Identify files)** — confirm the file list matches Files expected to touch.
5. **Step 2.5 (test review pause)** — ping back with answers to the design questions (or take defaults). Don't proceed to Step 4 until orchestrator + user sign off.
6. **Step 9 (summarize)** — surface anything that didn't fit the anticipated lessons-logged candidates.
```

---

## Worked example

<!-- ▼ EXAMPLE BLOCK [id=tdd-brief-worked-example]: worked example — illustrative format reference, NOT project content. Replace with a worked example from this project once the first real brief lands, OR keep this one labelled as illustrative. ▼ -->

```markdown
# /tdd brief — payment_retry_on_transient_failure

## Feature
Implement payment-processor retry logic for transient failures (5xx, network
timeouts). Idempotent: same idempotency key produces at-most-one charge.

## Use case + traceability
- **Task ID:** P3.2
- **Architecture sections it implements:** `ARCHITECTURE.md §4.3` (payment
  retry semantics), §4.5 (idempotency keys)

## Acceptance criteria
- [ ] `chargeWithRetry(charge, idempotencyKey)` returns success on first-try success
- [ ] Retries 3× on 5xx / network timeout with exponential backoff (1s, 2s, 4s)
- [ ] Does NOT retry on 4xx (client error — caller's fault)
- [ ] Same idempotency key on retry produces at-most-one charge (server-side idempotency)
- [ ] All retry attempts log with the idempotency key for audit
- [ ] **Reachable from** `app/api/charge.ts` POST `/charge` handler — invoked on the real path
- [ ] `/preflight` clean

## Wiring / entry point (Step 7.5)
HTTP route `POST /charge` (`app/api/charge.ts:handleCharge`). Confirm the new
`chargeWithRetry` is called from there — not just from tests.

## Files expected to touch
**New:**
- `app/payments/retry.ts` — retry logic
- `tests/unit/payments/test_retry.test.ts`

**Modified:**
- `app/api/charge.ts` — replace direct `charge()` call with `chargeWithRetry`

## RED test outline (test/unit/payments/test_retry.test.ts)
1. `charge_with_retry_succeeds_first_try` — Asserts: returns success after 1 call. Why: `#payment-retry` happy path.
2. `charge_with_retry_5xx_then_success` — Asserts: 1 retry, returns success. Why: §4.3 transient-failure retry.
3. `charge_with_retry_4xx_no_retry` — Asserts: 0 retries, returns failure. Why: §4.3 explicit no-retry on 4xx.
4. `charge_with_retry_exhausts_max_retries` — Asserts: 3 retries, returns failure. Why: §4.3 retry cap.
5. `charge_with_retry_idempotency_key_unchanged` — Asserts: all retries use same key. Why: §4.5 server-side idempotency.

## Cross-doc invariant impact
- **Model field changes:** none (uses existing `Charge` model)
- **Orchestrator doc rows to write hot:** none new; confirm `#payment-retry` row in cross-doc table still pins the right test path.

## Things to flag at Step 2.5
1. **Backoff formula — exponential or linear?** Default: exponential (1s, 2s, 4s). Default vote: **exponential** — matches §4.3 spec.
2. **Network-timeout detection — by error code or by elapsed time?** Default: by error code (`ETIMEDOUT` / `ECONNRESET`). Default vote: **by error code** — more deterministic than wall-clock.

## Dependencies + sequencing
- **Depends on:** P3.1 idempotency-key generation (landed).
- **Blocks:** P3.3 webhook delivery retry (will reuse `retryWithBackoff` helper).

## Estimated commit count
**1.** Focused retry logic — payments handler is one concern.

## Lessons-logged candidates anticipated
- **Convention candidate** — "Retry only on transient failures; 4xx is caller error and bypasses retry."
- **Architecture-doc note candidate** — clarify §4.3 retry-cap behavior on exhaustion (returns failure, not throws).
```

<!-- ▲ END EXAMPLE BLOCK [id=tdd-brief-worked-example] ▲ -->

---

## Why this format works

- **The brief lives outside the slash command's prompt loop.** It's context the implementer reads before invoking `/tdd`. Step 0 becomes the *check* that the brief was parsed correctly, not the *source* of the spec.
- **Step 2.5 design questions are pre-loaded.** Without them, the implementer either makes unilateral decisions or pauses Step 2.5 to ask. Pre-loading 3-4 plausible questions with default votes lets the implementer take defaults (fast path) or ping back with real disagreement (slower but correct).
- **Cross-references inline.** The implementer can look up underlying findings without navigating whole docs.
- **Acceptance criteria are concrete behaviors, not abstractions.** "Confidence <0.7 escalates" is testable; "the judge is reliable" is not.
- **Cross-doc invariant impact named explicitly even when "none."** Forces the orchestrator to actually check.

The format scales down for trivial slices by dropping sections that don't apply — not by truncating remaining ones.

---

## Common pitfalls (orchestrator self-check before handing the brief over)

### Pitfall — Bundling / atomizing wrong (criteria in "Estimated commit count")

- **Safety-critical pin bundled with other work** — every safety-critical slice gets its OWN commit; flag it in "Estimated commit count" when an acceptance criterion is a safety pin.
- **Over-atomizing** — three 10-line helpers as three briefs / reviews / commits when they're one logical unit. Default posture: **bundle when safe, atomize only when required**; a bundled brief lists each feature's RED tests and ends in one Step-10 commit.

### Pitfall — Skipping Step 2.5 design questions because the brief "felt small"

Symptom: a brief omits "Things to flag at Step 2.5" because the slice is "obvious." The implementer then makes ≥3 design decisions silently during GREEN — the orchestrator finds out at Step 9 with no review opportunity.

**Rule** — every brief has at least one pre-loaded Step 2.5 question even when the slice feels trivial. If you can't find a real design question, the slice is probably implementing something already-decided and doesn't need a brief at all.

### Pitfall — Acceptance criteria phrased as abstractions instead of behaviors

Symptom: "the parser is robust" / "storage is performant" / "the API is well-designed." Not testable.

**Rule** — every acceptance criterion is a concrete behavior pin: "filter-by-category returns the subset," "round-trip preserves equality." If you can't write a test for it, it's not an acceptance criterion.

### Pitfall — Prescribing `/session-start` in "How to invoke"

The implementer reuses its session across a round's slices — it's already oriented. "How to invoke" jumps straight to `/tdd <feature_name>`; include `/session-start` only for the first slice of a session or after a swap. (Stated in the template's "How to invoke.")

<!-- ▼ EXAMPLE BLOCK [id=project-specific-pitfalls]: project-specific pitfalls — the source project accreted several more pitfalls unique to its domain (contract-type placement, model-ID verification against live catalogs, matrix-driven brief file-list reconciliation, agent-existence ≠ pipeline-readiness). Add the project's own recurring brief-authoring mistakes here as they emerge — each one is cheap insurance against a repeat. ▼ -->

<!-- ▲ END EXAMPLE BLOCK [id=project-specific-pitfalls] ▲ -->

---

## When NOT to use a /tdd brief

The brief is for **TDD slices** (deterministic code). Skip (or use a simpler hand-off) for:

- **Pure documentation work** (`IMPLEMENTATION_PLAN.md` edits, `ARCHITECTURE.md` prose, session docs). Just edit directly.
- **Infrastructure / deploy work.** Use `docs/runbooks/` instead.
- **Exploratory spikes** to learn an API. Mark as exploratory; throw away; then TDD the real implementation.
- **Non-deterministic behavior** (LLM-driven generation, pure visual changes). Use the project's non-deterministic-coverage brief format instead.

Outside these cases, brief in this format. Every time.

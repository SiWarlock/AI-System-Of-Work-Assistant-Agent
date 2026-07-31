# Session 145 — contract track: audit-drill summary shape (9.41 leg A), pure-root-scan equivalence guard (13.22), list-valued extraction fields (13.8g-C leg A)

- **Date:** 2026-07-30 / 2026-07-31
- **Phase / arc:** three independent slices, all contracts-territory (or contracts+domain test-only): the 9.10-D audit-link sub-arc (promoted to `### 9.41` mid-round), a 13.20 residual (13.22), and the 13.8g-C list-valued-extraction-fields arc (leg A of contracts → worker → knowledge)
- **Role:** contract-implementer (single-track `main`)
- **Predecessor session:** [132-2026-07-29-entityref-contract-and-pure-root-boundary.md](132-2026-07-29-entityref-contract-and-pure-root-boundary.md) (my predecessor shipped no slice this round — held all round by lead ruling — so 132 is the last real contracts session doc; doc 137 was deliberately left unassigned rather than a lost document)
- **Successor session:** _TBD (team cycling down for a machine restart; I am not cycling, holding idle)_

## Why this session existed

Fresh session after a full team teardown (handoff 019). 9.10-D leg 1 (audit-link) was released once 9.36 landed on worker's side. Over the session the orchestrator also dispatched a scaffolding-backlog residual (13.22, from 13.20's own reviewer-deferred gap) and, later, the contracts leg of a three-area arc (13.8g-C) resolving a real contradiction in the codebase about whether an extraction field can be list-valued.

## What was built (3 slices, 3 commits, all on `main`)

### #3 (task 9.41 leg A) — the audit drill-down summary shape — `bd73d4ea`

**Files modified:** `packages/contracts/src/api/ui-safe.ts` (new `UiSafeAuditDrillSummary` interface + `.strict()` schema + `_uiSafeParity` entry + `UI_SAFE_ALLOWLIST.auditDrillSummary` entry) · `packages/contracts/test/api/ui-safe.test.ts` (new `PROJECTIONS` table row + 2 bespoke tests, later relocated into the file's own `── Behaviors` section per a code-quality finding).

One new UI-safe projection carrying exactly `event` + `occurredAt`, so a future worker drill-down resolver (leg B) has a contract to return and `auditRef` never gets a representation on the wire at all — the lead's 2026-07-29 arc ruling: an audit link's value is provenance, not contents, because the renderer already shows the change. Two Step-2.5 findings changed what shipped: (1) ui-safe types follow their own lighter convention (interface + `.strict()` schema + `_uiSafeParity` + sorted allowlist + a `PROJECTIONS` table row — no `schemas/*.schema.json`, no `.snap` file, no `registry-all` registration), which retired one of the orchestrator's own acceptance bullets as a would-be false-green; (2) `AuditRecord.event` is an `arch_gap`-documented open string, so the new `event` field uses the shared `uiSafeToken` bound rather than inheriting an unbounded string.

Security-reviewer clean pass; code-quality-reviewer found one low (test misplaced relative to the file's own section convention), fixed in-slice.

**Downstream (confirmed this session, after my leg A landed):** leg B (worker, `aa949ee7` "resolve the 9.41 audit-drill changeId server-side") and leg C (desktop, `3640c0e4` "resolve a Recent Activity row's audit drill") both landed later in the round — the arc is closed end-to-end (`b6421a56`). My original Step 7.5 scoped claim ("nothing returns it yet — leg B") is now superseded by the arc's completion; noting the update rather than leaving a stale claim in the historical record.

### #6 (task 13.22) — pin the two `pure-root-scan.ts` copies as equivalent — `a7323fa6`

**Files modified:** `packages/domain/test/boundary/pure-root.test.ts` (one new `existsSync` import, one new `describe` block appended after the existing suite).

Closed 13.20's own reviewer-deferred residual: nothing previously asserted that `packages/contracts/test/_helpers/pure-root-scan.ts` and `packages/domain`'s byte-identical duplicate of it stay identical, so a scanner bug fixed in one copy and not the other would let `packages/domain`'s boundary test keep passing against a silently-weaker scanner. One test: path-distinctness + both-files-exist + content byte-identity, in that order.

Went through two Step-2.5 rounds. First round: I flagged that the brief's literal "mutate on disk, watch RED, revert" acceptance criterion conflicted with 13.20's own established precedent against transient on-disk mutation on a shared, concurrently-worked checkout (three implementers were live). The orchestrator's `ADD:` resolved it with a better design — path-distinctness + `existsSync` close the only real vacuity mode ("comparing a file to itself") structurally, making the mutation genuinely unnecessary rather than merely risky. Second round (Step 8 → Step 9): the security reviewer found something the orchestrator had privately considered and dropped during the `ADD:` — the distinctness check is lexical, not filesystem-identity, so a symlink aliasing the two paths would defeat it. Recorded in-code as a stated bound rather than an implicit gap, plus a forward-looking "delete this test, don't retarget both reads at one path" note so a future dedup doesn't regenerate the defect through its own remedy.

Both reviewers ran clean (security: 0 findings; code-quality: 2 low, both non-blocking).

### #12 (task 13.8g-C leg A) — declare list-valued extraction fields, default-closed — `5eaf33f5`

**Files modified:**
- `packages/contracts/src/models/agent-extraction.ts` — container swap (`z.record` → `z.object({attendees, decisions}).catchall(scalarField)`), a `z.preprocess`-based Zod-side reserved-key guard (`rejectReservedKeys`), `LIST_VALUED_EXTRACTION_FIELDS` (the single source of list-ness) and `LIST_VALUE_MAX_ITEMS = 200`. `AgentExtractionCandidateField` renamed to `AgentExtractionCandidateScalarField` (see Decisions).
- `packages/contracts/src/schema/emit.ts` — a `guardCatchallPropertyNames` policy on the shared `emitJsonSchema`, unconditional but confirmed inert for every model except this one; a named, uncovered `.passthrough()` sibling-hazard note.
- `packages/contracts/schemas/agent-extraction.schema.json` — regenerated (`UPDATE_SNAP=1`), never hand-edited.
- `packages/contracts/test/models/agent-extraction.test.ts` — 14 new tests for the list-capable shape.
- `packages/contracts/test/schema/emit.test.ts` — new file, 5 tests (policy fires on real catchall / inert for `.strict()` / inert for plain object / inert for `z.record` / a both-anchored census of every `.catchall(` call site under `src/models`+`src/provider`).

A scoped, declared, default-closed relaxation of a rule-2 candidate-data gate: exactly `attendees` and `decisions` may carry a bounded `string[]`; every other field keeps today's scalar-only rejection. Default-closed falls out of JSON Schema's own `properties`-wins-over-`additionalProperties` precedence, which answers "can a candidate declare its own list-ness?" by construction — a payload cannot add itself to a schema's declared keys.

The brief named one hazard (`.catchall()` drops ajv's `propertyNames`). Empirical investigation — building the proposed shape in isolation and driving it through the repo's real `zod-to-json-schema`/`ajv` versions before touching production code — found two more: `.catchall()` also drops Zod's *own* key-schema check, and more seriously, Zod's internal object/catchall reconstruction *silently drops* a genuine `__proto__` own-key during parsing rather than rejecting or preserving it — the exact ajv↔Zod parity gap the original model was built to close, re-opened by the naive container swap. All three are restored: the container shape (declared keys + catchall), a `preprocess` guard that inspects raw input before Zod's own reconstruction can drop a key, and the `emit.ts` policy restoring `propertyNames`. The orchestrator's correction, worth preserving: the existing reserved-key tests would have caught a naive migration *loudly* (all three go red) — the silent part is Zod's drop itself, not the migration's visibility; the prior security review's guard was doing its job.

Ran repo-wide typecheck across all 11 packages (not just contracts) to confirm zero blast radius outside `packages/contracts` — leg B (worker) and leg C (knowledge) untouched. security-reviewer was mandatory here (rule-2/frozen-contract) and ran adversarially — executed disposable probes reproducing the actual hazards rather than a prose-only read — 0 critical/high/medium, 3 low (all `defer`, all recorded: `.passthrough()`'s uncovered sibling hazard, the census's narrower-than-the-guard's-actual-scope note, and a pre-existing per-element string-length gap this slice extends by cardinality but didn't introduce). code-quality-reviewer found 2 medium: a comment typo (fixed) and the `AgentExtractionCandidateField` naming mismatch (see Decisions). The orchestrator ruled both before Step 10; both applied and re-verified green before committing.

**Downstream (confirmed this session):** leg C (knowledge, `b0319823` "pin the attendees declared-list ↔ normalizeAttendees correspondence") landed and is ticked. **Leg B (worker gate honoring the declaration) has NOT landed** as of this session's end — confirmed via `git log` (no commit touching `apps/worker/src/composition/meeting-extraction.ts`'s `isPrimitiveOrTbd` gate since leg A). My original Step 7.5 scoped claim stands: *the schema declares list-capable fields; the worker gate does not yet honour the declaration.*

## Decisions made

- **Ui-safe types follow their own convention, not the Appendix-A 4-file recipe** (9.41 leg A) — established by three independent negatives (no ui-safe `schemas/*.schema.json`, no `emitJsonSchema` call site, no `.snap` file for any of the 16 prior ui-safe types), not by analogy.
- **Byte-identity, not behavioral equivalence, for the pure-root-scan pin** (13.22) — `scanPureRootViolations` takes every package-specific input as an argument with zero internal branching, so there is no legitimate tolerance to allow.
- **Structural vacuity-closure over on-disk mutation** (13.22) — the orchestrator's `ADD:`; recorded in-code as a deliberate reversal of the brief's own literal acceptance criterion, with the reasoning why kept next to the code rather than only in chat history.
- **`.object().catchall()` + `preprocess` + a shared `emit.ts` policy, not `.catchall()` alone** (13.8g-C leg A) — the only construction verified (by execution) to preserve all three guards the naive container swap would have dropped.
- **Element cap of 200, minted independently, not shared with `packages/knowledge`'s `MAX_ATTENDEE_ENTRIES=2000`** (13.8g-C leg A) — different threat models (structural admission at the candidate gate vs. parsing-cost at the normalizer), per worker L88's discipline for when two caps must NOT share a constant; also structurally moot to share since contracts cannot import knowledge regardless.
- **`AgentExtractionCandidateField` renamed to `AgentExtractionCandidateScalarField`, no speculatively-widened sibling type added** (13.8g-C leg A, orchestrator ruling) — the type was always `z.infer` of the catchall (scalar-only) value schema; accurate before the slice, silently wrong for `attendees`/`decisions` after. Zero consumers today (grepped repo-wide); leg B exports what it actually needs when it states its shape, rather than this session guessing ahead.
- **`.passthrough()` named as an explicitly uncovered sibling hazard in `emit.ts`** (orchestrator ruling, contracts L96's prescription) — a guard must name what it cannot classify, or an implying-coverage comment becomes the defect.

## Decisions explicitly NOT made

- **Whether `UiSafeAuditDrillSummary` gets an `ARCHITECTURE.md` Appendix-A row.** I raised the question rather than assuming an answer; the orchestrator corrected their own brief's unqualified instruction ("write an Appendix A row" would have implied frozen-seam status) and said they'd follow the `UiSafeCopilotAnswer` precedent (a row explicitly labeled "a UI-safe projection, NOT a frozen seam"). **Confirmed at session-end: this has not yet been written** (no match for `UiSafeAuditDrillSummary`/`auditDrillSummary` anywhere in `ARCHITECTURE.md` or `packages/contracts/CLAUDE.md`, working tree clean). This is orchestrator territory, correctly routed at Step 9 and acknowledged — carried forward as an open follow-up below, not a violation on my part.
- **The `EntityRef` readonly convention question** (surfaced by the orchestrator as explicitly not mine) — owner-ruled Option C, routed to knowledge as task 13.21, landed there with zero `packages/contracts` file changes.
- **Whether the census in `test/schema/emit.test.ts` should widen its scope beyond `src/models`+`src/provider`** — security-reviewer confirmed the actual guard (the `emitJsonSchema` policy) doesn't depend on the census's completeness, so this is a low-severity footnote, deliberately left as-is rather than gold-plated.

## TDD compliance

Clean across all three slices — no violations.

- **9.41 leg A:** Step 2.5 test-design write-up sent and approved *before* implementation; RED confirmed (5 new tests failed on missing exports, 116 pre-existing tests unaffected); then GREEN.
- **13.22:** test-only slice. Two Step-2.5 rounds (one `ADD:`) before any test code was finalized; the shipped design deliberately has no RED-by-mutation step, per an explicit, approved, in-code-documented design decision (see Decisions) — not a skipped TDD step, a different verification mechanism substituted for it by mutual agreement, with the reasoning recorded rather than silently omitted.
- **13.8g-C leg A:** Step 2.5 write-up (with an honest RED accounting — 5 of 13 new tests failed for the right reason, 8 passed already as regression guards for a not-yet-broken behavior, stated plainly rather than dressed up as full discriminators) approved before implementation; RED confirmed; then GREEN.

## Cross-doc invariant audit

Two Appendix-A models had field-shape changes flagged at Step 9 this session:

- **`AgentExtractionCandidate`** (13.8g-C leg A) — **verified discharged.** `ARCHITECTURE.md:778` and the `packages/contracts/CLAUDE.md` cross-doc table both carry the amendment (commit `7ee95eac`, same session), correctly stating it as a scoped/declared/default-closed relaxation, not a reclassification.
- **`UiSafeAuditDrillSummary`** (9.41 leg A) — **still open**, per the "Decisions explicitly NOT made" section above. Not a discipline violation (correctly flagged at Step 9, correctly acknowledged, correctly orchestrator-territory) — just genuinely not yet written as of this session's end.

## Reachability

- **9.41 leg A (`UiSafeAuditDrillSummary`):** originally NOT wired (leg B/C pending). **Now fully wired** — confirmed this session that leg B (worker resolver, `aa949ee7`) and leg C (desktop affordance, `3640c0e4`) both landed, and the arc is closed (`b6421a56`).
- **13.22:** not applicable — test infrastructure guarding two already-live boundary tests, no production entry point, no wiring owed.
- **13.8g-C leg A (list-valued fields):** NOT wired — confirmed still true at session-end. `AgentExtractionCandidateSchema` is registered/reachable through the candidate-data gate's ajv registry (no new entry point), but the worker's `meeting-extraction.ts` gate does not yet read `LIST_VALUED_EXTRACTION_FIELDS` or honor the declaration. Leg B is the named, tracked, not-yet-dispatched consumer.

## Open follow-ups

- **`UiSafeAuditDrillSummary` Appendix-A row** — orchestrator territory; flagged at Step 9, orchestrator committed (in chat) to following the `UiSafeCopilotAnswer` "projection, not a frozen seam" pattern; not yet written as of session-end.
- **13.8g-C leg B (worker)** — the meeting-extraction gate needs to import `LIST_VALUED_EXTRACTION_FIELDS` and honor the per-field list declaration; not yet dispatched as of session-end (worker-implementer's active task this session was 13.8i-B, unrelated).
- **A residual note for leg B, from security review:** the declared list field's elements have no per-element string-length cap (only cardinality is capped at 200) — a pre-existing gap this slice extends by up to 200×, worth a cap if response size matters once leg B/broker output-normalizer are in the loop.
- **`.passthrough()` remains a genuinely uncovered sibling hazard** in `emit.ts`'s catchall policy — zero live uses today (grepped), named in-code so a future model reaching for it doesn't assume protection that isn't there.

## Preflight

Ran the reliable gates directly (this repo's established finding: `pnpm lint` is `tsc --noEmit` and is independently flaky at the `pnpm lint` entry point before turbo starts — never characterized as "lint clean" per house convention; no `format:check` script exists).

- **Repo-wide `pnpm typecheck`:** clean, all 20 tasks (build+typecheck × 10 packages) succeeded.
- **Repo-wide `pnpm test`:** 520 passed / 1 failed / 8 skipped test files; 7449 passed / 58 skipped / 8 todo tests. The one failure (`apps/desktop/test/bundle/main-bundle-resolution.test.ts`, an `electron-vite build` invocation) is **outside my territory** (desktop, unrelated to `packages/contracts`/`packages/domain`) and **confirmed transient**: a manual `npx electron-vite build` in `apps/desktop` succeeded cleanly, and re-running the test in isolation (`pnpm vitest run test/bundle/main-bundle-resolution.test.ts`) passed 4/4. Not a regression from this session's work.
- **`packages/contracts`:** 45 files / 803 tests green, `tsc --noEmit` clean.
- **`packages/domain`:** 18 files / 308 tests green, `tsc --noEmit` clean.

# Session 117 — ARC-4 keystone completion: 13.8f-A · g-A · j · k (knowledge)

- **Date:** 2026-07-26
- **Phase / arc:** ARC-4 §13.8 living-vault synthesis KEYSTONE — knowledge half COMPLETE (single-track `main`)
- **Role:** knowledge-implementer
- **Predecessor:** [114-2026-07-26-arc4-living-vault-keystone-13.8bcd-knowledge.md](114-2026-07-26-arc4-living-vault-keystone-13.8bcd-knowledge.md)
- **Successor:** _(none yet)_ — remaining ARC-4 work is worker-side (13.8f-B, 13.8g-B) + 13.8h/13.8l/13.8m

## Why this session existed

Complete the ARC-4 keystone chain's knowledge half: the meeting path (13.8f-A), the attendee→person producer (13.8g-A), and — from findings raised inside those slices — two safety closures on entity paths (13.8j, 13.8k). Fresh session from handoff 016.

## What landed

| Commit | Slice |
|---|---|
| `e596038b` | Dormancy-pin reframe — "zero importers" → "every importer is arming-gated" (unblocked worker brief 199) |
| `7ef30b59` | Pin false-positive fix — it fired on a doc comment that merely named the symbol |
| `d723a4fc` | **13.8f-A** confined meeting-path synthesis planner (dormant) |
| `7dfd03d3` | **13.8g-A** attendee → person-entity refs (dormant) |
| `6dc6c34f` | **13.8j** namespace entity stub paths — untrusted names could mint `index.md`/`log.md` |
| `3acb2e0b` | **13.8k** grounded-path shape invariant — every path entering the grounded set is validated |

Final state: **636 tests passing / 1 skipped (48 files)** in `@sow/knowledge`, typecheck + lint clean, repo-wide `turbo typecheck` 20/20. All new code dormant behind its own pins.

> ⚠ **INCOMPLETE: preflight failures.** Repo-wide `turbo lint typecheck test` is RED. **One failure is mine** — see "Preflight status" below. This session is not "ready" until it is resolved by the owning track.

## Decisions made

- **13.8f-A is stricter than the source path, deliberately.** `planSynthesis` doesn't ground region/frontmatter targets, so the meeting path gates them post-plan against `groundedPaths ∪ {meetingNotePath}`. A stub the planner mints from its *own* `candidate.entityRefs` is dropped unless the entity was also grounded deterministically. "The planner asked for it" is not grounding.
- **Receipt is PARTITIONED** (`plans` + `meetingNoteLinkMutations`) so 13.8f-B cannot double-write. No `meetingNoteFrontmatter` counterpart *by construction* — frontmatter is human-relevant, so KN-10 tiers it PROPOSE and it can never fold into the meeting's additive plan.
- **Q1 (b′) on bare-email attendees** — pass the address verbatim so it can still match a person note by alias, but suppress stub-minting for identifier-only refs. Chosen after correcting the brief's premise (below). Suppression derives from *which array a ref arrived in*, never from a ref field, so no input value can enable it.
- **Suspect display names DEGRADE, they don't drop.** `"Jane Doe (Platform Team) <jane@acme.com>"` is routine Teams/Zoom/Granola output; a hard drop lost her entirely. Degrading to identifier-only is safe by construction (can never mint a note) and recovers the alias match.
- **Namespace, never a denylist** (13.8j). `people/`/`projects/`/`concepts/`, fallback `entities/`. Complete-by-construction against every present *and future* structural filename. An unrecognized `kind` falls back to a namespace, never the root — a fail-safe that fails back to the vulnerable state is not a fail-safe.
- **Exact-match, no normalization** on `kind`. Coercing `"Person "` → `people/` would not just risk being wrong, it would destroy the signal that the producer misbehaved.
- **Refusal withholds, never sanitizes** (13.8k). Repairing a path invents a target the GBrain row never claimed.

## Decisions explicitly NOT made

- **Zod gates on candidate-data types crossing REASON** — raised to the lead, not decided here. Four findings this round share one shape (a field crosses the model boundary then is consumed as if its TS annotation constrained it; `EntityRef` has no schema at all). Closing the *class* is a contract-surface decision spanning contracts/knowledge/worker and needs owner sign-off.
- **Making the structural paths non-configurable** — `buildIndexSectionPatches`/`buildOpLogMutations` remain parameterized. Closed with a pin that no production caller overrides them rather than widening the slice.
- **Re-pathing `resolved` notes** — correctly refused: grounding matches on exact strings, so normalizing would break every match while looking like a successful guard.

## TDD compliance

Production code was **strictly test-first in every slice**, with RED confirmed for the right reason each time (missing module / TS7006 / unguarded behavior, never a typo).

Two honest ordering notes, both on **test-support** files rather than production code:
- `test/support/dormancy-pin.ts` (commit `e596038b`) was written immediately *before* its tests rather than after a RED. Disclosed at Step 9; orchestrator recorded it as acceptable, not a violation.
- `7ef30b59`'s predicate fix was driven by a live failure; the regression pin was added alongside the fix rather than before it.

**Four pre-existing assertions were updated** (13.8j) because they hard-coded pre-namespace paths. Verified independently by review that none were weakened: exact `toEqual` stayed exact, and the byte-identity pin stayed intact.

## Cross-doc invariant audit

**No Appendix-A model field changed in any slice.** Every touched type is knowledge-internal and not mirrored in `ARCHITECTURE.md`:
- `WithheldReason` — two members added (13.8k), composed from `GroundedPathRefusal`
- `GroundedPathRefusal`, `GroundedPathVerdict`, `AttendeeWithheldReason`, `MeetingRewrite*` — knowledge-local
- `MeetingRewriteInput.identifierOnlyRefs` — knowledge-local input type

Each slice flagged "Cross-doc invariant change: none" at Step 9 and the orchestrator confirmed receipt. No drift.

## Reachability

Every feature is **dormant by design** — arming-gated, with its own dormancy pin. Reachability claim, stated verbatim per brief at each Step 7.5: *exported from `packages/knowledge/src/index.ts`, exercised by its own suite over faked ports, and pinned dormant.*

- `rewriteVaultForMeeting` — no `apps/`/`packages/workflows/` importer (pinned)
- `normalizeAttendees` — same
- `stubNotePathFor` / `admitGroundedPath` — consumed internally by `planner.ts` + `meeting-rewrite.ts`; both callers dormant
- `rewriteVaultForSource` — sole importer is the worker's arming-gated composition site (`172f9aed`), unarmed

**This is a tested-but-unwired state on purpose**, not a gap. Production wiring is 13.8f-B / 13.8g-B.

## Open follow-ups

**Findings routed as tasks:**
- **13.8l** — the SOURCE path has **no grounded set at all**. `planSynthesis` output reaches the KMP and `touchedNotePaths` unguarded, so a model-proposed `patches:[{path:"index.md"}]` is stopped only by the worker adapter's realpath containment — which prevents **escape** but not **collision** with a writer-owned surface. This is the 4th door to the same invariant. Fix: apply `admitGroundedPath` to the source path's plan targets, in 13.8d. `grounded-path.ts`'s header is scoped to say so explicitly rather than over-promise.
- **13.8m** — **refusals reach nobody.** The receipt has no refusal channel, so a poisoned-row attack is byte-identical to a benign empty run and 13.8f-B cannot distinguish "refused" from "nothing to do" — against KN-7's "rejected *and audited*". A code-only `refusals: readonly GroundedPathRefusal[]` would close it (rule-7-safe, carries no paths).
- **13.8h** — `planSynthesis` resolves MODEL-supplied `candidate.entityRefs` with **no cap**, so a degenerate REASON output can drive an unbounded sequential GBrain read loop one layer below my caps. Also an §ARM-RESEARCH arming precondition.

**For 13.8f-B's author specifically:**
- The worker's realpath containment is bound to the **SOURCE** port only. When the meeting binding lands, `admitGroundedPath` is the *sole* path guard on that route unless an equivalent adapter ships alongside it.
- `groundedPaths` now carries attendee-derived slugs — **must not be logged unredacted** (rule 7).
- The merge contract is in `meeting-rewrite.ts`'s header: fold `meetingNoteLinkMutations` into the meeting KMP's `linkMutations`; leave `frontmatterUpdates: []` (the propose plan carries them).

**Smaller, documented:**
- `ingest-rewrite.ts` still carries 4 `as unknown as` laundering casts (the pattern I copied from and then removed in my own modules — `meeting-rewrite.ts` and `grounded-path.ts` have zero).
- The 13.8j/13.8k structural pins scan only `packages/knowledge/src`, but `stubNotePathFor`/`admitGroundedPath` are public via the barrel — a consumer in another package could re-derive inline, out of the pins' reach.
- Trailing space/dot is rejected whole-path but not per-segment (`"Logs /x.md"` admits). Harmless on APFS; a real bypass on a Windows/SMB-backed vault. **The Mac-first assumption is now load-bearing here and is written down at the predicate.**
- Case-insensitive structural matching refuses a legitimate lowercase `logs/note.md`. Accepted: availability-only, fails closed.
- The non-person attendee exclusion is **hygiene, not a privilege boundary** — Cyrillic homoglyphs (`Rооm 3`) still pass. Anyone who can inject an attendee string can already inject `"Jane Doe"`.

**Closed during the session:** the stub-minting duplication residual (planner vs meeting-rewrite) — 13.8j collapsed both onto one shared derivation.

## Preflight status — RED, and one failure is mine

`npx turbo lint typecheck test` → **37/42 tasks pass**; `@sow/evals#test`, `@sow/db#test`, `@sow/desktop#test/typecheck` fail.

### ⚠ `@sow/evals` — CAUSED BY 13.8j (mine). Cannot fix: eval-security territory.

`suites/synthesis/synthesis-reason.test.ts` → `safety_floor_100pct` fails on two corpus entries, invariants `create_paths` + `stubs_present`:

| entry | entityRef | corpus expects | now produces |
|---|---|---|---|
| `entity-create-stub` | `{name:"Payments", kind:"project"}` | `payments.md` | `projects/payments.md` |
| `stub-plus-newregion-auto` | `{name:"Widgets", kind:"concept"}` | `widgets.md` | `concepts/widgets.md` |

`packages/evals/corpora/synthesis/entries.json` pins the **pre-13.8j root-level** stub paths. The namespacing is the intended new behavior, so the corpus expectations are what need updating — `createPaths`/`stubPaths` gain the kind namespace. **I did not touch `packages/evals`** (eval-security track territory). Routed to the orchestrator as a blocker.

**Why this slipped through:** I ran repo-wide `turbo typecheck` after every slice — which stayed green, because namespacing changes a *value*, not a type — but I only ran the **knowledge** test suite, never repo-wide tests, until `/session-end`. A behavioral contract change across a package boundary is invisible to typecheck by construction.

This is **L70 again, one level up**: I verified the mechanism (my package green + repo types green) instead of the property (the repo is green). It is the same error the slice-level findings were about, and it survived four slices because the check I was running looked thorough.

### Not mine (needs separate triage)

- `@sow/db#test` — a migration-lifecycle test (`2.6/2.9 applyMigrations`). I touched nothing in `packages/db`.
- `@sow/desktop` — the tree carries another track's uncommitted `apps/desktop/test-dom/copilot-panel.test.tsx`; no `error TS` lines surfaced on an isolated run.

## How this was built — what generalizes

Two premise corrections changed what shipped, and both came from reading the code rather than the brief:
- The brief said an unmatched entity "lets the resolver withhold." It doesn't — `resolveEntity` returns `create_stub` on a no-match, so the recommended option would have *minted* `jane-acme-com.md` rather than degrading quietly. That's what produced option (b′).
- Task 13.8k was originally scoped as "add a guard at the resolver boundary" — a **construction/location** phrasing satisfiable while the invariant still failed elsewhere. Re-scoped to the invariant, and the reframing immediately surfaced a third route (`meetingNotePath`) neither side had enumerated.

**L70 (mechanism vs property) came out of this session and explains its two worst defects.** Twice a fix reintroduced the class it was closing:
- 13.8j's namespace lookup used an object literal, so `kind = "__proto__"` resolved through the prototype chain and the path landed back at the root.
- 13.8k's `admitInto` returned `true` for an already-grounded path, letting a stub be minted over a note the resolver had just confirmed exists.

Both times I verified the **mechanism** (namespace applied / guard called) but not the **property** (no root path reachable / nothing enters unvalidated) — and a reviewer asking "does it apply the namespace?" misses it identically. The same error appeared one level up in my own tests: the structural pin searched for the *construction* I had used (`grounded.add`) rather than the property, which is exactly why `new Set([...])` bypassed both the admission point and the pin.

**Second committed practice, learned at `/session-end` the hard way:** run repo-wide **tests**, not just repo-wide typecheck, before declaring a slice done — especially when the change alters a *value* that another package pins. Typecheck cannot see a behavioral contract crossing a package boundary, and `@sow/evals` consumes `@sow/knowledge` directly.

**Committed practice:** mutation-test any invariant pin *inside the slice that introduces it*. Two of mine looked correct on inspection and proved nothing — one vacuous (green with the guard deleted), one comparing source text (an unguarded write passed if its line matched a guarded one). Two extra runs, versus shipping a test that proves nothing forever.

**Process note for the team:** long inter-agent messages arrive compressed, and `headroom_retrieve` returns a *placeholder* rather than the original — so the recovery path fails silently. Two commit messages were faithfully reconstructed; a third was verified byte-identical by diffing the commit against a re-send. Short messages arrived intact, which makes "keep it short, send long ones alone" a grounded mitigation rather than a guess.

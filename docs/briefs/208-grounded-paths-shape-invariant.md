# /tdd brief — grounded_paths_shape_invariant (13.8k)

## Feature
Establish and pin the invariant that **every path entering `groundedPaths` is shape-validated, whoever produced it** — closing the resolved-candidate door to the writer-owned KN-12 structural surfaces without re-pathing legitimate resolved notes.

## Use case + traceability
- **Task ID:** 13.8k (`IMPLEMENTATION_PLAN.md` task 13.8k) · ⚠ **safety: untrusted input reaching writer-owned surfaces** · ⛔ **arming precondition (the 5th of six on the synthesis path)**
- **Architecture sections it implements:** `ARCHITECTURE.md §6` (KN-10 grounding, KN-12 structural parity), `§5` (WS-8), safety rule 1 (one writer)
- **Scope note — this brief widens phase scope because** the only out-of-set token is `§2.5`, the template's "shared-contract seam" section name, not a claimed anchor (real anchors §5/§6 are in phase 13's set).
- **Origin:** knowledge's 13.8j Step-9 Finding — and 13.8j is *correct* not to have fixed it there.

## ⚠ Read this framing before the acceptance criteria — the task was re-scoped once already
My first phrasing was *"add a path-shape guard on candidate rows at the resolver boundary."* The implementer correctly pointed out that this is a **construction/location** phrasing — the same L64 error one layer up. It would be satisfied by guarding `resolveEntity` while leaving any future producer free to put an unvalidated path into the grounded set by another route.

**The requirement is the invariant, not the guard site:** every path that enters `groundedPaths` is shape-validated, regardless of which code produced it. Implement it where that can be enforced **once** — the point where paths enter the grounded set — and pin it so a second, unguarded entry point fails the suite. If you find that the natural enforcement point is somewhere other than the resolver, that's a correct outcome, not a deviation.

**The concrete hole this closes:** `resolveEntity` returns `candidate.path` **verbatim** from the GBrain read, shape-guarded only as a non-empty string. So a poisoned candidate row carrying `path: "index.md"` (or `log.md`, or `Logs/<date>.md`) plus a faithfully-matching title resolves to it, lands in `groundedPaths`, and the model may then patch it — reaching the writer-owned navigation catalog and append-only op-log. 13.8j closed the *stub-minting* door by namespacing; this is a different route to the same invariant violation.

## Acceptance criteria
- [ ] A path targeting a writer-owned structural surface (`index.md`, `log.md`, `Logs/…`, and whatever else `markdown-vault/structural-files.ts` owns — derive the set from there, don't re-list it by hand) **cannot enter `groundedPaths` from any producer**.
- [ ] Shape-invalid paths are likewise refused: absolute paths, paths containing `..`, backslash/NUL/control characters, empty-after-trim, and anything not ending `.md` (confirm that last one against real resolved paths first — see Step-2.5 Q2).
- [ ] **Legitimate resolved paths are untouched** — a real note resolves to its exact stored path, unprefixed and unmodified, so every grounding match still works. This is the constraint that makes the naive fix wrong; 13.8j's `resolved_paths_unchanged` pin must stay green.
- [ ] A refused candidate **withholds** (the resolver's existing `withheld` path with a reason) rather than being silently dropped or sanitized into a different path — sanitizing would invent a target the GBrain row didn't claim.
- [ ] Enforcement lives in **ONE** place, with a **structural pin that a second unguarded entry point would fail** (mirror 13.8j's `path_derivation_lives_once` shape).
- [ ] Reason codes stay code-only — a withheld record must not echo the candidate path or title (rule 7; attendee/GBrain-derived content is untrusted).
- [ ] 13.8j's and 13.8f-A's suites re-run green; `/preflight` clean + repo-wide `turbo typecheck`.

## Wiring / entry point (Step 7.5)
No new entry point. Both synthesis modules stay dormant (`rewriteVaultForMeeting` importer-less; `rewriteVaultForSource`'s only importer arming-gated and unarmed). State that the dormancy pins still hold, and name the single enforcement point you chose.

## Files expected to touch
**Modified:** `packages/knowledge/src/synthesis/entity-resolver.ts` (likely, but the invariant decides) · possibly `synthesis/match-keys.ts` or a small sibling for the shape predicate · `packages/knowledge/src/synthesis/meeting-rewrite.ts` (⚠ AMENDED — see below) · `packages/knowledge/src/markdown-vault/structural-files.ts` (⚠ AMENDED — **now WRITE, not read-only**) · tests.

**⚠ TWO AMENDMENTS (2026-07-26, on the implementer's Step-2.5 findings — the brief tracks the slice, not the attempt):**
1. **`structural-files.ts` is a WRITE.** "Derive the owned-surface set from there" was unsatisfiable as written: the file exports no owned-surface constants — `buildIndexSectionPatches(indexPath, …)` takes the path as a CALLER ARGUMENT and `logsDir`/`pointerPath` are INLINE DEFAULTS. Add exported `STRUCTURAL_INDEX_PATH` / `STRUCTURAL_LOG_POINTER_PATH` / `STRUCTURAL_LOGS_DIR` **and have the builders consume them as their defaults**, so the constants become a genuine single source that both the builder and the guard read (predicate-lives-once applied to DATA). Known residual: because they are defaults, a caller could still pass a custom path the guard wouldn't know about — nothing overrides them in production today, so close it with a **structural pin that no production call site passes a custom value** (the dormancy-pin shape) rather than removing configurability.
2. **`meetingNotePath` is a THIRD route and is IN SCOPE.** It is caller-supplied and SEEDS the grounded set (`meeting-rewrite.ts:172`), so a meeting note "at" `index.md` lets the model patch the navigation catalog — the same violation via the one route that isn't a GBrain row. A slice scoped as an INVARIANT is incomplete if it leaves a known entry unguarded, so including it is the point, not scope creep. Re-run 13.8f-A's `@user`/WS-8/tier pins, since this is the second edit to that shipped file.

**Do NOT touch:** `packages/workflows/**`, `apps/**`, and all orchestrator-territory docs.

## RED test outline (Step 2)
1. **`structural_surface_path_cannot_be_grounded`** — Asserts: a candidate row with `path: "index.md"` / `"log.md"` / `"Logs/2026-07-26.md"` and a faithfully-matching title is WITHHELD, and no such path appears in `groundedPaths`. Why: the hole; KN-12 surfaces are writer-owned.
2. **`shape_invalid_paths_refused`** — Asserts: absolute, `..`-bearing, backslash/NUL/control-char, empty-after-trim candidate paths are all withheld. Why: a non-empty-string guard is not a path guard.
3. **`legitimate_resolved_path_is_untouched`** — Asserts: a real note's stored path resolves byte-identically (no prefix, no normalization, no re-derivation). Why: the constraint that rules out the naive fix — grounding matches on exact strings.
4. **`refusal_withholds_never_sanitizes`** — Asserts: a refused candidate yields a withheld reason, and no alternative/repaired path is emitted. Why: sanitizing invents a target the row never claimed (no-inference).
5. **`invariant_has_one_enforcement_point`** — Asserts (structural): paths enter `groundedPaths` through a single guarded path; a simulated second, unguarded entry fails. Why: this is what makes it an invariant rather than a patched call site — and it's the difference between closing the class and closing the instance.
6. **`withheld_reason_is_code_only`** — Asserts: the withheld record contains no candidate path/title fragment. Why: rule 7.
7. **`owned_surface_set_is_derived_not_relisted`** — Asserts: the guarded set traces to `structural-files.ts` rather than a local literal list. Why: a hand-copied list is the denylist-drift failure L64/L65 warn about; if `structural-files.ts` gains a surface, the guard must inherit it.

## Cross-doc invariant impact
- **Model field changes:** none expected — `EntityResolution` already has a `withheld` variant with reasons. If a new reason member is needed, that's a knowledge-internal type (not Appendix-A); mention it at Step 9.
- **§2.5-seam model touched?** No.
- **Orchestrator doc rows to write hot (Step 9):** `ARCHITECTURE.md §6` — the grounded-path shape invariant closing the resolved-candidate door, completing the pair with 13.8j's namespace construction.

## Things to flag at Step 2.5
1. **Where is the single enforcement point?** Candidates: inside `resolveEntity` before returning `resolved`; at the point the caller adds to `groundedPaths`; or a shared `admitGroundedPath` the resolver and any future producer must call. My default vote: **the shared admission function** — it's the only shape that makes the structural pin meaningful (there's something to prove everyone calls) and it survives a future producer. If you see a reason the resolver is genuinely the only possible entry forever, say so with evidence and I'll accept the narrower placement.
2. **Is `.md`-only safe to require?** Check real resolved paths first — if any legitimate grounded target is a directory, an attachment, or extensionless, requiring `.md` would break grounding. My default vote: **require `.md` only if the evidence supports it**; report what you find rather than assuming. I'd rather a narrower guard that's correct than a broad one that breaks resolution.
3. **Does the WS-8 foreign-workspace drop already cover part of this?** A poisoned row still has to pass the workspace re-gate. My default vote: **treat them as independent** — WS-8 answers "whose workspace" and this answers "what shape"; a same-workspace poisoned row passes WS-8 cleanly. Say so if you find they overlap more than that.
4. **Withheld reason granularity.** My default vote: a distinct reason for a structural-surface hit vs a generic shape failure, since the former is the security-relevant one and deserves to be greppable in the future. Keep both code-only.

## Dependencies + sequencing
- **Depends on:** 13.8j `6dc6c34f` (landed).
- **Blocks:** the synthesis-path arming crossing (5th of six recorded preconditions).

## Estimated commit count
**1.** Safety-touching ⇒ its own commit.

## Lessons-logged candidates anticipated
- **Convention candidate** — "Scope a follow-up by its INVARIANT, not by the guard site: a task phrased as 'guard X at Y' is satisfied by guarding Y while the invariant still fails elsewhere." (The implementer caught this in my own task phrasing — worth banking as the task-scoping form of L64.)
- **Convention candidate** — "A path that arrives from an external read is untrusted DATA even when its type is `string`; a non-empty check is not a shape check."
- **Architecture-doc note candidate** — §6: the grounded-path shape invariant + its pairing with 13.8j's namespace construction.

## How to invoke
1. Read this brief, especially the re-scoping framing — the invariant is the deliverable, not the guard location.
2. Run `/tdd grounded_paths_shape_invariant`.
3. Step 0 restate → Step 1 confirm the enforcement point → **Step 2.5 write-up + coverage map**.
4. Step 8: `security-reviewer` (**invariant**) + `code-quality-reviewer`.
5. Step 9: categorized flags + ship-ask.

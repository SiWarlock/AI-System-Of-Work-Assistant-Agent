# Session 053 — Phase 11.3 write-through enablement-refusal gate + region-marker neutralization

- **Date:** 2026-07-09
- **Phase:** 11 (GBrain pin/upgrade & write-through enablement) + Phase 6/9 §6 hardening
- **Team:** `session-f2673cd5` (orchestrator + implementer, single-track on `main`, autonomous build)
- **Predecessor:** [`052-2026-07-09-gate4-serving-phase11-doctor-meeting-createpatch.md`](./052-2026-07-09-gate4-serving-phase11-doctor-meeting-createpatch.md)
- **Successor:** _(next session)_
- **Round:** round 2 of this team session — 2 slices (`c4467ee`, `3daa0c8`); `/orchestrate-end` (orchestrator) pushes after this doc.

## Why this session existed

Continue the autonomous endgame. Two dispatches from the orchestrator:
1. **Phase 11.3** — the deterministic write-through enablement-refusal gate (the pure fail-closed AND that decides whether the per-workspace `writeThroughEnabled` flag MAY be flipped ON). Mirrors the install-doctor core-first/wire-later posture opened last round.
2. **Region-marker neutralization** — the cross-cutting hardening flagged at the meetingOutputs create-vs-patch Step-9: a `kw:region` marker string embedded in assistant content could forge/break a region boundary in `applyRegionPatch`.

## What was built

### Slice #5 — write-through enablement-refusal gate (`c4467ee`, task #5)

**Files created:**
- `packages/knowledge/src/gbrain/enablement/decide-enablement.ts` — pure `decideWriteThroughEnablement(inputs) → { enabled, refusals[] }`: a fail-closed AND over 6 INJECTED setup legs (pin-validated · divergence-clean · conformance-green · reindex-complete · embedding-key-present · no-stray-writer). `enabled` IFF every leg is EXPLICITLY satisfied; each unsatisfied/absent/malformed leg pushes its own DISTINCT refusal (never enabled-by-omission). All inputs optional ⇒ `{}`/partial fails closed. Strict `=== true`; each leg wrapped in a safe evaluator so a malformed leg value refuses rather than throws (§16). Reuses the built `pinValidatedForEnablement` pin leg + the whole `ParityReport` divergence leg — no version-compare rebuild.
- `packages/knowledge/test/decide-enablement.test.ts` — 25 tests (all-green enables · each-leg-distinct-refusal + fully-failing-pairwise-distinct + exact order · absent-leg-refused · empty-input-all-refused · PENDING-pin-refuses-via-reuse · purity + never-throws · per-boolean-leg truthy-not-true table · truthy-ParityReport).

**Files modified:**
- `packages/knowledge/src/index.ts` — barrel export of the new module.

### Slice #6 — region-marker neutralization (`3daa0c8`, task #6)

**Files created:**
- `packages/workflows/test/region-marker-neutralization.test.ts` — 17 tests (embedded open/close/foreign markers · case/whitespace variants · nested no-space/spaced/marker-in-id fixpoint · boundary-integrity compose→applyRegionPatch round-trip with a non-vacuous corruption control · create/patch byte-parity with an embedded marker · both-builders-share-one-helper · H1-title vector · idempotence · clean-content no-op · ReDoS regression).

**Files modified:**
- `packages/workflows/src/activities/projections/noteSlug.ts` — new shared `neutralizeRegionMarkers(content)` (single authority) + `REGION_MARKER_RE`; neutralize the H1 title in `composeProjectStatusNote`.
- `packages/workflows/src/activities/projections/meetingOutputs.ts` — `composeMeetingRegionBody` wraps its return in `neutralizeRegionMarkers`.
- `packages/workflows/src/activities/projections/projectSyncOutputs.ts` — `composeRegionBody` now exported (for testability, mirrors `composeMeetingRegionBody`) + wraps its return in `neutralizeRegionMarkers`.

## Decisions made

- **#5 two-gate design (deliberate, not duplication).** `decideWriteThroughEnablement` is the ONE-TIME flip-precondition gate (adds the setup legs divergence-clean + reindex-complete; fail-closed-on-omission); DISTINCT from the pre-existing `evaluateEnablementGate` (the RUNTIME continuous auto-revert gate — 9 all-required §12-GO legs, no parity, inside `resolveWriteThrough`). Documented in the file header. Shared legs consume the SAME upstream booleans ⇒ no leg logic can drift. _(This corrected the brief's verification note, which said "no composed decide predicate exists" — `evaluateEnablementGate` does exist; orchestrator routes the correction.)_
- **#6 neutralize at the INNER-body builders, not the noteSlug wrappers.** The SAME `regionBody` feeds both the NoteCreate (wrapped) AND the re-close NotePatch `newBody` verbatim; neutralizing only the wrappers would leave the patch `newBody` raw ⇒ create/patch divergence + boundary forgery on the next patch. So neutralization lives in `composeMeetingRegionBody`/`composeRegionBody` (the single source feeding both paths), keeping byte-parity.
- **#6 transform = escape leading `<!--`→`<\!--`, run to a FIXPOINT.** Visible + content-preserving (no deletion); idempotent; each pass strictly removes `<!--` occurrences ⇒ monotone-decreasing ⇒ terminates; peels nested markers. Post-condition: no substring matchable by the superset regex (⊇ `applyRegionPatch`'s exact `indexOf` + `parseSections`/`MARKER_RE`) remains.
- **#6 also neutralize the projectSync H1 title.** It sits OUTSIDE/BEFORE the region ⇒ a marker there would be the first `indexOf(open)` hit (equal forgery vector). The meeting title is already inside the neutralized region body.
- **#6 ReDoS-safe regex.** Leading `[\s/]*` (one linear class), NOT `\s*\/?\s*` — adjacent unbounded quantifiers straddling an optional backtrack QUADRATICALLY on a long whitespace run after `<!--` (measured 400K ws = 60s), a soft-DoS on this untrusted-content (ING-7) path. Fixed to ~1ms at 1M ws; still a superset of both consumer matchers.

## Decisions explicitly NOT made (deferred)

- **#5 real leg PRODUCERS + the flip + pin re-capture — bucket B / HITL (deferred-HITL ledger).** The §12 divergence suite / read-token-rejects-write conformance / full-reindex check / Keychain embedding probe / stray-gbrain-writer probe (several overlap the doctor's bucket-B collectors), the `writeThroughEnabled: true` flip, and the `config/gbrain.pin` re-capture. Built ONLY the deterministic gate.
- **#6 frontmatter marker-safety — out of scope (see Open follow-ups).** Deferred to a follow-up slice.

## TDD compliance

**Clean — no violations.** Both slices were test-first: RED confirmed before GREEN.
- #5: the new test failed on the missing module before `decide-enablement.ts` existed.
- #6: 15 of 16 tests failed (undefined `neutralizeRegionMarkers`/`composeRegionBody`) before the implementation landed.
- The #6 ReDoS fix + its regression pin were added during the Step-8 review refinement (within the TDD cycle), re-verified green — not a post-hoc test.

## Cross-doc invariant audit

**NONE this round.** #5 is local `@sow/knowledge` types (no Appendix-A seam, no snapshot/registry). #6 is pure string-composition hardening in `packages/workflows` (no contract/schema/snapshot). `git diff -- ARCHITECTURE.md` shows no field change owed. Confirmed with the orchestrator at both Step 9s.

## Reachability

- **#5 `decideWriteThroughEnablement`** — unit-reachable now; **unreachable-by-design (dormant)** in production until the (HITL) `writeThroughEnabled` flip path wires it. Documented waiver, as with the gate-4 serving oracle-core + the install-doctor engine. (Blocks: the per-workspace flip, HITL/deferred.)
- **#6 both region composers** — **LIVE.** `composeMeetingRegionBody` via the meeting-closeout projection; `composeRegionBody` via projectSync. Both reachable through the live drivers; the neutralization is exercised whenever assistant content embeds a marker string. No new unreachable surface.

## Open follow-ups

- **Step-9 routing (orchestrator, `/orchestrate-end` round-2 docs):** §13 two-gate arch-note (decide vs evaluate) · brief-005 verification-note correction · §6 region-neutralization arch-note · brief-006 file/function-attribution correction · 2 lessons candidates (pure-fail-closed-AND-over-injected-legs [may fold into lesson 8]; neutralize-at-inner-builder + fixpoint + linear-marker-regex ReDoS) · plan Log + reconcile.
- **Carry-forward FINDING `(origin: 2026-07-10)` — frontmatter marker-safety (out-of-slice, reviewer-surfaced, PRE-EXISTING + fail-closed-SAFE):** `checkOwnership` runs `parseSections` over the FULL note INCLUDING frontmatter; model-derived frontmatter copies (meeting title/decisions/attendees, project title) are serialized via `serializeScalar` (YAML-quote), which does NOT strip `<!--`. A marker-valued field stays a literal substring in the quoted YAML ⇒ `parseSections` could see a spurious frontmatter region ⇒ parse error ⇒ fail-closed write rejection. No human-content corruption, no boundary forgery. Recommended follow-up slice: neutralize the frontmatter copies OR make `serializeScalar` marker-safe. Orchestrator routes to Carry-forward.
- **#5 deferred-HITL ledger:** real leg producers + the `writeThroughEnabled` flip + `config/gbrain.pin` re-capture (all bucket B / owner-gated).

## How to use what was built

- `decideWriteThroughEnablement(inputs)` is the precondition gate a (future, HITL) per-workspace `writeThroughEnabled` flip path calls: refuse the flip on any refusal; the `refusals[]` name exactly which legs block it.
- `neutralizeRegionMarkers(content)` is the single authority for defusing content-embedded region markers — call it at the inner-body builder for any new region-wrapped note composer (feeds both create + patch newBody).

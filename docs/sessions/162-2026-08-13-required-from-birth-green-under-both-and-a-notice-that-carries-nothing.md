# Session 162 — required-from-birth, green-under-both, and a notice that carries nothing

**Date:** 2026-08-13 · **Phase:** 24 (hardening tail) · **Area:** `packages/knowledge` (knowledge-implementer, single-track `main`)
**Predecessor:** `161-2026-08-13-redaction-safe-producer-enumeration-24-45.md` (providers) · this area's prior session was `158-2026-08-12-gcl-denial-audit-persistence-24-33-and-24-44.md`
**Successor:** _(filled in by the next `/session-end`)_

**Commits:** `e1293226` (24.26 step 1) · `993f28e8` (24.45 pair, knowledge leg) · `e85953d3` (24.53)

---

## Why this session existed

The lead cycled at its own context tier, not at a work boundary, so this session opened mid-round with three queued knowledge items. Two turned out to be coupled to another area's in-flight work, and the third's brief prescribed an implementation that was itself the defect it warned about.

## What was built

**Files modified**

- `packages/knowledge/src/knowledge-writer/workspace-path-guard.ts` — added `makeEnforceWorkspacePathScope(exemptWorkspaceId: string): WorkspacePathCheck`, parameter **required from birth**; re-expressed the shipped `enforceWorkspacePathScope` as that factory applied to `LEGACY_UNPREFIXED_WORKSPACE_ID` so there is ONE implementation (contracts L39). Construction-time fail-fast on a blank exempt id. Corrected a stale `worker-host/index.ts:178` citation to `:185` (two sites).
- `packages/knowledge/src/index.ts` — **named** barrel export of `makeEnforceWorkspacePathScope` (deliberately not `export *`).
- `packages/knowledge/test/workspace-path-guard.test.ts` — 5 new tests; purely additive, every pre-existing line byte-identical.
- `packages/knowledge/src/gcl/projection.ts` — 24.55's do-not-delete note at the `isRedactionSafe` call with **both** of its filed reasons corrected; then 24.53's optional zero-argument `onRefused?` on `GclAuditPersistPort`, invoked on the refusal path with both sync-throw and async-rejection escapes closed.
- `packages/knowledge/test/gcl-projection.test.ts` — re-sourced the redaction-gate fixture so it is green under both 24.45 producer states; retracted in place the false "every real GCL-produced AuditSignal is safe by construction" claim; added 24.53's suite plus a real-chain pin.

## Decisions made

1. **The exempt-id factory takes its parameter as required from birth**, rather than optional-then-tightened. A parallel-add of a required API never has a window where the new surface is weak; expand/migrate/contract does.
2. **Barrel export is named, not `export *`.** `export *` would publish `LEGACY_UNPREFIXED_WORKSPACE_ID`, which 24.26's final leg deletes — converting an internal deletion into a breaking public-surface change. Without any export, step 2's only options were a hand-rolled duplicate predicate (the exact defect 24.26 removes) or a cross-territory write.
3. **The blank-exempt-id guard is a tripwire, not validation.** Recorded on corrected grounds after a security review refuted the original rationale: a blank id opens nothing (the empty-workspaceId fail-closed returns before the exemption comparison), so the reason is misconfiguration detection at the composition root, not hole-closing.
4. **24.45's fixture was re-sourced, not re-expected.** The unsafe value now arrives via the one raw interpolation 24.45 leaves untouched (`wsId === sourceWorkspace.id`), through a schema-valid workspace built by `defaultWorkspace`. Green under both producer states.
5. **24.53's refusal notice carries no signal-derived value at all.** `isRedactionSafe` scans six fields including `event`, and reports only a boolean — so on the refusal path at least one scanned field is unsafe and the function cannot know which. Zero-arity discharges the obligation by the **signature** rather than by convention.
6. **The notice is an injected optional port member, not a `console` write.** `packages/knowledge/src` has zero `console.` calls; this is library code and `boot.ts` is a composition root.

## Decisions explicitly NOT made

- **Validating the exempt workspace id against the known workspace set** (brief 271's option (c)). Deferred deliberately; filed as `### 24.61` as a precondition attached to a **trigger** — *before the id may be sourced from anything other than a compile-time constant* — rather than to a step number, per lead ruling.
- **Tightening the blank-id check to cover zero-width/format code points.** `.trim()` closes the ECMAScript whitespace class only; U+200B/U+2060/U+180E construct fine and clear `WorkspaceIdSchema`'s identical test. Recorded in-code as a known residual rather than fixed.
- **Fixing `apps/worker/src/boot.ts:585-591`.** Worker territory; routed, not touched.
- **Any `FailureClass` or health-item shape for 24.53.** Frozen-taxonomy fence held.

## TDD compliance

**Mostly clean, with two honest deviations — both in reviewer-driven hardening, both mutation-verified afterward.**

- `24.26` step 1 — CLEAN. 5 tests written first; RED confirmed on both axes (3 runtime failures + 3 `tsc` errors) before implementation.
- `24.45` knowledge leg — CLEAN in substance. The failing test already existed; the slice made it pass under both producer states without weakening it, verified by name in both worlds.
- `24.53` — CLEAN for the main feature (2 tests RED before the port member existed).
- ⚠ **DEVIATION 1:** the sync-throw guard on `onRefused` was implemented, then its test written. Self-caught while drafting reviewer prompts, not driven by a failing test.
- ⚠ **DEVIATION 2:** the async-rejection guard was implemented from the security reviewer's finding, then its test written.
- Both deviations were closed with mutation verification (remove the guard ⇒ the test reds), which establishes the same property a test-first ordering would have — but the ordering itself was not TDD, and it is recorded rather than smoothed over.

## Cross-doc invariant audit

**No action required.** The two models touched — `WorkspacePathCheck` (unchanged) and `GclAuditPersistPort` (gained one **optional** member) — are knowledge-local and appear in neither `packages/contracts/CLAUDE.md`'s cross-doc invariants table nor Appendix A. No `ARCHITECTURE.md` edit is owed. 24.26's final leg **will** owe one (`KnowledgeWriterDeps.workspacePathCheck` optional→required is a dep-surface change); flagged for that slice, not this one.

## Reachability

- `makeEnforceWorkspacePathScope` — **unreached by design** (24.26 step 1 of 3). Barrel-reachable from `@sow/knowledge` so step 2 (worker) can bind it. The shipped `enforceWorkspacePathScope` remains reached from `writer.ts`'s default throughout, so the guard's live behaviour is continuously covered.
- `serveProjection`'s redaction-gate pin — reachable through the real chain (`serveProjection` → `admitProjection` → `validateProjectionVisibility` → `auditOf` → `persistDenialAudit`); exercised end-to-end by the migrated fixture.
- `GclAuditPersistPort.onRefused` — **dormant by design.** Exactly one implementation repo-wide (the test fake); zero production bindings, since the GCL port binding is deferred to Phase 25.2/25.4. Not a wiring gap — a declared precondition of that phase.

## Open follow-ups

1. ⛔ **`apps/worker/src/boot.ts:585-591` — a rule-7 leak whose SEVERITY IS UNMEASURED. ⚠ CORRECTED after this doc's first commit (`0886034b`), which called it "LIVE": that was an overclaim, by exactly the standard this session spent three slices enforcing on other people.**
   - **ESTABLISHED:** the line `console.error`s `signal.event` — a field `isRedactionSafe` scans — behind a comment asserting *"redaction-safe (event name only, never a field value)."* If a signal unsafe *via* `event` reaches it, the refused string is emitted verbatim by the handler that refused to persist it. The **PATH** runs: this is the Copilot denial-audit adapter `24.7` shipped, not the unbound GCL port.
   - ⛔ **NOT ESTABLISHED — and this is the cheap check that decides severity: can a signal reaching THAT adapter actually FAIL `isRedactionSafe`?** A running path is not a taken branch. **PATH ≠ TRIGGER** (`L141`'s amendment). Until measured, this must not be quoted as a live leak, and the lead has ruled it will not be reported as one.
   - **Third defect at that function**, alongside `24.62` (`:597-599`, unscanned `workspaceId`). Worker territory; prioritised as the successor round's first worker item, not dispatched at ACTION tier.
2. ⭐ **`### 24.43`'s first data point, in the direction it records as NEVER sampled.** De-escalating my own finding produced two dormancy claims wearing one word: the GCL port is dormant by *absence of binding*, but `boot.ts`'s adapter is not — its path already runs. **Every reachability correction before this one ran live→dormant; this one runs the other way** — something graded safe *because* it was assumed dormant, where that dormancy does not hold. Belongs on `24.43` (orchestrator territory to write).
3. **`### 24.61`** — validate the exempt workspace id against the known workspace set **before it may be sourced from anything other than a compile-time constant**. Two halves, kept separate: schema-layer VERIFIED (`WorkspaceIdSchema` admits a zero-width-only id); aliasing / visual-confusion question OPEN, not run.
4. **`### 24.26` step 3** (knowledge) — make `KnowledgeWriterDeps.workspacePathCheck` required, delete the `??` fallback and `LEGACY_UNPREFIXED_WORKSPACE_ID`. Blocked on step 2 (worker). Owes a cross-doc row.
5. **`### 24.62`** — `persistDenialAudit` gates the `audit` argument but not the `workspaceId` argument; a safe signal can ride alongside an unsafe workspace id.
6. **Landing coupling** — candidate-side foreign-workspace coverage now lives only in `packages/policy/test/visibility.test.ts`; if 24.45 were reverted it would exist nowhere.
7. **Reviewer-deferred, minor** — make the test fake's `onRefused` `readonly` to match its siblings; one pre-existing no-port assertion is redundant.

## What this session is worth remembering for

**Three briefs were wrong in ways the code could prove, and the checks were cheap.** Option (i) in brief 273 was structurally unavailable (`auditOf` returns `undefined` for both sibling gates). Brief 273's criteria 2 and 6 contradicted each other, and following criterion 2 literally would have meant writing to another implementer's held files — inverted with a throwaway worktree instead. Brief 275 prescribed an event-name-only refusal log, and `event` is one of the six scanned fields — mutation-verified: **passing `signal.event` reds the very pin the same brief asked for first.**

⭐ **And the round's recurring shape landed on me twice, an hour apart.** In `993f28e8` I retracted, in `gcl-projection.test.ts`, the claim that hand-built signals justify skipping a real-chain pin. In `e85953d3` I then wrote a new suite in that same file that was entirely hand-built with no real-chain pin. *Writing the rule down, in the file, did not stop me breaking it — a reviewer did.*

⚠ **Recorded as a LIMIT on `L94`, not a refutation of it** (lead ruling). An in-code note is **necessary and not sufficient**, and it is **weakest against its own author** — who has already read it and believes they know what it says. `L94`'s direction stands; its ceiling is now measured.

# Session 161 — `24.45`: validate-or-omit the candidate workspaceId, and retract the claim that hid the gap

**Date:** 2026-08-13 · **Phase:** 24 · **Track:** single-track `main` (root checkout, no worktree)
**Role:** `providers-integrations-implementer` (owns `providers`, `policy`, `integrations`)
**Predecessor:** `docs/sessions/159-2026-08-12-24-15-outbox-redrive-approval-policy-and-24-50-finding.md` (the `providers-integrations` chain; session-doc chains run per-AREA, so `160` is worker's and not this doc's predecessor despite the number)
**Successor:** `162-2026-08-13-required-from-birth-green-under-both-and-a-notice-that-carries-nothing.md`

**Slice landed:** `48ec7c91` — 1 commit, 4 files, `packages/policy` only.

---

## Why this session existed

`### 24.45`, a **wiring precondition** for Phase 25.2/25.4's `GclAuditPersistPort` binding. `isRedactionSafe` is a credential-shape heuristic, and the doc claim justifying trust in it (*"no representable violation… today"*) rested on a producer enumeration that omitted its own package. `validateProjectionVisibility` built its audit `refs` **before** any validation, interpolating the candidate's own `workspaceId` — so the branch that exists to catch a workspace **mismatch** was the one that had already embedded the foreign value.

Brief `270` (stamp `@e0b411b2`). Safety rules **4** (workspace isolation) + **7** (redaction).

## What was built

**Files created:** none.

**Files modified (all `packages/policy/`):**

| File | Change |
|---|---|
| `src/visibility.ts` | Validate-then-interpolate in `validateProjectionVisibility`'s `refs`: `MISSING` when not a string **or empty**, the value when it matches the source workspace, else `UNVALIDATED`. `srcId` hoisted to a **single read** reused by both the ref and the referential pin. |
| `src/audit-signal.ts` | Comment/enumeration only, **no logic change**. False coverage claim retracted; re-derived producer enumeration attached to `isRedactionSafe` (the function production calls) with its method, boundary, and partial-retraction status. |
| `test/visibility.test.ts` | 7 tests: the leak itself, the omits-visibilityLevel leak, the single-read property, allow + exceeds-source byte-identity controls, MISSING and empty-string sentinels. |
| `test/audit-signal.test.ts` | 2 characterization tests: the heuristic admits a sensitive non-credential string; legitimate ref shapes and sentinels still pass. |

## Decisions made

1. **Route (b)+(c), not (a).** Fix the producer + retract the claim. ⛔ **(a) — turning `isRedactionSafe` into a shape allowlist — was rejected on evidence, not preference:** `packages/knowledge/.../secret-scan.ts` implements `contentContainsSecret` as `!isRedactionSafe(probe)` and wires it as KnowledgeWriter's **blocking pre-commit secret scan**, so an allowlist would reject essentially every commit on the sole-writer path.
2. **Single read of `sourceWorkspace.id`.** From security review: two reads let a getter/Proxy-backed record return the candidate's value first and the real value second — rendering the raw foreign id into `refs` while still denying. One read makes the property total rather than conditional on the argument being a plain object.
3. **Empty string maps to `MISSING`, not `UNVALIDATED`** — otherwise the ref disagreed with its own denial message (*"projection omits workspaceId"*).
4. **The enumeration states its own boundary.** It finds only producers that go through `buildAuditSignal` **and** call it by that literal name; direct-construction and aliased/indirect calls are named as outside its reach rather than implied covered.
5. **Cited `contracts L5`, not bare `L5`.** A reviewer suggested `L5`; under the citation convention a bare `LNN` means *this* area's ledger, where `L5` is a GraphQL-connector lesson. Verified the intended one and carried its ledger name.

## Decisions explicitly NOT made

- **`denyDirectCrossWorkspaceRaw`** (same file) interpolates `from`/`to` after only a non-empty-string check. Same class, my territory, **deliberately not folded in** to keep the commit minimal and the byte-identity argument clean. Filed (`### 24.65`).
- **The `UNVALIDATED` sentinel collision** — a workspace legitimately named `UNVALIDATED` renders an identical ref. Accepted: **audit ambiguity only**; no attacker-controlled text reaches `refs` in either direction.
- **The "27 of 41" reading.** Two readings of the retracted claim's scope exist; resolved in favour of the charitable one. Recording that a **choice was made**, not merely that an ambiguity exists.
- **Nothing in `packages/knowledge`.** The fix broke a knowledge test; the remedy was a cross-track pair, ruled and executed by knowledge (`993f28e8`).

## TDD compliance

**Core slice: clean.** The RED test (`visibility_malformed_denial_does_not_leak_unvalidated_workspace_id`) was written first and **verified RED for the right reason** — the failure output showed the foreign id verbatim in `refs`.

⚠ **Deviation, stated rather than glossed:** the five **review-driven** tests (single-read, empty-string, exceeds-source control, omits-visibilityLevel pin, and the guarded redaction-safety assertion) were written **after** their corresponding fixes, because they originated from Step-8 findings rather than from the brief. **Compensating control:** the load-bearing one was **mutation-verified** — reverting to the double read produced `expected 2 to be 1`, proving non-vacuity. The others assert full-array equality rather than absence, which the reviewer confirmed is the non-vacuous shape.

## Cross-doc invariant audit

**No model field changed.** `AuditSignal` is a `packages/policy`-internal interface and is **not** in the `packages/contracts/CLAUDE.md` cross-doc table; `AuditRecord`, which is, was untouched. Route (b) altered an emitted *value*, never a field shape. Flagged as `NONE` at Step 9 and confirmed here — **no `ARCHITECTURE.md` row is owed.**

## Reachability

`validateProjectionVisibility` (`packages/policy/src/visibility.ts`) is reached from **`admitProjection`** (`packages/knowledge/src/gcl/visibility-gate.ts`), which is called by **both** `admitAndPersistProjection` (write path) and `serveProjection` (read path). Cited **by symbol, not line** — a cross-package line citation rots on the other track's first edit.

⚠ **Reachability qualifier, stated deliberately (`L141`, handoff 026's open caveat):** `serveProjection`'s only production call site, `resolveApprovedCrossWorkspaceSlice`, has **zero production callers**, and no `GclAuditPersistPort` is bound. **The GCL audit path is dormant on both legs.** The fix is a *precondition*, not an incident response — and `24.44`'s *"hostile input is the designed-for case"* is a claim about the **threat model**, not live reachability.

**No tested-but-unwired gap introduced** — this slice adds no new symbol; it constrains an existing one.

## Open follow-ups

Filed by the orchestrator; **referenced, not re-filed**:

- **`### 24.62`** — `persistDenialAudit` gates one of two data channels (`workspaceId` rides beside the signal, unscanned). Pre-existing; not created or worsened here.
- **`### 24.63`** — the landing coupling (below).
- **`### 24.64`** — audit producers that construct records directly **never reach `isRedactionSafe` at all** (`dispositionDurable.ts`, `egressRevoke.ts` candidate). ⛔ **No change to `isRedactionSafe` can reach these.**
- **`### 24.65`** — `denyDirectCrossWorkspaceRaw`'s interpolation; `secret-scan.ts` site 2 (`buildSecretScanRejectionAudit` embeds `path:${found.path}` gated by the *same* heuristic, so it is better defended but inherits the identical blind spot).
- ⛔ **FALSE — RETRACTED, see the erratum directly below.** *(Original text preserved:)* **Pre-existing, untouched:** a null `sourceWorkspace` still throws at the referential pin and the `defaultVisibility` guard — a §16 never-throw violation now **documented in-file** rather than left implied.

  > ⛔ **ERRATUM 2026-08-13 (`### 24.65`) — the bullet immediately above is FALSE. It is left standing deliberately, not rewritten, because its propagation is itself the evidence.**
  > **What was false:** (a) the referential pin dereferences nothing — it compares two already-bound locals; (b) a null/undefined `sourceWorkspace` **cannot reach** the `defaultVisibility` guard at all, because `24.45`'s own `?.` makes `srcId` undefined and the referential pin returns a typed `MALFORMED_POLICY_INPUT` denial first. ⇒ **there is no §16 never-throw violation on this path; the guarantee holds.** Measured, not read — `24.65` probed both null and undefined; neither throws.
  > **Where it came from:** `24.45`'s in-file comment at the `srcId` read, which this doc restated. **The same false claim reached the tracker and brief `277`** — four surfaces, each trusting the last, none re-measuring. That chain is the point of preserving this.
  > **Per-surface status at time of writing** (stated because an erratum that names contaminated surfaces without their status sends the reader to an uncorrected copy): `packages/policy/src/visibility.ts` **corrected** · this doc **corrected here** · `IMPLEMENTATION_PLAN.md` **corrected in place** · `docs/briefs/277-24.65-*.md` **carries its own top-of-file erratum** (`:3-13`, written by the orchestrator at Step 9); its body is deliberately left unrewritten under the same evidence-preservation discipline this doc uses — **corrected, not by me, orchestrator territory.**
  > ⚠ **This status line was itself wrong once**, and in the direction it exists to prevent: it read *"still asserts… NOT corrected"* after the brief had been corrected, i.e. it sent a reader to a **corrected** artifact labelled **uncorrected** — inviting either a redundant re-correction (which under `contracts L148` would have destroyed preserved evidence) or a loss of trust in the whole ledger. **Caught by security re-review.** ⇒ *a remediation ledger is a claim like any other, including the one written to stop claims decaying.*
  > ⚠ **And the correction itself was over-claimed once before landing:** the first retraction said §16 never-throw *holds*, unqualified. It holds for **null/undefined only** — a workspace whose `id` getter throws still throws, as does a projection whose `workspaceId` getter throws (measured; filed). **Caught by code-quality review, in the same block that documents throwing getters.**
  > ⭐ **What it hid:** `24.45`'s single-read hardening was made for an unrelated getter-split reason and **incidentally closed** the hole this bullet claims is open. ⇒ *when you fix something, ask what it incidentally fixed.*
  > **Corrected at:** `packages/policy/src/visibility.ts` (comment retracted in place) + `packages/policy/test/visibility.test.ts` (the guarantee is now pinned, and the still-unguarded-but-reachable `defaultVisibility` read pinned separately so it is not deleted as dead code).

⛔ **LANDING COUPLING (`### 24.63`) — the one a reverter must see.** This fix moves the unsafe value's **origin** from the candidate (attacker-controllable) to the workspace record (not, in that threat model). Candidate-side foreign-workspace coverage now lives **only** in these new tests, so **a revert would look clean while silently deleting the only test of the original threat.** Recorded in the commit message too, because a reverter reads the diff and not the tracker (`L94`).

⚠ **The `isRedactionSafe` call inside `persistDenialAudit` is now unreachable *from this producer*.** It is **not dead code** — it is the gate covering the other producers. Recorded so a later "cleanup" does not delete it.

## Lesson candidates raised (banked by the orchestrator)

1. **A coverage claim that justifies NOT writing a test is load-bearing in a way a doc comment never is** — it fails silently and permanently. The false invariant's third home was the *stated reason* a suite pinned a hand-built signal instead of the real chain.
2. **A HOLD freezes the commit, not the slice's claims about the tree.** My comment said a sibling home was *"filed, not fixed"*; it had been fixed by a peer's commit **while I was held**. True when written, invalidated by an externally-imposed wait, and nothing re-checks it. ⇒ **re-measure every tree-claim at un-hold.** Mirror image of *a hold defers the commit, not the effect*.
3. **The inherited-claim defect struck three times inside the slice built to fix it** — the above, plus a blanket "distrust grep" warning and my own "find is unreliable" over-generalisation, each extrapolated from one observation. ⇒ **generalising from a single observation is the same error as inheriting a claim, and fixing that defect confers no immunity to it.**
4. **A value interpolated into an audit ref before the validation that would reject it is, by construction, the untrusted value.**
5. **Read a value once when it feeds both an audit artifact and the branch decision** — two reads let a getter make the record and the decision disagree.

## Verification at close

- `@sow/policy` **497/497** · `turbo test` **20/20** · `turbo typecheck` **20/20** (exit code read **without** a pipe).
- Commit verified **per-path** via `git log --oneline -1 -- <file>`, not the receipt: 4 files, policy-only, **no peer path swept** (three peer commits landed during the hold).

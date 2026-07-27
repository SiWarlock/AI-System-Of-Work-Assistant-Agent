# /tdd brief — entity_stub_path_namespacing

## Feature
Mint entity stub paths in ONE namespaced place instead of two root-level call sites, so an untrusted entity name can never collide with a KnowledgeWriter-owned structural surface (`index.md`, `log.md`, `Logs/<date>.md`).

## Use case + traceability
- **Task ID:** 13.8j (new — see "Plan bookkeeping") · ⚠ **safety: untrusted input reaching writer-owned structural surfaces** · ⛔ **arming precondition for the synthesis path**
- **Architecture sections it implements:** `ARCHITECTURE.md §6` (KN-10 grounding, **KN-12 structural-file parity**), safety rule 1 (one writer), REQ-F-021
- **Scope note — this brief widens phase scope because** the only out-of-set token below is `§2.5`, which is the brief template's "shared-contract seam" SECTION NAME, not a claimed architecture anchor (the real anchors are §6 + safety rule 1, both in phase 13's set).
- **Origin:** knowledge's 13.8g-A Step-9 flag (found by both reviewers; security-reviewer re-rated it to attacker-reachable once 13.8g-A began feeding the name path from untrusted attendee strings).

## ⚠ The finding is BROADER than reported — there are TWO call sites, not one
Knowledge's Step 9 named `meeting-rewrite.ts`. The orchestrator's verification found the same defect in the **source-ingestion** path:
- `packages/knowledge/src/synthesis/meeting-rewrite.ts:185` — `const stubPath = \`${resolution.proposedSlug}.md\`;`
- `packages/knowledge/src/synthesis/planner.ts:288` — `const stubPath = \`${res.proposedSlug}.md\`;`

So the hole is not meeting-specific: **13.8c's planner has it too**, which means the source path — already bound (dormant) by 13.8d `172f9aed` — carries it as well. `entity-resolver.ts:128` correctly returns only a `proposedSlug` and never a path; both consumers independently append `.md` at the vault root. That duplication IS the defect's enabler: two places deriving the same path means a third can reintroduce it.

**Why it matters:** an entity named `Index`, `Log`, or `README` mints `index.md` / `log.md` — the writer-owned KN-12 structural surfaces (the navigation catalog and the append-only op-log). `MeetingRewriteDeps` deliberately omits the `structural` port so a meeting *cannot* touch those; this reaches them by another door. Traversal itself is already clean (`entitySlug` collapses `../../etc/passwd` → `etc-passwd`), so the exposure is collision, not escape.

## ⛔ Fix by NAMESPACE, not by denylist — and derive the path ONCE
**Do not add a reserved-slug denylist.** Enumeration is structurally unwinnable and this codebase has paid for that lesson twice: the subscription shadow-env key set needed three re-grounds and still missed a switch (worker L72), and the settings-injection FIELD enumeration was retired outright in favour of a presence-degrade (§ARM-18, 18.39-B). A namespace is complete-by-construction: a person/entity note under a prefix cannot collide with a root structural file — for every present *and future* structural filename, with no list to maintain.

Additionally: **mint the path in one place.** The resolver owns `proposedSlug`, so a single shared derivation (a helper beside the resolver, or the resolver returning a path) gives both consumers the namespace by construction and makes a future third call site inherit it rather than re-derive it. A namespace applied twice by hand is one edit away from being applied once.

## Acceptance criteria
- [ ] Entity stub paths are namespaced (e.g. `people/<slug>.md` for `kind:"person"`) and are derived by **one** shared function — neither `planner.ts` nor `meeting-rewrite.ts` builds the path inline any more.
- [ ] A stub for an entity named `Index` / `Log` / `README` / `Home` **cannot** produce `index.md` / `log.md` / `README.md` / `Home.md` — pinned for BOTH call sites.
- [ ] The namespace covers the source path (`planner.ts`) as well as the meeting path — a test drives each.
- [ ] Kind-appropriate namespacing: decide and pin what `project` / `concept` stubs get (see Step-2.5 Q1) — `person` must not be the only kind protected.
- [ ] `entitySlug`'s existing traversal collapsing is unchanged and still pinned (this slice must not weaken it).
- [ ] Already-`resolved` paths are untouched — this changes only STUB minting, never a path the resolver returned from a real note.
- [ ] A structural pin asserts no remaining inline `${...proposedSlug}.md` construction anywhere in `packages/knowledge/src` (the predicate-lives-once guard for this path).
- [ ] 13.8f-A's and 13.8c's existing suites re-run green — specifically `user_region_never_overwritten`, the WS-8 pins, and the tier split.
- [ ] `/preflight` clean + repo-wide `turbo typecheck`.

## Wiring / entry point (Step 7.5)
No new entry point — this changes path derivation inside two already-exported synthesis modules. Both remain dormant (`rewriteVaultForSource` has only its arming-gated importer; `rewriteVaultForMeeting` has none). State that the dormancy pins still hold, and note explicitly that the source path's binding (`172f9aed`) means `planner.ts`'s fix rides an already-bound-but-unarmed path — so the fix lands *before* arming, which is the point.

## Files expected to touch
**Modified:** `packages/knowledge/src/synthesis/entity-resolver.ts` (or a new small sibling — the shared path derivation) · `packages/knowledge/src/synthesis/planner.ts:288` · `packages/knowledge/src/synthesis/meeting-rewrite.ts:185` · their tests · possibly `src/index.ts` if a new symbol is exported.

**Do NOT touch:** `packages/workflows/**`, `apps/**`, and all orchestrator-territory docs.

## RED test outline (Step 2)
1. **`structural_surface_names_cannot_be_minted__meeting`** — Asserts: entity names `Index`/`Log`/`README`/`Home` via `rewriteVaultForMeeting` never yield a root `index.md`/`log.md`/`README.md`/`Home.md`. Why: KN-12 surfaces are writer-owned; untrusted input must not reach them.
2. **`structural_surface_names_cannot_be_minted__source`** — Same via the `planner.ts` path. Why: the finding's broader half — the source path carries it too and is already bound by 13.8d.
3. **`stub_paths_are_namespaced`** — Asserts: a stub path for a person carries the namespace prefix. Why: the positive case, so the fix isn't vacuous.
4. **`path_derivation_lives_once`** — Asserts (structural): no inline `${...proposedSlug}.md` remains in `packages/knowledge/src`. Why: the duplication enabled the bug; a namespace applied by hand twice is one edit from being applied once (forbidden-pattern #6 / L39).
5. **`resolved_paths_unchanged`** — Asserts: a resolver HIT still yields the real note path verbatim, unprefixed. Why: this must change stub minting only — re-pathing a resolved note would break grounding.
6. **`traversal_collapse_still_holds`** — Asserts: `../../etc/passwd` still collapses. Why: don't weaken an existing guarantee while adding a new one.
7. **`kind_namespacing`** — Asserts: whatever Q1 decides for project/concept is pinned, not incidental.

## Cross-doc invariant impact
- **Model field changes:** none — `EntityResolution.proposedSlug` stays a slug. If you instead have the resolver return a PATH, that's a shape change to a knowledge-internal type (not an Appendix-A model) — flag it at Step 2.5, it's allowed but it's a wider blast radius.
- **§2.5-seam model touched?** No.
- **Orchestrator doc rows to write hot (Step 9):** `ARCHITECTURE.md §6` — KN-12 surfaces are unreachable from entity-stub minting by namespace construction. I'll also record why a denylist was rejected, so the next person doesn't "simplify" it into one.

## Things to flag at Step 2.5
1. **Namespace per kind, or one shared prefix?** (a) `people/`, `projects/`, `concepts/` by `EntityKind`; (b) a single `entities/` prefix for all; (c) `people/` only, leaving other kinds at root. My default vote: **(a)** — it's self-describing in the vault, matches how a human organizes an Obsidian vault, and protects every kind. **(c) is forbidden** — it fixes the reported instance and leaves the same hole for `project`/`concept`, which is how a finding comes back. Flag if existing vault conventions already imply a different layout.
2. **Does the resolver return a slug or a path?** (a) keep `proposedSlug`, add a shared `stubPathFor(resolution, kind)`; (b) resolver returns `proposedPath` directly. My default vote: **(a)** — smaller change, keeps the resolver's contract (it resolves identity; it doesn't own vault layout), and the helper is the single derivation point either way. (b) is defensible; say so if the call-site ergonomics are clearly better.
3. **Do existing stubs need migrating?** My default vote: **no — nothing has run.** The whole synthesis path is dormant and has never written a stub in production. If you find evidence otherwise, stop and flag it; a migration is a different slice with owner involvement.
4. **Should the namespace be configurable?** My default vote: **no** — a hardcoded prefix is one fewer thing to get wrong, and configurability here buys nothing we need. Resist the urge.

## Dependencies + sequencing
- **Depends on:** 13.8g-A (the slice that surfaced it), 13.8c `461a0186`, 13.8f-A `d723a4fc` — all landed.
- **Blocks:** the synthesis-path arming crossing (recorded as a §ARM-RESEARCH precondition). Not a blocker for 13.8g-B.

## Estimated commit count
**1.** One namespacing change across two call sites plus its shared derivation. Safety-touching ⇒ its own commit.

## Lessons-logged candidates anticipated
- **Convention candidate** — "Namespace to make a collision impossible; never enumerate the things you must not collide with. A denylist of reserved names is the same unwinnable pattern as a denylist of shadow env vars."
- **Convention candidate** — "When a finding names one call site, grep for the construction — the second copy is the one that ships."
- **Architecture-doc note candidate** — §6: KN-12 structural surfaces are unreachable from entity-stub minting by construction.

## How to invoke
1. Read this brief; note that the finding covers **two** call sites and that a denylist is explicitly rejected.
2. Run `/tdd entity_stub_path_namespacing`.
3. Step 0 restate → Step 1 confirm files → **Step 2.5 write-up + coverage map**.
4. Step 8: `security-reviewer` (**invariant**) + `code-quality-reviewer`.
5. Step 9: categorized flags + ship-ask.

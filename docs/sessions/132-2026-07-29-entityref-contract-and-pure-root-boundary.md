# Session 132 — contract track: EntityRef candidate-data gate (§DEC-CANDGATE leg 1) + the pure-root boundary test (13.18, 13.20)

- **Date:** 2026-07-29
- **Phase / arc:** §DEC-CANDGATE (owner-approved 2026-07-26, twice-deferred, scheduled this round) — leg 1 of 3, contracts-only; plus task 13.20, a sibling finding raised by 13.18's own Step-2.5 review
- **Role:** contract-implementer (single-track `main`)
- **Predecessor session:** [115-2026-07-25-contract-frozen-rounds-and-uisafe-types.md](115-2026-07-25-contract-frozen-rounds-and-uisafe-types.md)
- **Successor session:** _TBD (orchestrator context-cycle at round seal; I persist idle into the next round, not cycling)_

## Why this session existed

The owner scheduled §DEC-CANDGATE (deferred twice for scope reasons) as the round's contract-first arc: four recorded bugs in one prior round (13.8h's uncapped fan-out, the §9.8 Approvals bypass/L57, two attendee-name bugs/L60, the prototype-chain hole/L65) all shared one root shape — `EntityRef`'s `kind: EntityKind` was a compile-time claim about runtime-untrusted model output, with no schema anywhere enforcing it. Contracts is the producer leg (sequencing: contracts → knowledge → worker); I am leg 1.

Task 13.20 was raised mid-session, by my own 13.18 Step-2.5 review: verifying the brief's claim that `packages/contracts/CLAUDE.md` forbidden-pattern #2's "a boundary test pins this" was backed by a real test, a repo-wide search found none — a load-bearing §2.5 structural invariant was asserted-as-pinned and unenforced.

## What was built (2 slices, 2 commits — both on `main`)

### #3 (task 13.18) — EntityRef contract + Zod schema — `93ebeabd`

**Files created:**
- `packages/contracts/src/models/entity-ref.ts` — `EntityKind` (closed 3-member enum: person/project/concept) + `EntityRef` (`{name, kind}`) + `EntityRefSchema` (`.strict()` Zod), following the `proposed-action.ts`/`task.ts` house pattern.
- `packages/contracts/test/models/entity-ref.test.ts` — 9 tests (2 schema-snapshot + 7 behavior, incl. a Step-8-added `.max(1024)` boundary test).
- `packages/contracts/src/models/__snapshots__/entity-ref.snap`, `packages/contracts/schemas/entity-ref.schema.json` (generated).

**Files modified:** `src/index.ts` (barrel export) · `test/primitives/shared.test.ts` (membership row) · `src/fixtures/{valid,index}.ts` (seam fixture) · `packages/domain/test/fixtures/fixtures.test.ts` (`ZOD_BY_ID`).

Closes the class, not the instance: `.strict()` rejects a smuggled `path` (the §ARM-RESEARCH 13.8j/k/l shape); `z.enum` rejects `__proto__`/`constructor`/`prototype` (L65) via a genuine Set-membership check, not object-literal indexing, so that failure mode can't recur here even in principle (security-reviewer confirmed by reading Zod's actual source). **Leg 1 closes nothing at runtime** — no production caller; reachable only via the schema registry (`registry-all.test.ts`). Leg 2 (knowledge) was the one that would call the schema at the `planSynthesis` boundary.

### #6 (task 13.20) — pure-root import-direction boundary test — `0a6d6629`

**Files created:** `packages/contracts/test/_helpers/pure-root-scan.ts` + `test/boundary/pure-root.test.ts`; `packages/domain/test/_helpers/pure-root-scan.ts` (byte-identical, intentionally duplicated per Q1(c) — neither package's suite reaches across the seam) + `test/boundary/pure-root.test.ts`.

**Files modified:** `packages/domain/test/fixtures/fixtures.test.ts` — one-line rename (no assertion change) of the test whose name claimed an Appendix-A filter its mechanism (`defaultSchemaRegistry.ids()`, an unconditional glob) doesn't have.

Pins both the declared `package.json` surface and the real source-import surface, mirroring the existing OSB anti-corruption guard's shape (`packages/evals/src/osb/anti-corruption-guard.ts`): a `git ls-files`-driven scan + count-pinned LIVE test. Two reviewer-found gaps fixed in-slice (bare side-effect imports were invisible to the original regex; the header comment overclaimed catching a tsconfig `paths`-alias escape it didn't). Non-vacuity was proven twice — first by a real on-disk mutation per package (reverted within the turn), then, per a lead ruling triggered by the fact that a brief on-disk mutation to a shared surface is observable by *other* implementers' concurrent reviewer subagents, converted into a **permanent, disk-free** test that injects a fabricated violation into the real discovered file list in memory.

## Decisions made

- **§DEC-CANDGATE Q1 (Appendix-A promotion) is not actually the independent toggle the brief posed.** Traced `defaultSchemaRegistry`'s unconditional `readdirSync`/glob over `schemas/*.schema.json` and the domain meta-test's use of `.ids()` (no Appendix-A filter anywhere in the mechanism) — the L49 checklist (seam fixture + `ZOD_BY_ID` + membership rows) is **mandatory the moment a schema file exists**, regardless of any documentation-only "is this Appendix-A" decision. Confirmed empirically, not just by argument: forgetting the barrel-export line left `@sow/contracts` green while `packages/domain`'s meta-test genuinely failed (`EntityRefSchema` resolved to `undefined` via `ZOD_BY_ID`) — L49's "green-in-contracts ≠ done" as a demonstrated failure on this very slice, not a warning. The orchestrator traced *why* the brief said otherwise: the meta-test is *named* "for every registered Appendix-A schema" while its mechanism has no such filter — banked as contracts L93's naming variant, and the direct motivation for task 13.20.
- **`name` is capped at 1024 chars, reusing the `ui-safe.ts` `uiSafeSummaryLine` convention** — a generous per-field bound, distinct from the separate `MAX_MODEL_ENTITY_REFS=200` array-length cap in `planner.ts` (fan-out, not per-field length; never coupled — same reasoning as L88).
- **Reject-never-trim**: `name`'s blank-check is a `.refine()`, never a `.transform()`/`.trim()` — a candidate-data gate rejects or passes, never rewrites (would become a second producer for `entitySlug()`/`faithfulKey()` derivation downstream).
- **13.20's Q1 (c) — each package pins its own boundary independently**, at the cost of one byte-identical duplicated helper per side (diffed after every edit) rather than either suite importing the other.
- **A shared-tree mutation proof must be disk-free to be safe under concurrency.** A lead ruling, triggered when one of my two mutation-proof on-disk edits briefly broke the repo-wide typecheck and was observed by another implementer's concurrent reviewer subagent: "mutate/observe/revert in one turn" bounds *persistence*, not *visibility*. Replaced with a permanent in-memory injection test (real discovery output + one fabricated entry, zero disk writes) that is strictly stronger than the mutation it retired — it runs forever instead of evaporating on revert.

## Decisions explicitly NOT made (deferred)

- **A parity pin between the two duplicated `pure-root-scan.ts` copies** — they're byte-identical today with nothing mechanically enforcing that going forward; security-reviewer's own recommendation was to defer (low-stakes, test-only code). Carried as a Future TODO.
- **Tightening `EntityRef`'s fields to `readonly`** to match `packages/knowledge`'s original declaration exactly — code-quality review caught the header comment overclaiming "IDENTICAL" when knowledge's fields were `readonly` and contracts' weren't (a narrowing, not a live bug). Fixed the comment's precision in-slice; the `readonly` tightening itself was left for a future round rather than expanding 13.18's scope. Per the orchestrator: knowledge (13.19) accepted the loosening this round rather than working around it — recorded, not absorbed.
- **A dedicated `EntityCandidate`/`EntityReadFault`/etc. schema** — Q5's default (EntityRef only) was taken; `EntityCandidate.path` verbatim-from-GBrain-read (13.8k's residual) was flagged forward at face value per the brief's own request, not independently re-derived (out of a contracts-only leg's territory) — orchestrator is routing it to 13.8k.

## TDD compliance

**One self-caught process slip, zero effect on the delivered RED→GREEN record.** Early in 13.18 I wrote `entity-ref.ts` (the implementation) before writing any test — caught it before running anything (no test had executed, nothing was committed), deleted the file, and restarted correctly test-first. Recording this because the project's own culture treats a disclosed near-miss as more valuable than a silently-avoided one (mirrors L75's "self-correction at speed is what keeps a verified-findings list worth reading").

Otherwise clean on both slices: every behavior (13.18's 9 tests; 13.20's original 8-per-package plus the reviewer-driven bare-import-form fix and the permanent wiring test) was RED-confirmed for the right reason before implementation. 13.20 is a **structurally inverted RED** by design (the invariant already held, so a correctly-written LIVE test passes on arrival) — non-vacuity was proven separately, first by a genuine on-disk mutation (confirmed to be a real scanner-level `AssertionError`, not a `tsc`/module-resolution artifact — verified precisely because the mutation-verification run was scoped to a single test file that only `readFileSync`s its targets, never imports them), then superseded by the permanent in-memory injection test per the lead's concurrency ruling.

## Cross-doc invariant audit (§2.5 of `/session-end`)

`EntityRef` is a new Appendix-A model this session. Checked both required doc edits exist (single-track — orchestrator shares this checkout): **both already committed**, not just hot-uncommitted — `ARCHITECTURE.md:775` (`| EntityRef | §3 | name, kind |`, commit `e6eb3d4e`) and `packages/contracts/CLAUDE.md`'s cross-doc table (commit `97e220a7`, same commit that banked contracts L95). No discipline violation; the orchestrator routed both hot during the session as designed. 13.20 touched no model fields, so nothing further to audit there.

## Reachability

- **13.18 (`EntityRef`/`EntityRefSchema`)** — stated at Step 7.5 as reachable via the schema registry only (`registry-all.test.ts`), no production caller. **Update, observed during this same session but not my slice's work:** task 13.19 (knowledge, leg 2) landed concurrently (`93cafe5f`) and re-pointed `packages/knowledge/src/synthesis/entity-resolver.ts` to import `EntityKind`/`EntityRef` from `@sow/contracts` directly — the interim duplicate declaration is gone, and the candidate-data gate now actually runs at the `planSynthesis` boundary. `planSynthesis` itself remains dormant (no production caller per prior rounds), so the overall feature is still not live, but the gate this slice built is no longer merely registered — it's wired into its intended call site.
- **13.20 (the boundary tests)** — not a runtime path by design; each package's test runs in its own suite on every `pnpm test`. No wiring gap possible for a structural/architectural pin.
- No tested-but-unwired gap to flag beyond what's already tracked (leg 3/worker, still open, per the arc's own sequencing).

## Open follow-ups

**Step-9 items already routed hot by the orchestrator this session (not re-enumerating, per §2.6) — for completeness, what landed:**
- `ARCHITECTURE.md` Appendix-A row for `EntityRef` (§3) + `packages/contracts/CLAUDE.md` cross-doc mirror row — done (`e6eb3d4e`).
- Contracts L93 (the naming-variant lesson: a test name asserting a narrower filter than its mechanism has) + L95 — banked (`97e220a7`).
- The brief's mis-cited "L26" (meant *worker* L26, written unqualified in a contracts brief) — corrected going forward; per-area lesson numbers now qualified on cross-area citations.

**Still open, carried to next round:**
- Parity pin between the two duplicated `pure-root-scan.ts` copies (deferred, security-reviewer's own recommendation).
- `EntityRef`'s `readonly` field tightening to match `packages/knowledge`'s original shape exactly (cosmetic; knowledge accepted the loosening rather than working around it this round).
- `EntityCandidate.path` verbatim-from-GBrain-read (13.8k's residual) — flagged forward, routing to 13.8k per the orchestrator.
- §DEC-CANDGATE leg 3 (worker) — not started; leg 2 (knowledge, 13.19) landed this session per the Reachability note above.

## Preflight

`pnpm install` clean. `pnpm lint` prints the known garbled `ESLint output (JSON parse failed...)` → `eslint not found` (L89 — no package installs/configures ESLint anywhere; `pnpm lint` is a broken wrapper over the real per-package `lint` script). Bypassed it and ran the actual mechanism directly: `npx turbo run lint` → **11/11 packages successful** (every `lint` script is `tsc --noEmit`, confirmed). **Never write "lint clean" — there is no lint coverage in this repo.** `pnpm format:check` → `Command "format:check" not found` (pre-existing repo-wide; no package or root defines it; not this session's regression, not fixed here per the teardown boundary). `pnpm typecheck` repo-wide → **20/20 tasks successful**, all 11 packages clean (this resolved the transient `@sow/knowledge` foreign red I'd observed mid-session — task 13.19 landed and fixed it before I got here).

`pnpm test` repo-wide → **7304 passed / 58 skipped / 8 todo, 1 failed suite**: `@sow/desktop test/bundle/main-bundle-resolution.test.ts` (`Error: Command failed: npx electron-vite build`). Reproduced identically at both the start and end of this session, with zero `apps/desktop/**` files in either of my commits — an electron-vite build-tooling issue, not a TS/test-logic regression, and outside my territory. `@sow/contracts` (780/780) and `@sow/domain` (307/307) are fully green on their own. **incomplete: preflight failures** — the one item is foreign and pre-existing, named rather than silently passed over.

## Notes

- **Shared tree, three-to-four concurrent implementers this session** (worker: 9.21-A/B; desktop: 9.35 + consumer leg; knowledge: 13.19). Both my commits verified via `git show --stat` on the actual commit SHA (never assumed `HEAD`, since another implementer's commit landed immediately after mine both times) — both came back clean, exactly my own files.
- **Reviewers:** 13.18 — security 0 findings, code-quality 2 low (both fixed in-slice). 13.20 — security 1 medium + 2 low (the medium and one low fixed in-slice; one low deferred per the reviewer's own call), code-quality 1 medium + 1 low (both fixed in-slice, including a genuine functional gap — bare side-effect imports were invisible to the original scan regex).

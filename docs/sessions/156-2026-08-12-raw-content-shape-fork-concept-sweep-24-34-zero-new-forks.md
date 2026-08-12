# Session 156 — knowledge: concept-level sweep for raw-content-shape predicate forks (24.34) — zero new forks, non-vacuity control fires 3×

**Date:** 2026-08-12 · **Role:** knowledge-implementer (`main`, single-track, root checkout)
**Predecessor:** [155-2026-08-12-gcl-visibility-gate-hardening-and-the-live-dormant-correction.md](155-2026-08-12-gcl-visibility-gate-hardening-and-the-live-dormant-correction.md) · **Successor:** [158-2026-08-12-gcl-denial-audit-persistence-24-33-and-24-44.md](158-2026-08-12-gcl-denial-audit-persistence-24-33-and-24-44.md)

## Why this session existed

`24.19` hardened the raw-content-shape traversal in `gcl-projection.ts`; `24.32` then found an independent, unfixed, dormant fork of the same predicate in `proposeWindows.ts`. The lead's own question at `24.32`'s close — "two is a pattern, are there others?" — was filed as `24.34`, an AUDIT slice (brief `docs/briefs/261-…`): sweep the monorepo BY CONCEPT (not by the three known function names — contracts `L64`), classify every candidate, state the search scope, iterate to a dry pass, and file (not fix) any new instance found. No build work was in scope; `24.32`'s own fix stays separately tracked.

## What was built

**Files created:** none.
**Files modified:** none.

This was a pure audit slice — 0 production code, 0 tests. Verified via `git status` before and after: the only dirty entries in the tree throughout the session belonged to the concurrent worker-track `24.39` migration slice, never touched here.

## Decisions made

- **Step 2.5 concept keys, reviewed before the sweep ran (per the brief's explicit gate):** 7 keys drafted from the orchestrator's default set + 2 of my own (bare vocabulary-independent traversal fingerprint; boundary-adjacency hand-check), reviewed and approved with one addition (`ADD:`) — an 8th key for the Zod schema-validator surface (`.refine`/`.superRefine`/`z.custom` bodies), since the canonical predicate's own invocation is an inline `.refine()`, and a fork could equally live as an unnamed inline arrow my function-oriented keys wouldn't catch.
- **Consolidation question (Step 2.5):** concurred with the orchestrator's default — FILE, don't fix or consolidate, this slice. No live (non-dormant) fork was found, so nothing jumped the queue.
- **No `raw_content_shape_predicate_lives_once` census pin written**, with reasoning stated explicitly rather than the pin being silently omitted: that pin would assert exactly one definition exists, but there are genuinely TWO right now (the hardened one + `24.32`'s still-unfixed dormant fork) — writing it in this slice would be RED against current reality (contracts `L102`: ask whether this is the kind of thing a test can pin before promising one). The pin belongs to `24.32`'s own delete-and-reuse slice, not this sweep.
- **Reachability qualifiers method:** per contracts `L141` (three wrong hand-verified reachability calls on this exact area in one prior session), every producer of `AgentJob.carriesRawContent` was traced to its actual call site rather than assumed from a name match — all five hardcode literal `true` structurally, none compute it by walking a payload. This reclassified a whole family of plausible-looking `rawcontent`-substring hits (`egress.ts`, `processors.ts`, `local-embed.ts`, `copilotClaudeSynthesis.ts`, `copilot.ts`, `runAgentJob.ts`, `source-extraction.ts`, `copilotAgentSynthesis.ts`) as consumers of a context flag, not forks of the predicate that sets it — the sweep's single sharpest judgement call, per the orchestrator's Step-9 read.

## Decisions explicitly NOT made

- **Whether/how to consolidate `proposeWindows.ts`'s known dormant fork (`24.32`)** — out of this slice's scope by the brief's own instruction; not touched, not designed against.
- **Extending the sweep into the 534 test files** — the orchestrator flagged this as a real, named limit rather than an oversight to paper over: nothing in the 13 primary passes pointed into test-file territory, but a fork living only in a test double is exactly contracts `L85`'s shape (a fake mirroring a real guard covers the fake) and `L69`'s (this defect class lives in assertions/fixtures a production-code audit structurally can't see). Recorded as the sweep's honest unreached surface, not silently smoothed over — carried here as an open follow-up, not resolved.

## TDD compliance

N/A this session — no code changes were made (audit-only slice, per the brief's own explicit allowance: "this slice may add no production code at all"). No RED/GREEN cycle to audit.

## Cross-doc invariant audit

No Appendix-A/cross-doc model was touched this session (0 code changes). `packages/contracts/CLAUDE.md`'s cross-doc invariants table needs no follow-up from this session.

## Reachability

N/A — no new code shipped, nothing to wire. The two existing predicate instances' own reachability was already established in prior sessions (`gcl-projection.ts`: live via `queries.ts`'s `sanitizeGlobal` and the frozen `GclProjectionSchema`; `proposeWindows.ts`: dormant, tracked at `24.32`, unchanged by this session).

## Open follow-ups

- **The 534 test files were not deep-swept** (see "Decisions explicitly NOT made" above) — named as the sweep's honest unreached surface per the orchestrator's Step-9 instruction, not a task filed, just a documented scope limit for whoever next touches this area.
- **`24.32`** remains open, unfixed, dormant — this session's sweep confirms it is still the ONLY other instance of the predicate in the repo; its fix (delete-and-reuse, not re-harden) and the `raw_content_shape_predicate_lives_once` census pin both belong to its own future slice.
- **`ui-safe.ts` (both `packages/contracts/src/api/ui-safe.ts` and `apps/worker/src/api/projections/uiSafe.ts`)** and **`packages/domain/src/redaction/redact.ts`** and **`packages/policy/src/copilot-result-redaction.ts`** were all identified as near-miss, related-but-distinct mechanisms (single-line/length-cap display shaping; allowlist-by-field-type redaction; workspace-ownership-based result filtering) — classified as non-instances in the Step-9 report, not filed, but worth a future reader's awareness if this concept area is revisited.
- A lesson (`L143`, project-wide ledger) was banked hot by the orchestrator during this session from the sweep's findings — indexed in `packages/contracts/CLAUDE.md` already; no action owed here.

## Preflight (final gate, run at session-end)

`pnpm install` clean · lint (`npx turbo run lint`, the reliable form per this project's own documented bare-`pnpm lint` flakiness) 11/11 clean · `format:check` — no such script exists at root, a pre-existing, already-documented project condition (also noted in session 155), not something this session introduced or can fix · typecheck (`npx turbo run typecheck`) 20/20 clean · full suite: **7558 passed / 58 skipped / 8 todo, 1 failed suite** (`apps/desktop/test/bundle/main-bundle-resolution.test.ts`, an `electron-vite build` subprocess failure). This is the SAME pre-existing, already-tracked (`### 24.25`, unowned — desktop is shut down) failure present at every status check across the prior several sessions. **Not claiming a blanket "preflight clean"** — stating precisely: this session made 0 code changes (docs-only), so nothing here could have introduced or fixed it; the one failure is pre-existing and unrelated.

## How to use what was built

N/A — nothing was built. The durable value of this session is the enumeration itself: a non-vacuity-controlled, dry-terminated, scope-stated negative result (the 589-production-file / 13-pass sweep found zero new forks beyond the two already known), recorded in the Step-9 report the orchestrator is folding into the task tracker's coverage statement.

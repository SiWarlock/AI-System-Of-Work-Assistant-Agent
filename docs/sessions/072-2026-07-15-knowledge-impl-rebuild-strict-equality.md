# Session 072 — rebuild wholesale-replace gate: strict `=== true` false-green hardening (knowledge track)

- **Date:** 2026-07-15
- **Phase:** 13.10 (Copilot serving-oracle go-live arc — trust-gate false-green hardening; arming-prep) / Phase-4 rebuild-oracle "build-first" round
- **Team:** `session-734f946b` — orch `orch20` + impl `knowledge-impl` (single-track, branch `main`)
- **Predecessor:** [071-2026-07-15-impl22-rebuild-oracle-producer.md](071-2026-07-15-impl22-rebuild-oracle-producer.md)
- **Successor:** _(pending — impl22 piece C, session doc 073)_
- **Commit:** `e808a43` (slice) · this session doc (separate)

## Why this session existed

impl22's security review of the rebuild-oracle producer arc (pieces A+B) surfaced a latent false-green vector in the knowledge track: `packages/knowledge/src/gbrain/rebuild.ts:160` gated the wholesale-replace check with truthy `if (!receipt.replaced)`. The `replaced` flag comes from the **injected `IndexRebuildClient`** — an external-I/O boundary that binds a real (owner-gated, currently unbound) client at arming, where TS types are **not** runtime-enforced. A truthy-non-`true` `replaced` (e.g. `1`, `"false"`, `{}`, `[]` from parsed JSON) would slip the non-replacing guard, letting a merge-not-replace rebuild reach a success `Result` → a false-green into the serve-time trust gate via the rebuild-oracle `oracleBuildOk` leg (safety rule 1 — a non-replacing rebuild could leave a quarantined DB-only fact in retrieval). Lead-ruled HARDEN-NOW + **arming-gate blocker** (must land before any real `IndexRebuildClient` binds). Same class the propose guard `392e7db` proactively hardened (worker Lesson 28).

## What was built

**Files modified:**
- `packages/knowledge/src/gbrain/rebuild.ts` — the non-replacing-rebuild guard tightened from truthy `if (!receipt.replaced)` to strict `if (receipt.replaced !== true)`, with an in-code WHY comment (external-I/O boundary / safety rule 1 / Lesson 28). Also reworded the non-replacing health-item message from the now-misleading static `(replaced=false)` to a static `(replaced flag not strictly true)` — kept **non-interpolated** (no boundary-value leak into the health sink; safety rule 7).
- `packages/knowledge/test/gbrain-rebuild.test.ts` — one new parametrized guard test (`describe: strict wholesale-replace gate (Lesson 28 mirror)`), 5 cases: `1`, `"true"`, `"false"`, `{}`, `[]` cast through the fake `IndexRebuildClient` — each must yield `non_replacing_rebuild` + a valid `rebuild_divergence` HealthItem, NOT a success `Result`.

## Decisions made

- **Strict `=== true`, not truthy.** The only value that reads as a wholesale replace is the boolean literal `true`; every other value fails closed. Byte-equivalent for well-typed `true`/`false` (`true !== true` = false → proceeds; `false !== true` = true → rejects), so the shipped dormant behavior is unchanged.
- **Positive/negative controls NOT duplicated (YAGNI).** `replaced: true` → ok is pinned by the existing happy-path test; `replaced: false` → `non_replacing_rebuild` by the existing fail-closed test. The strict change keeps both green. Only the new truthy-non-`true` guard was added.
- **Non-vacuity via matching nodeCount.** The fake returns `okReceipt` (nodeCount = facts.length), so the downstream recovery-completeness gate would pass **if reached** — the strict-equality gate (which runs first) is the *only* thing preventing a false `ok`. Under the old truthy check all 5 cases returned `ok` (RED confirmed for the right reason).
- **Truthy set includes `"false"`** — the sharpest silent false-green vector (a non-empty string that reads "false" is truthy). Mirrors `392e7db`.
- **Health message reworded but not interpolated** (code-quality LOW, security-preserving) — accurate for all non-`true` values while keeping the sink free of untrusted boundary content.

## Decisions explicitly NOT made

- **`receipt.revisionId` / `receipt.workspaceId` untyped-boundary passthrough** — security-reviewer noted `rebuildIndexFromMarkdown` passes these non-boolean receipt fields verbatim into `RebuildSuccess.receipt`. Out of this slice's truthy-vs-strict remit and dormant (no live caller). Deferred to the arming-gate hardening ledger (orch20 → Carry-forward): before binding a real `IndexRebuildClient`, confirm no serve-time consumer trusts them over the locally-computed top-level fields.
- **`"0"` truthy-string enrichment** (code-quality LOW#3) — declined; `"false"` already covers the truthy-string class more sharply.
- **Sibling truthy checks** — scoped to `:160` only. Verified `nodeCount !== facts.length` (now `:178`) is already strict `!==`; `replaced` is the sole boolean receipt field, so no other truthy-vs-strict false-green vector exists.

## TDD compliance

**Clean.** RED written first (5 parametrized cases), confirmed failing for the right reason (old truthy check → `ok`), then GREEN via the one-line strict change. Step-2.5 test design reviewed + `APPROVED.` by orch20 before Step 3. The two review-driven edits (health-message wording, test comment) are string/comment changes with no behavior change (same `non_replacing_rebuild` code + `rebuild_divergence` failureClass) — no test pins the exact message text; not a TDD violation.

## Cross-doc invariant audit

**NONE.** `IndexRebuildReceipt.replaced` stays a typed boolean; no model field added/removed/renamed. No `ARCHITECTURE.md` mirror edit required from this slice. (orch20 folds an optional §6 arc-close note at round close.)

## Reachability

Reachable from `probeRebuildOracle` (`apps/worker/src/composition/rebuildOracleStatus.ts:106`) → `rebuildIndexFromMarkdown` → the strict wholesale-replace gate. No new production symbol; no new wiring (a tightening inside an already-reachable exported function). Confirmed via grep of production consumers + codegraph.

## Open follow-ups

- **[Future TODO — arming-gate hardening]** `receipt.revisionId`/`workspaceId` untyped-boundary passthrough (above) — orch20 routing to the Carry-forward arming ledger.
- **[Convention candidate]** orch20 banking as knowledge **Lesson §2** at round close (strict `=== true` on an external-client-returned boolean at the rebuild wholesale-replace trust floor — the Lesson-28 class applied to the knowledge I/O boundary). Knowledge LESSONS has only §1 today.
- **[§6 arc note]** orch20 folding into the rebuild-oracle §6 arc-close note at round close.

## Preflight note

Package-scoped: `@sow/knowledge` typecheck clean, lint clean, tests 474 pass / 1 skip. A repo-wide `pnpm -w turbo run typecheck test` shows failures in `@sow/worker` (+ cascading `@sow/evals`/`@sow/desktop` typecheck) — these are **entirely** impl22's in-flight, untracked piece-C file `apps/worker/test/boot/rebuildOracleBinding.test.ts` (RED tests + not-yet-implemented `createRebuildOracleHealthSink` / `computeAndRouteRebuildOracle`). This slice is byte-equivalent for well-typed booleans; the pre-existing worker rebuild-oracle producer tests pass. Expected shared-tree artifact of the parallel piece C — not a regression from this slice. Round-wide green lands when piece C (073) also lands.

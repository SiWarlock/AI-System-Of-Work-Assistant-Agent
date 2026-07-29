# 128 — worker: the source-path refusal channel (13.8m-B) + zeroEgressOnly means its documented contract (9.22)

**Date:** 2026-07-29
**Track / role:** main · worker-implementer
**Predecessor session:** `docs/sessions/123-2026-07-28-worker-provisioning-race-and-durability-bounds.md`
**Successor session:** _(unwritten)_

---

## What landed

| Task | Commit | Summary |
|---|---|---|
| **13.8m-B** | `2c03b3af` | The SOURCE-path `IngestRewriteReceipt.refusals` field now reaches an optional best-effort audit sink instead of being dropped at both seam boundaries in `living-vault.ts`. |
| **9.22** | `69b10883` | `zeroEgressOnly` derived from the option-C two-axis predicate (`isZeroEgressOnlyWorkspace`) at all three producer sites, never from `!employerRawEgressAcknowledged`. `failClosedEgress`'s direction INVERTED (fault ⇒ `false`, not `true`). |

All green: **worker 154/154 files, 2006/2006 tests · packages/policy 19/19 files, 477/477 tests · typecheck clean repo-wide (turbo, 20/20 tasks).** One unrelated pre-existing failure elsewhere in the monorepo (`apps/desktop/test/bundle/main-bundle-resolution.test.ts`, an `electron-vite build` environment issue) — zero overlap with this session's territory.

---

## Why this session existed

Two independent slices from the hardening-tail's queue: 13.8m-B closes a KN-7 "rejected and audited" gap the source-path synthesis producer (13.8m-A, prior round) already carried but nothing downstream consumed. 9.22 closes the round's headline rule-5 false-assurance — `zeroEgressOnly` conflated *consent* (`employerRawEgressAcknowledged`) with *routing fact* (is the workspace actually pinned local with no cloud destination approved), so a workspace with a revoked ack but a cloud-allowlisted processor could still render "local-only." 9.22 was the owner-approved 5th and final slice of this round's tail (9.23 → 9.29 → 9.30/9.31 → 13.8m-B → 9.22).

---

## The load-bearing decisions

### 1. The fail-closed inversion, and an independent argument stronger than the brief's

The brief's premise: under the old `!acknowledged` meaning, a store fault returning `zeroEgressOnly: true` was fail-SAFE (unconfirmed ack ⇒ assume the restrictive posture). Under the new option-C meaning, `true` asserts the workspace is *provably* local-only — a fault cannot establish that — so a fault must now yield `false`.

Verified independently rather than taken on the brief's word: `validWorkspace`'s own default fixture (`providerMatrix.capabilityDefaults: {}`) already fails `isLocalOnlyProviderMatrix`'s non-vacuity conjunct, so **the "normal" baseline workspace already reads `false`** under the new predicate. A fault claiming `true` is therefore *less* justified than the already-weak baseline — not merely "no longer fail-safe," but actively asserting something stronger than what an honestly-configured, never-provisioned workspace would claim about itself. That framing is what makes the inversion self-evidently correct rather than a stipulated rule to trust, and the orchestrator recorded it as a better argument than the brief's own.

### 2. The L69 pair — correct RED, and a stale-citation correction

`egressCommands.test.ts:87` and `:182` (current lines — the brief's own text cited `:83`/`:178`, three days and several commits stale) both asserted `zeroEgressOnly === true` after a revoke. Under `employerAcked`'s fixture (inherits `validWorkspace`'s vacuous `providerMatrix`), the predicate reads `false` both before and after the revoke — so flipping these two assertions from `true`→`false` is the fix working, not a regression, per L69. Both are called out explicitly in-code as a **test-semantics change on a safety pin**, not folded into "updated tests." The orchestrator independently re-verified the line-number correction and updated L69's own pin reference so a future reader doesn't chase the stale citation.

### 3. The 7-incidental-literals count (L64: report the count, not just the fix)

Beyond the two real L69 assertions, seven other `zeroEgressOnly: true` literals exist in `api-live.test.ts`, `systemHealthReadPath.test.ts`, and `systemHealth.test.ts`. All seven are hand-rolled fake `SystemHealthQueryPort` objects exercising the tRPC projection/allowlist-fidelity layer — none routed through the real `createSystemHealthQueryPort` derivation, so `true` remains a representable, harmless canned input for those tests. Left unchanged; the deliverable here is the enumerated count with each site's classification, not a silent decision to skip them.

### 4. 13.8m-B's known bound, and a declined nit

`LivingVaultRewrite`'s widened return type keeps `refusals` **optional**, deliberately, so all 13 pre-existing `living-vault-containment.test.ts` fakes stay valid (an old-shaped fake degrades to `refusals: []` — L11 byte-equivalent silence, never a sink call). The consequence, named in-code per the orchestrator's instruction: the guarantee that a refusal is ever observed rests entirely on `createIngestRewriteAdapter` always forwarding the producer's *required* `IngestRewriteReceipt.refusals` field verbatim — pinned by `adapter_forwards_refusals_verbatim` — and a second producer bound to this seam must forward its own refusals the same way, or they silently never reach the sink.

Code-quality review flagged that `unbound_sink_is_byte_equivalent` doesn't tightly pin the `typeof sink !== "function"` guard itself (a removed guard would still pass, since the outer try/catch would swallow the resulting `TypeError`). Declined rather than "fixed with a tighter pin," per L79: a pin that can only pass because of an unrelated safety net is a pin that passes for the wrong reason, and disclosing the gap beats a pin that looks like coverage but isn't.

---

## Decisions explicitly NOT made

- **#38** (revoke-side `get`→`upsert` can still lose a concurrent rename) — not this session; recorded open.
- **#39** (a foreign `egressPolicy.workspaceId` now detected nowhere) — not this session; recorded open.
- **#32** (`boot.ts` brands operator-supplied processor strings with no blank guard) — not this session; recorded open.
- **#45** (the `AuditSignal`→`AuditRecord` pipeline has no persistence consumer) — not this session; recorded open.
- **#9 / 9.21** (idempotent scaffold repair/resume) — now unblocked (9.23/9.29/9.30 all landed), but not started this session; recorded open.
- **#44** (the §12 exactly-once suite still runs on a fake) — not this session; recorded open.

All six are explicitly OUT for this round's handoff per the orchestrator's close-out instruction — no new work opened after 9.22 shipped.

---

## TDD compliance

**Clean.** Both slices went RED-first:
- 13.8m-B: 3 of 6 new tests failed for the right reason pre-implementation (sink never invoked, adapter dropped `refusals`); the other 3 are legitimate regression guards that hold vacuously pre-implementation (nothing to swallow yet) and exercise the real path post-implementation.
- 9.22: 8 of 9 new tests failed for the right reason pre-implementation (old `!acknowledged` derivation / hardcoded `true` literals); the positive control coincidentally agreed with the old code's output for its specific fixture. The two single-axis isolation tests (`a_cloud_provider_in_the_matrix_defeats_it`, `raw_cloud_egress_flag_alone_defeats_it`) and the structural census pin were **mutation-verified**: each conjunct in `packages/policy/src/processors.ts` was temporarily disabled one at a time (never committed — `git diff --stat` confirmed a clean revert after each), confirming each test fails ONLY for its own conjunct and the census pin fires on a real reintroduced violation.

One honest note: the census pin's own regex had a security-review-caught soundness gap (prefix-only match would have let `isZeroEgressOnlyWorkspace(x) || true` slip through) — found and fixed with a both-anchored regex *before* commit, and the fix was itself mutation-verified against the exact bypass shape the reviewer named.

---

## Reachability

- **13.8m-B** — `createLivingVaultPort`/`createIngestRewriteAdapter` remain fully dormant in production (no `bootWorker` call site constructs `LivingVaultAdapterDeps` — confirmed via source-wide grep, independently re-confirmed by the security reviewer). The optional `recordRefusals` sink's concrete `HealthItem`/`HealthFailure` mint is deferred to the 13.8d arming follow-up.
- **9.22** — LIVE, not dormant: `createSystemHealthQueryPort`'s `egressStatus` (`boot.ts:564`) → `systemHealth`/`egressCommands` procedures → the desktop egress-settings surface (already built, 9.10-C). This slice changes a value a real UI reads today.

---

## Open follow-ups

1. **13.8m-C** (knowledge→worker) — the MEETING path has no refusal channel at all (producer field absent); tracked as task #43, not started.
2. **#38, #39, #32, #45, #9/9.21, #44** — all recorded OUT for this handoff (see "Decisions explicitly NOT made" above).
3. **Lessons-logged candidates** (orchestrator to write hot): (a) "a refusal channel is only real once a rejected run is distinguishable from an empty one on EVERY exit path, including the ones that reject afterwards" (13.8m-B, pinned by `refused_then_containment_rejected_still_surfaces`); (b) "when a field's MEANING changes, its fail-closed DIRECTION may invert; re-derive every default rather than carrying it over" (9.22); (c) L69 reconfirmed with its own stale-citation correction as an instance of L71 (a durable claim not carrying its conditions).
4. **Arch-doc note** (orchestrator to write hot, per brief 215) — §5: the settled `zeroEgressOnly` semantics, and that `false` means NOT ESTABLISHED, never "cloud egress is possible."

---

## How this was built

Two `/tdd` cycles in one session. 13.8m-B: brief 214, one Step-2.5 round (APPROVED as designed), one commit. 9.22: brief 215, one Step-2.5 round with an ADD (a single-axis cloud fixture, plus a volunteered sibling isolating the other axis), one commit, Step-9 routed to `team-lead` per the brief's rule-5 requirement. Both slices dispatched both reviewers (security-reviewer=invariant, code-quality-reviewer=every-slice); 9.22's security review caught the one real (if narrow) finding of the session, in my own test's tripwire rather than in production code.

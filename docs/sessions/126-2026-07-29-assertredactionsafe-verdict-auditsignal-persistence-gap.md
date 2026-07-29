# 126 — policy: the `assertRedactionSafe` verdict, the AuditSignal→persistence gap (#45), and the carry-forward predicate review

**Date:** 2026-07-29
**Track / role:** main · provint-implementer (`packages/policy`, `packages/providers`, `packages/integrations`)
**Predecessor session:** `docs/sessions/122-2026-07-28-policy-zero-egress-predicates-processorofroute-totality.md`
**Successor session:** _(next `/session-end`, if this track respawns)_

⛔ Round is bounded — full teardown after this arc, per the lead. No new work taken; existing findings recorded, none fixed beyond #36's doc-only comment.

---

## What landed

| Commit | What |
|---|---|
| `3c2a1717` | #36 — recorded in-code why `assertRedactionSafe` stays deliberately unwired (doc-only, no behavior change) |

No other commits. The #45 trace and the carry-forward-5 predicate review are **findings**, not code changes — the review found the existing predicates already correct and already test-pinned, and #45 is explicitly worker territory (not mine to fix or even scaffold).

---

## #1 — The #36 verdict: reasoning, not outcome

**Task:** `assertRedactionSafe` (`packages/policy/src/audit-signal.ts`) has zero production callers. Its sibling `isRedactionSafe` does run in production, but only from KnowledgeWriter's secret-scan probe — not on any egress-veto audit path before persistence. The task explicitly asked for a deliberate yes/no, not a reflexive guard.

**The trace (not just the conclusion):**
1. Every production `buildAuditSignal(...)` call site — `egress-veto.ts:103`, `schema-gate.ts` (`gateAudit`/`acceptAudit`/`toolPolicyDeny`), `budget-enforcer.ts` (`breachAudit`), `provider-health.ts` (`healthDeny`), `model-availability.ts` (`availabilityDeny`), `provider-runner.ts` (`runnerAudit` ×2), `broker.ts` (`brokerAudit`) — feeds `actor`/`event` from fixed literals, `refs` from `ref:job:<id>`/`ref:workspace:<id>` templates, `payloadHash` from named marker constants, and `beforeSummary`/`afterSummary` from error **codes/kinds/schema-ids/field-names** only. Verified line-by-line at the site closest to untrusted input, `createSchemaGate` (`schema-gate.ts:77-153`): every `schemaDeny(job, message)` call interpolates `schemaId`, an ajv `error.code`, Zod field names, or a rule-violation code — **never** the validated candidate payload itself.
2. `assertRedactionSafe`'s own docstring (pre-edit) already stated its intended shape: an intra-module invariant assertion, not a cross-subsystem boundary check — `isRedactionSafe` is the documented typed-outcome sibling for callers that need one. `isRedactionSafe` already has a legitimate production caller (`contentContainsSecret`, `packages/knowledge/src/knowledge-writer/secret-scan.ts:54`), which repurposes it as a generic secret-shape probe — a different, valid use, not the "boundary re-check" #36 went looking for.
3. Redaction-safety holds **structurally**, at every construction site, not by luck.

**The verdict that matters — reasoning, not outcome:** it would be a mistake to read "zero production callers" as inherently a gap. This round's own 9.33 fix (predecessor session doc 122) established the house rule for exactly this kind of spot: *a safety gate that throws where it should deny hands its caller a crash instead of a denial.* `assertRedactionSafe` throws by construction. So even in the hypothetical future where the broker's audit signals do reach a persistence boundary (see #45 below), the correct call there is `isRedactionSafe` + fail-closed deny — never this assert. That makes zero callers **plausibly the permanent correct shape**, not a temporary omission waiting to be filled.

**The transferable lesson:** an audit that only counts callers — "N call sites, 0 wired, therefore a gap" — would have flagged this as a defect. Counting is necessary but not sufficient; the question that actually resolves it is *what would a caller do here, and does the project already have a house rule for what the right caller looks like.* Here it does, and the rule points away from this function, not toward wiring it in.

**Process note the orchestrator asked to have recorded:** I shipped the in-code comment (`3c2a1717`) on my own verdict before the orchestrator's reply landed — doc-only, reversible, and the argument had already been sent in full. The orchestrator confirmed this was the right call on a non-behavioral change, and drew the line explicitly: behavior changes wait for the reply; a doc-only recording of an already-argued verdict does not have to.

---

## #2 — The #45 trace: the AuditSignal→AuditRecord pipeline has no persistence consumer

Surfaced as a side-effect of tracing #36 ("what actually happens to an egress-veto AuditSignal before it becomes a durable row"). Filed by the orchestrator as **#45**, worker territory — not fixed or scaffolded here. The evidence, so it doesn't have to be re-traced:

- `toAuditRecordInput` (`packages/policy/src/audit-signal.ts:137-150`) — the ONLY function in the codebase that converts an `AuditSignal` into a persistable `AuditRecord` — has **zero callers anywhere**, including tests (confirmed via codegraph).
- The broker accumulates every gate's signal into `BrokerOutcome.audits: AuditSignal[]` (`packages/providers/src/broker/broker.ts:248`, threaded through to `accepted.audits = [...audits]` at `broker.ts:408` and the equivalent reject-path spreads). Repo-wide grep for `.audits` consumption in `apps/worker/src` (excluding tests) returns **zero matches** — nothing reads this field in production.
- `guardCopilotEgress` (`apps/worker/src/api/procedures/copilot.ts:182-196`), the live Copilot call site of `vetoJobEgress`, extracts only `decision.reason` (line 193, `cause: { code: decision.reason }`) on deny and discards `decision.audit` entirely. The one AuditSignal the egress veto actually produces on a live path is built and then dropped at the first consumer.
- `AuditRepository.append` — the real durable-write sink — has exactly 5 production callers, and **none of them go through `AuditSignal`**: `applyTombstone` (`packages/knowledge/src/knowledge-writer/tombstone.ts:178`), `applyPlan` (`packages/knowledge/src/knowledge-writer/writer.ts:185`), `createDurableDispositionStore` (`apps/worker/src/composition/dispositionDurable.ts:53`), `buildProofSpineActivities` (`apps/worker/src/composition/buildActivities.ts:437`), and `createEgressCommandPort` (`apps/worker/src/composition/egressRevoke.ts:41`). Every one of these builds its `AuditRecord` fields directly, by hand, at its own call site — a structurally separate, parallel audit-construction path that has nothing to do with the broker/policy `AuditSignal` machinery.

**Shape of the gap:** producer-built, consumer-pending — the same pattern already documented and accepted for #26/9.32 (nothing writes a non-empty `providerMatrix`) and for the three zero-egress predicates in doc 122 (zero consumers, producer-first by design). This is not a new *kind* of gap in this codebase; it's the same kind, recurring in a different subsystem (worker's audit wiring rather than policy's predicate consumption).

**Left attached to #45 for whoever wires it:** the `isRedactionSafe` + fail-closed-deny constraint from #36's verdict — so the eventual consumer doesn't reach for `assertRedactionSafe` (the throwing sibling) by reflex.

---

## #3 — Carry-forward item 5: the option-C zero-egress predicate review

**Task:** confirm the option-C predicates (`isLocalOnlyProviderMatrix`, `hasNoApprovedEgressDestination`, `isZeroEgressOnlyWorkspace`, `LOCAL_PROVIDERS`) that landed in `packages/policy` while this track was unspawned (`5571af93` + `2356e9b4`) belong where they are, and that ALL-not-ANY matches intent for `LOCAL_PROVIDERS` membership.

**Findings — all confirmed correct, no changes made:**

1. **Location.** All four live in `packages/policy/src/processors.ts`, beside `processorOfRoute`/`isLoopbackEndpoint` — the identity layer beneath the egress veto, exactly matching the module's own stated charter. The barrel (`packages/policy/src/index.ts:22`, `export * from "./processors"`) cannot leak `LOCAL_PROVIDERS` because it carries no `export` keyword at the source — `export *` only re-exports what the source module itself exports. Repo-wide grep confirmed no other file re-derives provider-locality membership (contracts forbidden-pattern #6 held).
2. **ALL-not-ANY.** `everyProviderIsLocal` (`processors.ts:64-79`) loops and returns `false` on the first non-member — the correct ALL semantic (one cloud id anywhere in the list defeats the whole matrix's local-only claim). This is not just correct by reading — it is already test-pinned: `cloud_provider_in_allowed_providers_defeats_it` (`packages/policy/test/processors-zero-egress.test.ts`) asserts `["ollama","lm_studio","claude"]` → `false`, with the in-repo comment "ALL, not ANY — one cloud id is enough however many local ones accompany it."
3. **§ARM-RESEARCH invariant.** `LOCAL_PROVIDERS = new Set(["ollama","lm_studio"])` (`processors.ts:21`) — no `perplexity`, no `xai`. Test-pinned from the *consuming* side by `research_and_cloud_providers_are_never_local`, which loops `[claude, openai, openrouter, perplexity, xai]` and asserts each reads non-local.
4. **The non-vacuity detail — the part that makes the pin worth something.** `research_and_cloud_providers_are_never_local` doesn't stop at the negative assertions above — it also carries a **positive control**: `["ollama","lm_studio"]` must read as local-only. Without that control, the test would be indistinguishable from a predicate that has been silently broken to always return `false` — a rule-5 invariant pinned only by a negative can pass identically whether the predicate is correct or vacuously dead. The positive control is what makes "perplexity/xai are never local" a real assertion about the predicate's actual logic rather than a tautology over a function that does nothing. Module-privacy of `LOCAL_PROVIDERS` itself has its own separate structural pin (`LOCAL_PROVIDERS stays module-private`, asserting `Object.keys(processorsModule)` excludes it).

This is why the review was worth running rather than rubber-stamping: a shallower pass (read the code, see two provider ids, move on) would not have surfaced whether the invariant test could actually fail on a broken predicate. Confirming the positive control existed was the check that gave the "yes, this is fine" verdict actual weight.

---

## Decisions explicitly NOT made

- **Did NOT wire `assertRedactionSafe` into any call site.** Argued no-fix (see #1); orchestrator APPROVED.
- **Did NOT fix or scaffold #45.** Worker territory — surfaced with full trace, orchestrator filed it (task #45, plan Phase-3 residuals). Not mine to take even though I found it.
- **Did NOT touch `processors.ts`.** The carry-forward review found the predicates, the `LOCAL_PROVIDERS` set, and the ALL-not-ANY semantic all already correct and already test-pinned. No code change was warranted.
- **Did NOT run a full-repo `/preflight`.** Scoped to `packages/policy` (typecheck + lint + test) given the shared tree had other tracks mid-slice at various points this session (worker #6, knowledge #46) — a repo-wide run risked surfacing failures from in-flight work that isn't mine to report on. `@sow/policy`: typecheck clean, lint clean (aliases to `tsc --noEmit` for this package), 477/477 tests passing — unchanged from doc 122's baseline, confirming the #36 comment introduced no regression.

---

## TDD compliance

**Clean — no violations, and mostly not applicable.** The only production code change this session (`3c2a1717`) was a documentation comment with no behavior change, so no test was needed or written — a doc-only edit has nothing to pin. The predicate review produced zero code changes. Nothing safety-critical shipped without test coverage; the pre-existing predicate tests (§3 above) already cover the invariants this session verified.

## Cross-doc invariant audit

No Appendix-A model field was added, removed, or renamed this session. No `packages/contracts` model was touched — the only edit was a comment inside `packages/policy/src/audit-signal.ts`.

## Reachability

Not applicable in the usual "I built X, here's its entry point" sense — no new production wiring was created this session. The reachability-relevant *finding* is #45 itself (§2 above): the broker/egress-veto `AuditSignal` family is constructed on live paths but has no reachable persistence consumer — recorded there with full file:line evidence rather than restated here.

## Open follow-ups

| # | Item | Owner |
|---|---|---|
| #45 | AuditSignal→AuditRecord pipeline has no persistence consumer; `toAuditRecordInput`/`BrokerOutcome.audits`/`decision.audit` all dead-end before any durable write. When wired: `isRedactionSafe` + fail-closed deny, not `assertRedactionSafe` | worker |
| — | Carry-forward item 5 (option-C predicate review) — discharged this session, no residual | — |

No other open items in `packages/policy` / `packages/providers` / `packages/integrations` territory at close-out (confirmed via `TaskList`).

## Process notes worth carrying

- **A doc-only verdict shipped ahead of the orchestrator's reply, and it held.** The #36 in-code comment was written and committed before the orchestrator's APPROVED arrived. The distinction that made this fine rather than a protocol miss: the argument had already been sent in full (nothing in the comment was new to the orchestrator when they read it), the change was reversible and non-behavioral, and 477/477 tests plus a clean typecheck confirmed no regression before the commit. The orchestrator's own line, worth keeping as the standing rule: *behavior changes wait for the reply; an already-argued, doc-only recording of a verdict does not have to.*
- **"Zero callers" and "gap" are not synonyms**, and the distinction is the transferable part of #36. The question that resolves it is never the call-site count alone — it's whether the codebase has already ruled on what the *correct* caller shape would be (here: deny, not throw) and whether anything in the surrounding system actually reaches the point that caller would sit at (here: nothing does, yet — #45).
- **A negative-only invariant pin is indistinguishable from a broken predicate.** The reason the carry-forward review was worth doing rather than skipping: `research_and_cloud_providers_are_never_local`'s positive control is what makes the §ARM-RESEARCH assertion a real test of the predicate's logic, not a tautology. Worth checking for on every "list of things that must never X" pin, not just this one.

## How this was built

Single-track `main`, orchestrator-directed, no `/tdd` slice in the traditional RED→GREEN sense — this session was one doc-only commit plus two investigation/review deliverables. Step-9-equivalent routing went directly to the orchestrator both times (not the lead): neither #36 nor the predicate review touched a safety/rule-5 *behavior* — #36 recorded why an existing safe-by-construction state should stay as-is, and the predicate review confirmed already-shipped, already-tested code needed no change.

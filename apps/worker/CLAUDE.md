<!--
  TEMPLATE: area CLAUDE.md → write to <code-area>/CLAUDE.md (e.g. app/CLAUDE.md).
  One per code area. For a multi-area project, generate one per area, each with
  its own stack + launch-protocol row. Keep the launch protocol, session
  start/end protocol, cross-doc-invariants discipline, layer rule, and
  lessons-index meta-rules VERBATIM — those are workflow machinery. Fill the
  stack + commands; leave the lookup table, forbidden patterns, cross-doc table,
  and lessons index near-empty (1-2 illustrative rows + a "populate as you go"
  note). Delete this comment.
-->

# System of Work Assistant `apps/worker/` — Build Guide

> **You're in `apps/worker/`.** This file plus root `CLAUDE.md` both load. The root file covers global project conventions + shared comm rules (track-prefix, escalation taxonomy, messaging budget); this file owns code-area conventions for control-plane worker (storage · Temporal · API).

## Launch protocol

| Working on... | cwd | Loads |
|---|---|---|
| Planning / docs / commits | repo root (`SoW-build/`) | root `CLAUDE.md` only |
| control-plane worker (storage · Temporal · API) code | `apps/worker/` | this `CLAUDE.md` + root |

<!-- For a multi-area project, add a row per additional code area. -->

If you find yourself fighting the wrong conventions, check your cwd.

## Session start/end protocol

**At session start:**
1. Read `IMPLEMENTATION_PLAN.md` (repo root) **by section, not whole** — `grep -n "^##" IMPLEMENTATION_PLAN.md` for offsets, then Read with offset/limit just "Currently in progress" + the active phase. (The file grows; never load it whole.)
2. Confirm with the user what feature this session is targeting.
3. Read the relevant section of `ARCHITECTURE.md` from the lookup table below.

**At session end** (only when the user explicitly says we're done):

1. **Implementer runs `/session-end`.** Implementer writes ONLY:
   - `apps/worker/` code files (the slice's implementation)
   - test files (the slice's tests)
   - dependency manifest / lockfile (deps the slice adds)
   - `docs/sessions/<NNN>-<date>-<topic>.md` (session doc, created at `/session-end` Step 5)

   **Implementer must NOT touch (all orchestrator territory).** *This list is the canonical statement
   of the territory rule — `/session-end`, the brief template, and the generated
   `scripts/guards/territory-guard.sh` PreToolUse hook (which mechanically enforces it in team mode)
   all point here.*
   - `IMPLEMENTATION_PLAN.md`
   - `apps/worker/LESSONS.md`
   - `apps/worker/CLAUDE.md` (entire file — both the Cross-doc invariants table AND the Lessons logged index)
   - `ARCHITECTURE.md`
   - `docs/orchestrator-briefing.md` / `docs/tdd-brief-template.md` / `docs/briefs/` / `docs/runbooks/`
   - other top-level deliverable / design docs
   - `.gitignore` and root-level dotfiles (unless adding a new artifact to ignore, flagged at Step 9)

   At Step 10: **explicit `git add <path>` per slice file; never `git add -A`/`.`; never stage an orchestrator-territory file.** Changes to any orchestrator-territory file (a new cross-doc model, a lesson, an arch note) are **flagged at Step 9**, not edited here — the orchestrator writes them hot (root `CLAUDE.md` + the Step-9 matrix).

2. **Orchestrator runs `/orchestrate-end`** for round close-out + Carry-forward triage + round terminal commit + push.

## Lookup table — where to find canonical info

Don't paste these sections into the prompt. Grep the file:section, read only what you need. `/check-arch <topic>` dispatches off this table.

| Topic | File (relative to repo root) | Section |
|---|---|---|
| <subsystem A> | `ARCHITECTURE.md` | §X |
| <subsystem B> | `ARCHITECTURE.md` | §Y |
| Lessons logged (full prose) | `apps/worker/LESSONS.md` | by lesson # |

<!-- Starts near-empty. Add a row whenever a topic is looked up twice. -->

**Code intelligence & docs (when available):** prefer a code-intelligence MCP / docs MCP over grep+read loops — see root `CLAUDE.md` "Code intelligence & docs."

## Stack

<!-- ▼ EXAMPLE BLOCK [id=area-stack]: stack quick-reference for implementer sessions. Canonical stack lives in root CLAUDE.md + ARCHITECTURE.md; this is the cheat sheet. ▼ -->
- **Runtime:** Node 22 LTS + TypeScript 5.x (strict)
- **Stack:** Node/TS control-plane worker · Temporal TS SDK · Drizzle (SQLite + Postgres) · tRPC
- **Validation:** Zod + JSON Schema (ajv)
- **Lint / types / tests:** ESLint / tsc --noEmit / Vitest
- **Territory (this track owns):** `apps/worker/, packages/db/, packages/workflows/`
<!-- ▲ END EXAMPLE BLOCK [id=area-stack] ▲ -->

## Standard commands

```bash
# Install deps (run once; re-run when the manifest changes)
pnpm install

# Run the dev server (if applicable)
pnpm --filter <pkg> dev   # e.g. desktop / worker

# Tests
pnpm test

# Quality
pnpm lint
pnpm format:check
pnpm typecheck

# Preflight (use before saying "done" with a feature)
pnpm lint && pnpm typecheck && pnpm test
```

## TDD protocol

**Write the failing test first.** Applies to deterministic code — see the TDD posture in root `CLAUDE.md` for what is test-first vs. exempt.

**Commit per slice when practical.** Never bundle a safety-critical slice with anything else.

## Forbidden patterns

<!-- ▼ EXAMPLE BLOCK [id=forbidden-patterns]: forbidden patterns — 3-5 narrow, enforceable, domain-specific rules. Shape: "Don't <pattern X> because <reason / past incident>; use <alternative Y>." Test-pin them where possible. Starts small; accretes as lessons surface. ▼ -->
Do not:

1. **Write code without a failing test first** (deterministic code).
2. **Use dialect-specific SQL in domain or workflow code** — the operational store must pass ONE repository contract suite on BOTH SQLite and Postgres; Postgres is never a permanent stub.
3. **Call a write adapter (Calendar/Todoist/Linear/Asana/Drive/etc.) from a workflow or activity directly** — every external side effect routes through the Tool Gateway envelope; every semantic write through KnowledgeWriter.
4. **Apply a migration without a pre-migration backup + an app-version↔schema-version compatibility check** — a failed/partial migration must restore-and-refuse, never silently forward-break (the operational store holds non-rebuildable audit/approvals/outbox truth).
5. **Let a missed schedule replay per-tick or an in-flight resume duplicate a side effect** — catch-up collapses to one run on wake (LIFE-2); resume reuses the idempotency envelope (LIFE-3).
<!-- ▲ END EXAMPLE BLOCK [id=forbidden-patterns] ▲ -->

## Cross-doc invariants — schema/docs mirroring

Several typed models in this codebase are **contracts** mirrored in `ARCHITECTURE.md` and indexed in the table below. The architecture doc is the canonical contract; the model is the executable enforcement. Drift produces silent disagreement.

**Authoring discipline (orchestrator owns this table).** The implementer never edits this table or `ARCHITECTURE.md` directly — it flags a field add/remove/rename at Step 9 as a `Cross-doc invariant change`; the orchestrator writes the row + the arch edit hot the same round (see root `CLAUDE.md` + `docs/orchestrator-briefing.md`). Commits stagger; the working tree stays aligned within the round.

| Model | `ARCHITECTURE.md` section | Notes |
|---|---|---|
| <model> | §X | <field summary> |

<!-- Starts empty (or with the first model if one exists). Populated as contract models land. -->

## Module organization

<!-- ▼ EXAMPLE BLOCK [id=module-layout]: module layout + layer dependency rule. Replace with the project's real directory tree and import-direction DAG. ▼ -->
```
apps/worker/          control-plane process: event ingress · supervision client · tRPC server + event stream
packages/db/          Drizzle schema · migrations · repository interfaces · SQLite + Postgres adapters
packages/workflows/   Temporal workflow definitions + activities (the 13 core workflows)
```

Layer dependency direction: `apps/worker → packages/{workflows,db} → packages/{domain,contracts}`. No upward imports.
<!-- ▲ END EXAMPLE BLOCK [id=module-layout] ▲ -->

## Subagents

See `.claude/agents/README.md` for the canonical inventory + integration points.

<!-- ▼ EXAMPLE BLOCK [id=area-subagent-candidates]: area-specific subagent candidates — list candidates that would earn their keep specifically in this area (e.g. an ABI/types syncer for a frontend area, a Pyth/feed verifier for a contracts area). Build only on real friction. ▼ -->

<!-- ▲ END EXAMPLE BLOCK [id=area-subagent-candidates] ▲ -->

## Lessons logged from prior sessions

The full prose for each lesson lives in `apps/worker/LESSONS.md`. This index is the compact orientation surface.

**Lesson numbers are stable IDs** — once assigned, they don't change. New lessons get the next sequential number. `/session-end` proposes additions when it detects them; the user approves before the entry is written and a row is added here.

Lessons start at §1.

| # | Date | Topic | Rule (one-liner) |
|--:|---|---|---|
| 1 | 2026-07-12 | [On-request Copilot synthesis skills reuse a single-sourced governed core](LESSONS.md#1) | An on-request synthesis skill supplies its own retrieval + reuses `runGovernedCopilotSynthesis` (WS-8 re-guard/posture/egress-veto/candidate-gate) — never a re-implemented gate; the retrieval source varies, the safety machinery does not. |
| 2 | 2026-07-12 | [Activate a built-but-dormant boot capability with a pure fail-safe gate helper](LESSONS.md#2) | Activation = a pure `gate…() → wiring \| undefined` helper (default-OFF, thunk'd deps, owner-config not hardcoded) augmenting `bootWorker` only when opt-in + precondition both present; shipped default stays byte-equivalent to the prior boot. |
| 3 | 2026-07-12 | [A durable KnowledgeWriter-idempotency store is an operational-store repo, fail-closed both directions](LESSONS.md#3) | The `KnowledgeRevisionStore` must be a real `@sow/db` repo keyed by `idempotencyKey` (UNIQUE, first-write-wins), passing the one repo-contract suite on both dialects, fail-closed on BOTH `getByIdempotencyKey` AND `record` (reject, never mask); the in-memory Map loses exactly-once across restart. |
| 4 | 2026-07-12 | [Activate a real sole-writer commit by swapping the fake for the existing adapter](LESSONS.md#4) | Swap the fake for `createCommitActivity` over `applyPlan` (real ownership/secret defaults + a live `readVaultHeadRevision` resolver + durable store), behind the same default-OFF gate — never a new writer; verify the existing adapter honors the store's fail-closed. |
| 5 | 2026-07-13 | [A derivation must receive the per-item identity; a derived path must be traversal-safe by construction; fork a shared port rather than dishonor it](LESSONS.md#5) | Thread the per-item identity into a derivation (a static seed silently collapses many inputs to one output); derive fs paths traversal-safe by construction (hash the identity + guard every interpolated segment incl. the workspace id, narrow the input type); fork a shared port when a consumer diverges rather than forcing a dishonest param. |
| 6 | 2026-07-13 | [A trust label must be co-located with the bytes it vouches for; verify a positionally-paired array's consumer before compacting](LESSONS.md#6) | Stamping a source trusted requires rebuilding the synthesized-over `blocks` from the SAME proven bytes (never a trust label on a separate array the model reads); before compacting one of two positionally-paired arrays, verify the consumer's index-pairing and rebuild POSITIONALLY (`""` at dropped indices), never compact. |
| 7 | 2026-07-13 | [A serve-time coverage/health reader with no persisted source degrades honestly, never a green stub](LESSONS.md#7) | A real reader with an absent source returns a fail-closed constant + an in-code note naming the missing store as the injection point (not a green stub); incompleteness fails SAFE (withhold, not admit); widen a sync seam to the `MaybeAsyncResult` union rather than rippling async through every fake. |
| 8 | 2026-07-13 | [A go-live seam is AND-composed of independent OFF-locks; the shipped default stays byte-equivalent](LESSONS.md#8) | Build a dormant go-live capability as independent OFF-locks (arming flag AND provisioned key AND real coverage), each alone sufficient to keep it OFF (prove by adversarial pairwise-defeat); shipped default byte-equivalent to pre-seam; go-live logic in pure unit-testable helpers that construct nothing on the OFF path. |
| 9 | 2026-07-13 | [A secrets adapter maps every fault to a typed ref-only error, never throws, holds key bytes transiently — real I/O behind a mockable backend seam](LESSONS.md#9) | Map every fault to a typed ref-only error (fixed class token, never the value/raw detail); never throw (fail-closed on rogue kind/malformed ref/backend throw); hold key bytes transiently (never stringify/log; reject a zero-length key); fail-closed-parse the opaque ref (0 backend calls on malformed); real I/O behind a mockable backend seam so the build never touches the real store. |
| 10 | 2026-07-13 | [A CLI-backed secrets reader: args-array + absolute bin, secret only in the ok Result, de-alias bytes (a Buffer's `.slice` shares memory)](LESSONS.md#10) | Args-array + absolute bin (no shell/PATH); secret only in the ok Result (fault path never reads stdout); classify faults by stderr pattern + live-verify note (a fault never maps to code 0); bound+scrub debug detail; DE-ALIAS returned bytes via `new Uint8Array(subarray)`, NEVER `.slice` (a Node Buffer's slice shares the backing pool — a heap-leak vector). |
| 11 | 2026-07-13 | [A real-I/O adapter is boot-wired behind an owner-provisioning gate — default-absent ⇒ inert/byte-equivalent](LESSONS.md#11) | Boot-wire real I/O behind an owner-provisioning gate (default-absent ⇒ inert, byte-equivalent, real backend/process built ONLY on the provisioned path — pin with a factory-spy zero-invocation assertion); source the live consumer fail-closed (`gate?.x ?? fallback`, optional ⇒ omission degrades); defer a routing whose call-site is dormant to a named follow-up, don't wire dormant-on-dormant. |
| 12 | 2026-07-13 | [A serve-time trust-signal store is a fail-closed `@sow/db` operational-store repo behind a narrow fakeable read-port — deterministic latest-ordering + read-back identity re-gate](LESSONS.md#12) | A serve-time trust-signal store = a dual-dialect `@sow/db` repo (contract suite + additive migration + idempotent-first-write-wins on id) fronted by a narrow fakeable read-port that REJECTS on fault; store the frozen report as-is + re-gate it through its schema on read; fail-closed BOTH directions distinguishing a fault (degrade) from a true no-row; make latest-ordering DETERMINISTIC with a secondary id tiebreak (no dialect-arbitrary same-timestamp winner shadowing a dirty report); re-gate IDENTITY on read-back (parsed ws/rev == query key, else typed err) so a tampered row can't surface cross-workspace (WS-8). |
| 13 | 2026-07-13 | [Wiring a db-backed (async) source into a sync serve-time reader: widen the seam to the async sibling's union + keep the new dep OPTIONAL so the unbound seam degrades byte-equivalently](LESSONS.md#13) | Make the reader's fn `async` + convert its own direct-caller tests to `await` in-slice (the return type changed — not scope creep); widen the CONSUMING seam to the sync-or-async union mirroring the async sibling already on it (existing sync fakes stay valid, `await` no-ops) rather than rippling `Promise` through every fake; keep the new source dep OPTIONAL so the unbound seam degrades byte-equivalently and boot is untouched until a later composition-root slice binds the real adapter; fail-closed rides the reader's all-legs-degrade `catch` (a source reject never crosses, never a false green); ship one leg at a time (a sibling leg stays at its degraded constant). |
| 14 | 2026-07-13 | [A worker-side "record-only-on-ok" gate over a knowledge-layer reconcile Result — record VERBATIM, a reconcile err is a typed SKIP never a stored clean report, a sink fault REJECTS](LESSONS.md#14) | A worker-side record gate over a knowledge reconcile `Result` records the report VERBATIM only on `ok` (`isErr` early-returns before the sink; forward BY REFERENCE, never synthesize the trust fields `cleanForServing`/`coverageComplete`); a reconcile `err` is a typed `skipped` disposition never coerced into a stored clean report; a sink `DbError` REJECTS (fault ≠ skip, both fail-closed, reusing the read-port's fault-rejection helper for rule-7); record dirty reports too (a defect report is the serve-time degrade signal); type-only-import the knowledge output types (no knowledge→db edge); record from the full-coverage producer; ship dormant + waivered until a trigger slice. |
| 15 | 2026-07-13 | [A promise-REJECTION test whose assertions live only inside `.catch(cb)` is VACUOUSLY GREEN if the code ever resolves — capture the reason + assert unconditionally](LESSONS.md#15) | Never let a rejection test's assertions live only inside `.catch(cb)` — it passes vacuously if the code resolves (silent green on the pinned property, worst on a safety/redaction pin). Capture the rejection reason (`.then(() => { throw … }, e => e)` or `rejects.toThrow`) + assert UNCONDITIONALLY so a resolve fails loudly. |
| 16 | 2026-07-13 | [The waiver-holder CLOSING slice — bind the real adapter as a NESTED arg INSIDE the existing dormancy gate (byte-equivalent), distinguish construction from selection, prove the chain with a write→read e2e, green ONLY the legs it wires](LESSONS.md#16) | Close a waiver-holder chain with ONE composition-root entry binding the real adapter as a NESTED arg INSIDE the existing dormancy gate (lazy eval ⇒ byte-equivalent shipped default); distinguish the CONSTRUCTION guard from the SELECTION gate (an unarmed-but-built capability is inert); prove the chain via a write→read round-trip e2e over a REAL repo (green-on-write integration coverage; the boot line itself via typecheck + `/wired`, not a `bootWorker` RED); green ONLY the legs it wires + ASSERT the AND-verdict still degrades on any deferred leg (never a fake full-green), pinning the other legs true so a degrade is provably its cause not a swallowed fault. |
| 17 | 2026-07-13 | [The last coverage-leg seam — make a hardwired-false trust-gate leg BINDABLE via an OPTIONAL fail-closed resolver; the AND-gate becomes green-CAPABLE (≠ armed), still DORMANT; the heavy status PRODUCER (real I/O) stays a deferred owner-gated deliverable](LESSONS.md#17) | Make a hardwired-false trust-gate leg BINDABLE with an OPTIONAL fail-closed resolver dep (mirror the sibling boot-resolved leg; `deps.resolve?.() ?? false` inside the reader's try/catch — unbound ⇒ false byte-equivalent, throw ⇒ all-legs-degrade, never defaults true); the LAST such leg makes the AND-gate green-CAPABLE — prove it with a milestone test, but keep green-CAPABLE (fakes in a unit test) DISTINCT from ARMED (production leaves the resolver unbound + the live-select gate off); separate the no-I/O serve-time SEAM (this slice) from the heavy status PRODUCER (real I/O — a deferred owner-gated build-time deliverable), never folding the producer's I/O into the serve path. |
| 18 | 2026-07-14 | [The producer→gate→sink composition seam — record before route, a sink fault propagates, own composition not input/trigger](LESSONS.md#18) | A composition helper over a producer→gate→sink pass owns composition only (never input construction or trigger); record BEFORE route so a store fault REJECTS before any routing (a pass that didn't durably land surfaces nothing — distinct from a reconcile-error skip that records+routes nothing), and a sink fault PROPAGATES (never a silent drop of a trust-defect signal); match the sink port to exactly what the producer emits + defer the richer OBS-2-dedupe binding to where the surface is in scope; narrow via the producer's `isOk` (a disposition tag can't) + keep an explicit durably-landed clause as documentary defense; ship dormant + waivered, exercised by the REAL producer over fakes. |
| 19 | 2026-07-14 | [A read-only-adapter → DB-facts projection builder is fail-closed on coverage — any fault/truncation/malformed/absent-version ⇒ complete=false; conservative trust flags; workspace from the grant](LESSONS.md#19) | A read-only-adapter → DB-facts projection builder is fail-closed on the coverage flag (complete=true ONLY on a clean fully-consumed well-formed read; any read err / adapter rejection-or-non-Result / truncation-or-open-cursor [TYPE-ROBUST: non-boolean/non-string still degrades] / malformed row-or-envelope / absent-or-non-positive version ⇒ complete=false, never a throw, never a false-complete); map trust flags conservatively (stamped on explicit ===true only ⇒ an unstamped db_only fact stays quarantine-visible); source workspaceId from the grant-bound adapter not a caller param (WS-8); emit a numeric degrade sentinel ONLY with complete=false; the positive-completeness-token upgrade needs the real transport shape (owner-gated). |
| 20 | 2026-07-14 | [A committed-vault → fact-set composition returns a 3-way outcome (derived/absent/derive_error), re-gates the read-back workspace, names the collapsing-reader coverage gap](LESSONS.md#20) | A committed-vault → fact-set composition returns a 3-way outcome (derived / absent / derive_error) so a benign absence and a broken-vault defect route differently (never collapse to undefined); wrap the injected reader's CALL in a try/catch so sync-throw + async-reject both degrade to absent (don't rely on a never-throw contract across an injected boundary); re-gate the read-back workspaceId against the request (WS-8/Lesson 12), degrading to absent on mismatch without foreclosing a caller ws-mismatch health signal; NAME (in-code + Future TODO) any coverage gap a collapsing dependency creates rather than silently owning it; test with the REAL producer. |
| 21 | 2026-07-14 | [A trigger-agnostic driver composes injected async collaborators (runs unchanged under either trigger model), catches only the collaborator with a designed rejection channel, relies on the never-reject ones](LESSONS.md#21) | Compose an end-to-end driver over INJECTED async collaborators (not module imports) so it runs unchanged under either trigger model — deferring the workflow-weight choice to the trigger piece — and keeps the test style injection-uniform (no vi.mock); short-circuit a benign/broken upstream before the expensive downstream read; surface a defect TYPED (defer HealthItem materialization to where the surface binds); catch ONLY the collaborator with a designed rejection channel into a distinct typed outcome + rely on the never-reject builders (don't double-wrap); the trigger/boot piece MUST bind deps only to the never-reject builders (the Promise<…> type doesn't encode it) + redact the outcome's cause/error before any log sink (safety rule 7). |
| 22 | 2026-07-14 | [A pure trigger-origin scheduler burst-collapses (LIFE-2), snapshots-and-deletes the queue before the await, redacts through a single sink chokepoint; the workflow-weight is the lighter pass for an idempotent read+record](LESSONS.md#22) | The trigger-origin for an idempotent re-triggerable pass is a PURE scheduler (enqueue + externally-triggered flush), NOT a Temporal workflow (durability is over-engineering for read+record; pure collapseToMaxRevision is the LIFE-2 burst-collapse; crash→degrade→next-trigger is fail-safe); burst-collapse to ONE max-revision dispatch per flush; SNAPSHOT-and-DELETE the queue BEFORE the dispatch await so a mid-flight enqueue lands in a fresh queue + a re-flush is a no-op (pin with a deferred-driver concurrency test); route the outcome through a SINGLE redacted-summary sink so no downstream can leak the raw cause/error (the safe kind+ws+revision+code still mints the HealthItem); isolate per-workspace; leave the real source/timing/health/arming to the boot gate. |
| 23 | 2026-07-14 | [An arming seam is a default-OFF gate helper — strict ===true guard-first + a factory-spy zero-invocation OFF pin; the owner-gated input stays unbound so even the armed path degrades; split the pure helper from the composition-root edit](LESSONS.md#23) | An arming seam is a default-OFF gate…(opts,deps)→wiring\|undefined helper — OFF guard FIRST + STRICT ===true (never a truthy-coerce false-arming vector), returning undefined + ZERO dep-thunk invocations on OFF (factory-spy-pinned ⇒ byte-equivalent shipped default); keep the owner-gated real input UNBOUND so even the armed path DEGRADES (never a false-green — prove it end-to-end through the real downstream); SPLIT the pure gate helper (added byte-equivalent BY CONSTRUCTION, no composition-root edit) from the bootWorker/composition-root wiring (its own focused-review commit) so a byte-equivalence slip on the seam is isolated; building the seam crosses no hard line — the arming (flip + provision + govern) is the owner's. |
| 24 | 2026-07-14 | [A read-capability activation gate offers the tool only when it can actually serve — a fail-safe usability predicate mirroring the reader's filter exactly, gated after the flag/config preconditions, narrowing-only](LESSONS.md#24) | A read-capability activation gate offers the tool only when it can serve: AND a fail-safe usability predicate that mirrors the downstream reader's filter EXACTLY (usable ⟺ the-reader-would-find-a-result; a looser check — a `notes.md/` dir without isFile(), or a shallow scan missing a nested note — is a fail-OPEN re-offering the inert tool) AFTER the cheap flag/config preconditions early-return (so the OFF default never touches the fs), fail-safe throw⇒inert (double try/catch); prove it's a STRICT SUBSET (narrows only, never widens), byte-equivalent on a real source, changing only WHEN the tool is offered, never the read scope. |
| 25 | 2026-07-14 | [Resolve a dormant-era swallow on a safety-critical sink to the propagate-contract before arming; the pass taxonomy catches the fault, the faulted outcome mints a HealthItem from the safe redacted code, the terminal sink stays never-throwing](LESSONS.md#25) | Resolve a dormant-era best-effort swallow on a safety-critical ROUTING sink to the propagate-contract before arming (a swallow drops operator visibility on a real defect once armed); rely on the pass's outcome taxonomy to CATCH the now-propagating fault (reject→driver's designed channel→a typed faulted outcome, no unhandled rejection escapes the trigger flush — pin end-to-end over the real sink); make the faulted outcome health-worthy by minting a HealthItem from the SAFE redacted code ONLY (a typed causeCode, never the redacted message/stack — safety rule 7), a fixed `arch_gap` literal fallback (guard the falsy-code edge), a stable subjectRef, and an EXISTING FailureClass (no frozen-taxonomy expansion); keep the TERMINAL mint/log sink UNCONDITIONALLY never-throwing (a downstream flush relies on it) — the routing sink propagates, the terminal sink swallows. |
| 26 | 2026-07-14 | [A coverage/completeness contract fails closed with a POSITIVE token (default-incomplete), not a negative more-results probe (which fail-opens on an unknown/absent field); widen the rejected set type-robustly + cross-check every present stated total; token + field names stay a documented candidate](LESSONS.md#26) | A serve-time completeness/coverage flag fails closed with a POSITIVE token (default-incomplete, STRICT `===true`), never a NEGATIVE more-results probe (fail-opens on an unknown/absent pagination field); keep more-results rejection as an additional type-robust WIDENED lever (all known field names; benign-falsy pinned not to over-degrade) + cross-check EVERY present finite stated total vs the raw row count (not first-finite, so a conflicting pair degrades); coverage floor stays unconditional (a token can't rescue malformed/err/absent-schema); token + exact field-NAME set = a documented candidate (arch_gap, Lesson 21) confirmed at arming — a field named OUTSIDE the set is the dangerous silently-missed direction. |
| 27 | 2026-07-14 | [Gate a hardcoded external-effect transport behind a default-OFF AND-composed owner seam — HARDER to enable, enabling nothing; shipped default byte-equivalent](LESSONS.md#27) | Gate a hardcoded external-effect transport's SELECTION through a pure default-OFF helper: a non-stub chosen ONLY on an AND of independent OFF-locks (strict `enabled === true` flag AND an owner-injected factory), each type-robust/fail-closed so a malformed config degrades to the stub (never arms/throws at boot); real factory UNBOUND ⇒ shipped default byte-equivalent + dormant, factory-spy zero-invocation OFF pin; makes the effect HARDER to enable, enables nothing (envelope + arming untouched). Extends L8/11/23. |
| 28 | 2026-07-14 | [Every owner-gated arming `=== true` check earns a truthy-not-`true` regression guard; where no runtime seam exists, a key-anchored source-assertion with a RED-on-weaken mutation proof is a valid pin](LESSONS.md#28) | Pin every arming `=== true` check with a truthy-not-`true` guard (incl. the string `"false"`) — behavioral + co-located positive control where a runtime seam exists; where inline with no lightweight seam (a behavioral test is env-gated/skipped; the pure fn can't cover a leg it truthy-checks internally) + refactor out of scope, a KEY-ANCHORED source-assertion (expression + destructured-key anchored to the specific site, whitespace-tolerant) with a RED-on-weaken SOURCE-MUTATION proof is a valid deterministic pin, not a brittle match; record in-code WHY. |
| 29 | 2026-07-15 | [A serve-time trust-status producer + its client-presence-gated boot gate + the waiver-closing binding](LESSONS.md#29) | Build the producer as a LOCAL-derivation + owner-gated prod-UNBOUND-injected-client composition (fail-closed, only a full corroboration ⇒ true, never-throws, no-pin-on-frozen-snapshot); its boot gate is CLIENT-PRESENCE-gated (OMIT the factory to stay dormant — a `() => undefined` reads as ON + won't typecheck; provisioning ≠ arming) + byte-equivalent by construction; the binding closes the waiver client-unbound + `await compute()`-once + AND-binds the accessor + routes divergence health safe-fields-only (sink propagates / boot caller contains / containment signal guarded) + ASSERTS the AND-verdict still degrades by default (no false green). |
| 30 | 2026-07-15 | [Immutable workspace-binding anchor on every workspace-bound operational record](LESSONS.md#30) | A workspace-bound operational record's binding anchor (`workspaceId`, or a field deriving the isolation class like workspace `type`) is immutable-by-default — guard the create/register path get-before-upsert (same-binding idempotent, changed-binding ⇒ typed `*_immutable`, get-fault fails closed); the guard is COMPOSITION-layer so every writer must preserve the binding (a direct `repo.upsert` bypasses it); the only escape hatch is an owner-gated + audited reclassification, never a silent flip / weakened guard. `pattern: grep -n "\.upsert(" apps/worker/src/composition` — a new direct upsert of a ws-bound record wants the guard. |
| 31 | 2026-07-15 | [Structural no-arming — type arming flags as literal `false` (+ `Object.freeze`)](LESSONS.md#31) | When a config/defaults layer must be unable to arm a hard line regardless of selection, make it STRUCTURAL — type the arming flags as literal `false` (+ safe posture literal like `"isolated"`) so a config that arms won't typecheck, and `Object.freeze` the closed-defaults constant (TS `readonly` is compile-time only); keep a behavioral test as backstop but the type is load-bearing; tier divergence lives in non-arming fields only. `pin: apps/worker/test — presetProfiles no_profile_arms_a_hard_line + tsc`. |
| 32 | 2026-07-15 | [Cross-workspace read is default-CLOSED — approved+directional+scoped link only, sanitized slice only](LESSONS.md#32) | A WS-8 cross-read opens ONLY through an owner-approved, directional, SCOPED link, and even then ONLY the sanitizer's OUTPUT crosses (never raw bytes; re-gate each crossing row's workspaceId===link.toWorkspaceId, extends L12); scope is in the immutable anchor (silent widening = bypass, extends L30) + NOT NULL (no scopeless all-of-B); revoked is terminal; one-way; fault fails closed; link carries its own status (frozen Approval untouched); gate reachability-waivered when consumers dormant (L11). `pin: crossWorkspaceRead.test.ts absent_link_yields_zero_bleed + raw_content_shaped_row_fails_closed + scopeless_link_crosses_nothing`. |
| 33 | 2026-07-15 | [Connector→ingestion bridge: every record through the candidate gate, idempotent key, skip-poison vs HOLD-dispatch-fail, payload structurally excluded](LESSONS.md#33) | A connector→ingestion bridge routes EVERY record THROUGH registerSource (candidate gate, never around it, rule 2) with an idempotent content-versioned key (=Temporal workflowId, L16); scoped fields from the BOUND instance, `record.payload` STRUCTURALLY excluded (WS-8/no-inference, hostile-payload.workspaceId pinned); SKIP+observe a registration-rejected poison record but HOLD the page (cursor stays, REQ-I-005) on a dispatch failure; fakes-only, reachability-waivered until Phase-16 binds the drive path (L11). `pin: connectorIngestionBridge.test.ts source_workspace_from_bound_instance_not_content + record_failing_registration_does_not_dispatch + dispatch_failure_holds_the_page`. |
| 34 | 2026-07-15 | [A persisted content-dedupe store is a first-write-wins WS-8-scoped `@sow/db` repo; a `has`-fault PROCEEDs (Temporal is the real exactly-once backstop)](LESSONS.md#34) | A persisted content-dedupe store (`SeenContentHashRepository`) = a dual-dialect `@sow/db` repo keyed WS-8-scoped `(workspaceId, contentHash)` (a hash seen in A never dedupes in B), first-write-wins (`ON CONFLICT DO NOTHING` keeps the original `seenAt`), restart-durable, fail-closed both directions (store fault ≠ benign not-seen, extends L3); it is a pre-dispatch OPTIMIZATION so a `has`-fault PROCEEDs to registerSource+dispatch (the Temporal `src:ws:hash` workflowId AlreadyStarted-dedupe is the real exactly-once backstop, L16), NEVER HOLD (a persistent fault would block the whole connector); ship honest typed-errs, defer the caller HOLD/PROCEED interpretation to the Phase-16 binding. `pin: seen-content-hash-durability.test.ts fault_is_a_typed_err_both_directions + dedupe_is_workspace_scoped`. |
| 35 | 2026-07-15 | [A make-it-real note projection consumes the gate-validated body VERBATIM, degrades absent/empty, keeps the path body-independent, threads via a forked port](LESSONS.md#35) | The note-body projection writes the note body VERBATIM from the gate-validated `SourceEnvelope.body` (never raw-around-the-gate, no transform, rule 2), degrades an absent-OR-empty body to a safe minimal real note (`_No extracted content yet._`, L15 — never placeholder/empty/failure), keeps the note PATH structurally body-independent (only `SourceNoteIdentity` keys `deriveSourceNotePath` — a hostile multiline/`../../` body derives an IDENTICAL path AND planId, traversal-safe/WS-8, L5), commits through the unchanged sole KnowledgeWriter `applyPlan` (rule 1), and threads the body as an OPTIONAL trailing param on the FORKED `SourceBuildOutputsPort.build` (not rippling the shared `ValidatedExtraction` into meeting/hermes, L5; additive-optional keeps existing callers valid, L15). `pin: sourceNoteBodyProjection.test.ts note_path_is_body_independent + body_written_is_exactly_the_threaded_gate_validated_value`. |
| 36 | 2026-07-15 | [A durable ingestion-disposition store; a server-side-operational-only raw envelope; a replay-safe re-enter through the gate](LESSONS.md#36) | A durable ingestion-disposition store (`SourceDispositionRepository`) = a first-write-wins dual-dialect `@sow/db` repo, exactly-once by the CAS disposition key (a re-record HIT reuses the prior audit ref, inv-A/inv-B), fail-closed both directions (fault ≠ benign absence, L3); the parked raw `SourceEnvelope` (incl. the 15.2 body) is SERVER-SIDE-OPERATIONAL-ONLY re-entry state — never rendered (the UI-safe `ingestionInbox` projection stays the sole render path) nor logged, audit summaries-only (rule 7); the re-enter runner re-drives THROUGH the candidate gate (rule 2, never raw-around-gate) reusing the original `idempotencyKey` so an already-committed source replays over the `KnowledgeRevisionStore` (no duplicate, rule 3/inv-D), and the rescope's owner workspace override is registry-validated (WS-8, never a raw bind). `pin: dispositionDurable.test.ts reenter_redrives_through_the_candidate_gate + reenter_reuses_idempotency_key_replays + rescope_registry_validates`. |
| 37 | 2026-07-15 | [An auto-ingest watcher excludes its OWN output subtree (via the producer's shared constant) to break the write→re-ingest feedback loop](LESSONS.md#37) | An auto-ingest vault watcher (default-OFF `SOW_INGEST_WATCH`) excludes its OWN ingestion-note output subtree so a written note doesn't re-fire it (source → KW-writes-note.md → re-fire → re-ingest loop); root-anchored + segment-safe (`rel === "sources" || rel.startsWith("sources/")` — `sources/x` excluded, `mynotes/sources/x`+`sourcesX` NOT), applied guard-BEFORE-I/O in BOTH entry paths (direct `computeOutcome` after `isMarkdown`/before realpath AND the `onEvent` pre-filter so no debounce timer arms), surfacing a typed `ignored/output_subtree` (never a silent drop); references the SAME `SOURCE_NOTE_SUBTREE` constant the producer (`deriveSourceNotePath`) uses (one literal — an output-path change can't silently drift and re-open the loop); stays narrow (a user `.md` outside `sources/` still ingests). `pin: vaultWatcher-live.test.ts output_subtree_onEvent_arms_no_timer_zero_dispatch + exclusion_matches_real_derived_output_path`. |

<!-- Starts empty. Each row links to its `LESSONS.md` anchor. -->

<!-- Slash commands: see root CLAUDE.md "Slash commands available." Implementer pair: /session-start + /session-end. -->

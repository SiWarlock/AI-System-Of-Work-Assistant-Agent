# Session 093 — worker-impl3 · Phase-18 S8+S9 (egress-veto assembled-broker pin + auto-ingest strict-arming guard)

- **Date:** 2026-07-17
- **Phase:** Part II — Phase 18 (§19.5 real ModelProvider) — SAFE-BUILD; the LAST two safe-build slices (S8, S9). Phase-18 safe build S1–S9 now COMPLETE.
- **Track / role:** worker (single-track `main`) · implementer `worker-impl3` (successor to `worker-impl2`, cycled at a clean slice boundary — no lost work)
- **Orchestrator:** `orch2` (successor to `orch`, cycled mid-session; see "Decisions made")
- **Predecessor session:** [092-2026-07-17-worker-impl2-phase18-s5-s7-source-legs.md](092-2026-07-17-worker-impl2-phase18-s5-s7-source-legs.md)
- **Successor session:** [094-2026-07-17-worker-impl4-cp3b-cp5b-crossing-prereq.md](094-2026-07-17-worker-impl4-cp3b-cp5b-crossing-prereq.md)

## Why this session existed

Phase 18 (the real ModelProvider build) is being built DORMANT/MOCK ONLY — no real cloud key, no real `security add-generic-password`, no real model API call, no real spend; the crossing (#13) is owner-gated. S1–S7 landed under worker-impl2. This session carried the final two safe-build slices, both **verify+pins over already-built safety code** (no production change):

- **S8 / 18.9** — pin the Employer-Work egress veto (safety rule 5) at the **real assembled broker** level.
- **S9 / 18.10** — add the missing Lesson-28 truthy-not-`true` regression guard on the auto-ingest boot arming gate.

## What was built

### Files created
- `apps/worker/test/composition/egress-veto-assembled.test.ts` (S8, 18.9 — commit `55f0a33a`) — 5 tests over the worker's **real assembled broker** (`assembleBackends` → default `vetoJobEgress` + default `resolveJobRoute`, NOT injected fakes) with **raw employer content**:
  1. cloud (claude) + employer + raw + ack-OFF ⇒ DENY `EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED` at stage `egress_veto`, `healthClass` `NO_ELIGIBLE_PROVIDER`, no candidate (no cloud fallback);
  2. OpenRouter cloud ⇒ DENY (classified CLOUD → its own processor, never laundered to a local ALLOW);
  3. loopback-local (ollama 127.0.0.1) ⇒ ALLOW + runs zero-egress on the dormant stub (`usage.runtimeSeconds===1` = no real call);
  4. **veto DENIES even when the processor IS allowlisted** (the veto runs BEFORE the allowlist — folded in per security-review);
  5. **tunneled-`local`** (egressClass `"local"` but a REMOTE endpoint, allowlisted in `localConfig` so route-resolution passes) ⇒ treated as EGRESS + DENIED (anti-laundering edge, folded in per both reviewers).

### Files modified
- `apps/worker/test/boot-auto-ingest-gating.test.ts` (S9, 18.10 — commit `29555821`) — appended a Lesson-28 `describe` block: an `it.each` over the truthy-non-`true` vectors `["true", 1, "false", {}]` (each `as unknown as boolean`) ⇒ `gateAutoIngest(...)` returns `undefined` + the proof-spine `build` thunk NEVER invoked; plus a **co-located positive control** (literal `true` DOES arm) proving the guard narrows on strictness (non-vacuity, not a blanket deny). No gate CODE change.

### Commits
- `55f0a33a` — `test(worker): 18.9 pin the Employer-Work egress veto at the real assembled broker (rule 5)`
- `29555821` — `test(worker): 18.10 pin the auto-ingest boot gate strict-arming against a truthy-not-\`true\` vector (L28)`

(HEAD `29555821`, ahead of origin — **not pushed**; push is orch2's `/orchestrate-end` round-close.)

## Decisions made

- **Both slices framed honestly as verify+pins (no production change).** Step-1 traces confirmed the veto (`vetoJobEgress` + policy `egressVeto`/`processorOfRoute`) and the gate (`gateAutoIngest` strict `!== true` @ boot.ts:627) are already built + robust. The genuinely-new coverage:
  - **S8:** driving the worker's REAL assembled broker with raw employer content — no existing test did this (providers `egress-veto.test.ts` uses injected fakes; 18.1's `egress_veto_precedes_run_leg` uses a fake deny-veto; the existing `assembleBackends` dormancy test uses `carriesRawContent:false`, so the veto never bites). Catches a worker-side wiring regression (veto dropped/overridden in the real assembly, or OpenRouter miscategorized).
  - **S9:** the existing combos cover `true`/`false`/`undefined` but no truthy-non-`true`; the gate is the SOLE arming chokepoint (verified: only 2 `autoIngest` refs in `apps/worker/src`; desktop worker-host `index.ts:219` passes `config.autoIngest` RAW — no host-side `=== true`), so one gate-side pin covers the desktop activation path too.
- **S8 — folded in 2 reviewer-converged hardening tests** (rule 5 is the phase's sharpest invariant, cheap + strictly safer): the veto-beats-allowlist pin (security's strongest dropped-veto guard) and the tunneled-local anti-laundering pin (both reviewers). Also softened T2's over-claiming "not an OpenAI alias" comment (that distinctness lives in the policy `processorOfRoute`/`LOCAL_PROVIDERS` unit tests; the assembled level pins CLOUD→deny) and dropped one redundant assertion.
- **S9 — did NOT fold in the SEC nit (add `"0"`/`[]` vectors).** Distinct from S8: `!== true` rejects ALL truthy uniformly, so the 4 representative shapes (looks-true string, number, the load-bearing `"false"` string, object) are a complete sample; the reviewer explicitly said don't-gate-ship. The CQ "sole chokepoint" comment nit was resolved by **verifying** the desktop-raw claim (accurate), not softening.
- **Non-vacuity proven both slices (L28):** S8 — a personal-workspace mutation flips the reason to `PROCESSOR_NOT_ALLOWED` (RED), plus the cloud-DENY/local-ALLOW contrast. S9 — the co-located positive control is the L28-canonical mechanism for a runtime-seam site; a RED-on-weaken source mutation was attempted but classifier-blocked mid-run and reverted clean (`boot.ts` `git diff` EMPTY, confirmed). orch2 confirmed the aborted mutation leaves zero gap.
- **Orchestrator cycle mid-session (`orch` → `orch2`):** the dispatching orch cycled at the S8 boundary. A late message from the terminating `orch` (claiming the successor "reuses the name `orch`") contradicted the lead's identity update (`orch2`) and was treated as stale/phantom per the phantom-message defense; confirmed with the lead before proceeding. All S8/S9 review + commit routing went to `orch2` (the lead + orch2's liveness confirmed it). No work lost.

## Decisions explicitly NOT made (deferred)

- **The Phase-18 owner CROSSING (#13) — untouched.** No real cloud key provisioned, no real `security add-generic-password`, no real model API call, no real spend. For S8: the **leakage-eval** (zero raw employer content on a real cloud egress) requires a real cloud call ⇒ crossing. For S9: the real **arming** (owner sets `autoIngest=true` in the desktop host + threads the source `stubExtraction` precondition) ⇒ crossing. Both owner-gated; lead takes the go/no-go.
- **Deferred low nits (non-blocking, no scope cut):** S8 — the `as unknown as` fixture casts (consistent with the sibling `provider-runner.test.ts` convention; tightening = churn, no safety gain). S9 — the `"0"`/`[]` truthy vectors + a shared `expectWiredFor` DRY helper (optional; brief-sanctioned L28 co-location).

## TDD compliance

**Clean.** Both slices are test-only verify+pins over already-built code — the tests ARE the slice (no production impl to precede). RED-first satisfied trivially; each slice was reviewed at Step-2.5 (orch2 `APPROVED.` both) before finalize, ran green, and had its non-vacuity demonstrated (S8 mutation-proof; S9 co-located positive control). No TDD violations. No safety-critical TDD skips.

## Cross-doc invariant audit

**No model field changes this session.** S8 reuses `EgressPolicy` / `ProviderRoute` / `AgentJob`; S9 reuses `AutoIngestGateOpts` / `AutoIngestWiring`. Both flagged **Cross-doc: NONE** at Step 9; orch2 confirmed. No `ARCHITECTURE.md` / Appendix-A edit owed. No drift.

## Reachability

- **S8 (18.9):** targets the already-reachable §7 broker pipeline — `assembleBackends` → `broker.runJob` (the live meeting/source job path); the egress veto sits at the `egress_veto` stage (admission → route_resolution → egress_veto → health → … → run). No new production surface (test-only).
- **S9 (18.10):** `gateAutoIngest` (boot.ts:627) is production-reachable via the desktop worker-host (`apps/desktop/worker-host/index.ts:217` calls it + spreads the result into `bootWorker`); default OFF ⇒ `undefined` ⇒ today's exact degraded boot. No new production surface (test-only).
- No tested-but-unwired gaps introduced.

## Open follow-ups

- **Crossing #13 (owner-gated, tracker item):** S8 leakage-eval (zero raw employer content on a real cloud egress) + S9 real arming (owner `autoIngest=true` + source `stubExtraction` threading). Both require a real cloud call / real activation — the owner's go, not an impl slice.
- **Optional future-hardening (non-blocking):** S9 `"0"`/`[]` truthy vectors; a shared `expectWiredFor(r, WS)` helper to DRY the wired-shape literal (3 copies). S8 fixture-cast tightening. All defer-accepted by orch2.
- **Reviews:** S8 + S9 both security-reviewer CLEAR (invariant PASS) + code-quality SHIP; 0 findings that survived. Nothing routed still-open.

## How to use what was built

Nothing to operate — these are safety-invariant regression pins. They guard against a worker-side wiring regression silently re-opening the Employer-Work egress veto (rule 5) or false-arming the auto-ingest loop via an env/IPC truthy-coerce. They run in the standard worker suite (`pnpm --filter @sow/worker test`).

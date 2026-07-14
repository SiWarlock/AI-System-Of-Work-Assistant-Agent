# Session 070 — external-write transport owner-gate + propose-arming strict-equality guard (13.10 small-fix round)

- **Date:** 2026-07-14
- **Phase / task:** 13.10 (Tier-5 external-action arming-prep hardening) — SMALL FIX ROUND (dormant hardening + coverage)
- **Team:** `session-734f946b` · orchestrator `orch19` · implementer `impl21` (worker area) · lead `main`; single-track on `main`
- **Predecessor:** [069-2026-07-14-impl20-dormant-arming-prep-arc.md](069-2026-07-14-impl20-dormant-arming-prep-arc.md)
- **Successor:** _(none yet)_

## Why this session existed

A dormancy audit at the close of the prior round surfaced two hardening gaps at the owner-gated arming boundary — both dormant, both safety-relevant, neither an arming action:

1. **External-write transport had no owner gate.** The outbound `AdapterTransport` (per-target vendor write client) was built eagerly with a hardcoded `createStubAdapterTransport()` at the composition root (`backends.ts:720`). Swapping in a real vendor client was a one-line **source edit** — unlike propose (`copilotProposeMode`) or auto-ingest (`autoIngest`), it had no owner gate.
2. **The three propose/serving-oracle false-arming `=== true` checks were unguarded against silent weakening.** A future refactor changing any `=== true` to a truthy check could let a non-boolean truthy config (`1`, `"false"`, `{}`) silently arm the go-live path.

Both are pre-arming hardening: they make arming **harder / regression-proof**, cross no hard line, and keep the shipped default byte-equivalent.

## What was built

### Files modified
- `apps/worker/src/composition/backends.ts` (Slice 1) — added `WriteTransportGate` interface + `writeTransport?` field on `BackendsConfig`; added pure `selectAdapterTransport(gate?)` helper (default-OFF, AND-composed OFF-locks: strict `enabled === true` AND `typeof make === "function"`, both fail-closed to the stub); swapped the hardcoded `createStubAdapterTransport()` call site for `selectAdapterTransport(config.writeTransport)`. Real factory ships **UNBOUND** ⇒ shipped default byte-equivalent + dormant.
- `apps/worker/test/api/procedures/servingContextLoader.test.ts` (Slice 2) — extended the existing `selectServingOracleFactory — boot dormancy pin` block with a parametrized truthy-not-`true` `goLiveArmed` guard (`1`,`"true"`,`"false"`,`{}`,`[]` ⇒ interim degraded, NOT `loaderBacked`) + a co-located `goLiveArmed === true ⇒ loaderBacked` positive control (self-contained non-vacuity).

### Files created
- `apps/worker/test/composition/backendsWriteTransportGate.test.ts` (Slice 1) — 18 tests: default⇒stub (byte-equiv), factory-spy zero-invocation on all OFF paths, strict `=== true` (incl. `"false"`), malformed-`make` fail-closed, AND-lock pairwise-defeat, gate-ON positive control, assembly smoke.
- `apps/worker/test/boot/proposeArmingStrictEquality.test.ts` (Slice 2) — 3 tests: key-anchored source-assertion pinning `boot.ts:1171` (`provenanceStampingEnabled: config.copilotProvenanceStamping === true`), `boot.ts:1173` (`goLiveArmed: config.copilotServingOracleGoLive === true`), and `servingContextLoader.ts:239` (`if (sel.goLiveArmed === true`) all use strict `=== true`. Carries a "DO NOT upgrade to a behavioral test" rationale note.

### Commits
- `462a7c7` — `fix(worker): 13.10 Slice-1 — gate external-write transport selection behind a default-OFF owner seam`
- `392e7db` — `test(worker): 13.10 Slice-2 — regression guard pinning the propose/serving-oracle arming checks stay strict === true`

## Decisions made

- **Slice 1 config shape = gate object** `writeTransport?: { enabled?: boolean; make?: () => AdapterTransport }` on `BackendsConfig` (mirrors the `keychainSecrets` idiom; two OFF-locks co-located). Approved at Step 2.5.
- **Slice 1 `make` lock uses `typeof gate.make === "function"`** (not `!== undefined`) — folded from code-quality review. Fails **closed** to the stub on a malformed (non-function) JSON/env-sourced config rather than throwing at boot; symmetric with the type-robust strict `=== true` on `enabled`.
- **Slice 1 seam scope = `BackendsConfig` only** — no `BootConfig`/env plumbing this slice (dormant-on-dormant; folds into the arming binding, like the reconcile Item-6 deferral).
- **Slice 2 boot-leg mechanism = key-anchored source-assertion** (orchestrator-approved). Behavioral pinning is impossible for `:1171` (the pure `selectServingOracleFactory` truthy-checks `provenanceStampingEnabled` at `:238`) or a non-pin (a `bootWorker` test is `SOW_API`-gated ⇒ skipped in the default suite), and refactor-to-a-helper is barred by the zero-production-change mandate. The regexes are expression + destructured-key anchored (pin `:1171` specifically, NOT the separate `:1148` construction guard) and whitespace/newline-tolerant.
- **Non-vacuity proven by source mutation** (the "failing-first" analog for a regression guard): Mut1 (`:239 === true` → `&&`) ⇒ 6 RED (5 pure-fn + loader assertion); Mut2 (`:1171/:1173 === true` → `!!config.X`) ⇒ exactly the 2 anchored boot assertions RED (loader assertion stayed green — specificity confirmed). Both mutations restored via `git checkout`; source tree verified clean.
- **Both slices: real factory / real transport stay UNBOUND / OFF; no hard line crossed.**

## Decisions explicitly NOT made (deferred)

- **`BootConfig`/env plumbing for the write-transport enable flag** — deferred to the owner-gated arming binding (speculative unconsumed code if wired now).
- **Extracting the two inline boot arming-mappings into a pure `armFromConfig` helper** — would make `:1171`/`:1173` behaviorally pinnable and retire Slice-2's source-assertion. A production change, out of scope for a zero-production-change slice; orchestrator noted it as a future Carry-forward.
- **Reconcile-gate strict `=== true`** — noted as a possible future regression guard; NOT folded into Slice 2 (audit named only the propose/serving-oracle trio).
- **No arming, no real I/O, no propose flip** — the whole round stays at the owner-gated ARMING GATE.

## TDD compliance

**Clean.**
- Slice 1: RED test written first (`selectAdapterTransport is not a function`, 12 fail / 1 pre-existing anchor pass), then implemented to green. Mandatory dual review (external-write trust boundary): security **CLEAR (0 findings)** + code-quality **SHIP** (2 lows folded).
- Slice 2: test-only regression guard. The failing-first discipline is satisfied by the mutation proof (each guard goes RED when the pinned `=== true` is weakened, then restored). code-quality **SHIP** (2 lows folded); security review skipped per Step-8 policy (invariant-coverage-only, zero production surface — orch-blessed).

No TDD violations. No safety-critical TDD skips.

## Cross-doc invariant audit

**No changes.** Slice 1 added `WriteTransportGate` + `BackendsConfig.writeTransport` — worker-internal **composition-config seams**, not Appendix-A frozen shared contracts. The shared `AdapterTransport` contract is unchanged (only referenced). Slice 2 is test-only. No `ARCHITECTURE.md` Appendix-A / `packages/contracts/CLAUDE.md` invariant-table edit required.

## Reachability

- **Slice 1 — `selectAdapterTransport`:** reachable from `bootWorker` → `assembleBackends` (composition root). Production takes the **stub/default** branch (`config.writeTransport` unset). The armed `gate.make()` branch is **dormant / owner-gated** (real factory ships UNBOUND — grep-confirmed no production binder) — reachability-waivered for the armed branch (standard arming-seam pattern). Confirmed at Step 7.5 + by the security review's codebase-wide grep.
- **Slice 2:** N/A — test-only regression guard over already-wired production code (`selectServingOracleFactory` reachable from `bootWorker:1170`; the two config legs inline in `bootWorker`). No new production symbol.

No tested-but-unwired gaps introduced.

## Open follow-ups

Step-9 routing (orchestrator-owned; accepted hot this round, land on `/orchestrate-end`):
- **Findings:** NONE (both slices).
- **Cross-doc invariant changes:** NONE.
- **ARCHITECTURE §8 note (Slice 1):** `AdapterTransport` per-target write client is now owner-gated (default-OFF `WriteTransportGate`; Tier-5 external-action arming-prep), mirroring the reconcile/keychain arming seams. Orch accepted; writes hot at close-out.
- **Worker LESSON #27 (Slice 1):** proposed prose below.
- **Worker LESSON #28 (Slice 2):** proposed prose below.
- **Future Carry-forward:** extract `armFromConfig` pure helper to make `:1171`/`:1173` behaviorally pinnable and retire Slice-2's source-assertion (orch to note at close-out).

### Proposed LESSON #27 (worker) — Slice 1
**Gate a hardcoded external-effect transport behind a default-OFF AND-composed owner seam so the effect is HARDER to enable, enabling nothing.** When a per-target external-write client is constructed by a hardcoded call at the composition root (a one-line source edit swaps in the real vendor), gate its **selection** through a pure default-OFF helper: a non-stub transport is chosen ONLY when an AND of independent OFF-locks holds — a strict `enabled === true` flag AND an owner-injected `make` factory (`typeof === "function"`), each **type-robust / fail-closed** so a malformed JSON/env value degrades to the stub (never arms, never throws at boot). Ship the real factory UNBOUND ⇒ shipped default byte-equivalent + dormant; pin the OFF path with a factory-spy zero-invocation assertion. Extends L8/11/23 to the external-write transport seam; the §8 envelope and the arming (flip + provision) stay untouched / owner's.

### Proposed LESSON #28 (worker) — Slice 2
**Every owner-gated arming `=== true` check earns a truthy-not-`true` regression guard (incl. the string `"false"`); where no runtime seam exists, a key-anchored source-assertion with a RED-on-weaken mutation proof is a valid deterministic pin — not a brittle string-match.** A strict `=== true` arming check can silently weaken to a truthy coercion under refactor; pin it with a parametrized truthy-not-`true` guard (`1`/`"true"`/`"false"`/`{}`/`[]`) + a co-located positive control (self-contained non-vacuity). When the check is inline with no lightweight runtime seam (a `bootWorker` behavioral test is env-gated/skipped ⇒ a non-pin; the pure fn can't cover a leg it truthy-checks internally) and a refactor-to-helper is out of scope, a **source-assertion** is the only deterministic always-running pin: make it expression + destructured-key anchored (pin the specific site, not a look-alike guard elsewhere), whitespace-tolerant, and **prove non-vacuity by source mutation** (weaken ⇒ RED, restore) — the mutation proof is what makes it rigorous rather than a brittle match. Record in-code WHY it's a source-assertion so a future reader doesn't "upgrade" it to a broken behavioral test.

## How to use what was built

- **Slice 1:** to arm a real external-write transport (owner-gated, future), pass `assembleBackends({ writeTransport: { enabled: true, make: () => <realTransport> } })`. Absent/false either lock ⇒ the deterministic stub. No real transport client exists yet — building/binding one is a separate owner-gated arming step.
- **Slice 2:** the guard fails if any of the three arming `=== true` sites is weakened. If a config field is deliberately renamed, update the anchored regex in `proposeArmingStrictEquality.test.ts` (a rename is itself a signal). Do NOT convert it to a behavioral test (see the in-file rationale).

# Session 100 — `/phase-exit 18` crossing gate (CLEAR) + 18.28 security-MEDIUM hardening (orchestrator)

- **Date:** 2026-07-18
- **Phase:** 18 (§19.5 Real Model Transport & Intelligence Legs) — the formal phase-exit gate over the now-LIVE subscription ENABLE crossing
- **Role / track:** main-orchestrator, single-track `main`, team `session-4f4687dd`
- **Predecessor:** [`098-2026-07-18-phase18-subscription-enable-golive-worker-impl.md`](098-2026-07-18-phase18-subscription-enable-golive-worker-impl.md) (the maiden-run go-live) + [`099-…-providers-legs.md`](099-2026-07-18-phase18-subscription-providers-legs.md)
- **Successor:** [`101-2026-07-19-phase18-pre-arm-hardening-worker-impl.md`](101-2026-07-19-phase18-pre-arm-hardening-worker-impl.md) (the 3 Carry-forward burndown slices: 18.28 shadowing-env / 18.29 note-projection / 18.30 auto-ingest verify-and-pin)
- **Outcome:** ✅ `/phase-exit 18` crossing gate **CLEAR**; the 1 security-MEDIUM hardened in-round (18.28); Phase 18 recorded **crossing GO-LIVE (source leg) complete — NOT a full phase tick** (owner call).

## Why this session existed

The prior round sealed + pushed the subscription ENABLE crossing (18.11–18.27, GO-LIVE `7180a49a`). This orchestrator round runs the **formal phase-exit gate** over that now-LIVE path as a separate round — the auditor fan-out + spec/coverage/preflight rows — then, on the owner's call, hardens the one gate finding and seals.

## What was done

**`/phase-exit 18` crossing gate — CLEAR (all 11 rows).** Materialized a fresh crossing-gate checklist (distinct from the 2026-07-17 safe-build `/phase-exit 18` over 18.1–18.10) scoped to the crossing diff `6d6d94bd..HEAD`. Deterministic rows: task-checkboxes (18.11–18.28), preflight runnable gates (worker 1802/0 [pre-18.28] → 1803/0, providers 361/0, contracts 723/0, typecheck 20/20), cross-doc invariants (the one frozen add — `agent_extraction`/18.11 — carries its Appendix-A row + green snapshot), spec-coverage (`spec-lint tests 18` PASS), dep-audit (0-vuln), session-docs (094–100), push-verify. Lint/format-check **waived** (lead-authorized; pnpm-exec eslint/prettier env gap, non-code, pre-existing).

**4 auditors dispatched in parallel — all CLEAR** (full reports in `docs/audits/18-crossing-*.md`):
- **arch-drift** — 0 DRIFT; 1 low STALE-DOC (§19.5 Symbols bullet `http-transport.ts` → `real-http-transport.ts`/18.18b) fixed in-round (`ARCHITECTURE.md:491`). All 4 safety mechanisms verified + test-pinned.
- **reachability (worker + providers)** — 0 unreachable / 0 dead; armed path reachable e2e; 18.27 schema registered (`backends.ts:602`) → gated (`:824`); dormant seams L11-waived + binding-site-confirmed.
- **security (phase-boundary)** — 0 crit / 0 high / 1 medium / 3 low; all 7 safety invariants PASS at the real assembled broker.

**18.28 — security-MEDIUM hardening (owner call, before the seal).** Authored brief `142` (spec-lint PASS `@e9451a31`) + dispatched to worker-impl; landed `6ebe07a8`. `SUBSCRIPTION_SHADOWING_ENV_KEYS` 8→13 (add lowercase `http_proxy`/`https_proxy`, `ALL_PROXY`+`all_proxy`, `ANTHROPIC_CUSTOM_HEADERS`; `NO_PROXY` deliberately excluded). Closed the Class-B fail-OPEN. TDD + security-reviewer + code-quality dual-CLEAN (0 crit/high/med); `some()` guard body unchanged (L61); a set var DEGRADES the arm fail-closed (L52/L62), never crashes boot (boot-side degrade test added). worker 1803/0.

**Hot-routing (orchestrator, this round's seal commit):** worker **L65** (+ `apps/worker/CLAUDE.md` index) — completing an explicit-extensible shadowing/redirect env guard (both proxy cases, exclude the bypass-allowlist, over-inclusion is fail-safe); runbook `phase-18-subscription-enable-decision.md` CHECKPOINT-1 marked **RESOLVED**; the ARCHITECTURE.md:491 stale-doc fix; the 3 non-blocking audit findings routed to Carry-forward (the MEDIUM now DELETE/resolved).

## Decisions made

- **Phase-completion (owner call): crossing GO-LIVE (SOURCE leg) complete; NOT a full phase tick.** The gate is CLEAR and the source leg is live + safe, but the phase's acceptance breadth stays owner-deferred (meeting.close arming = Finding-F, the model-driven eval-class runs, a live `ProposedAction` real-`targetSystem`, auto-ingest arming, the note-projection alignment). Recorded in the Acceptance-criteria(18) status note + "Currently in progress" + Log.
- **Harden the security-MEDIUM in-round rather than defer it** (owner call) — a fresh worker-impl ran 18.28 before the seal, closing the code-backstop fail-OPEN pre-employer-raw-arming.
- **Waive lint/format-check** (lead-authorized) — the pnpm-exec eslint/prettier gap is environmental + pre-existing; the crossing/18.28 touched no tooling/deps; the worker area's own `lint` = `tsc --noEmit` (clean).

## Decisions explicitly NOT made (deferred)

- **The deferred phase breadth** — meeting.close cloud arming (Finding-F), the eval-class validation, a live ProposedAction real-targetSystem, auto-ingest arming (autonomous recurring spend, owner-gated), the note-projection↔extraction-schema field-name alignment (L49 fail-safe held; Carry-forward). Future rounds.
- **The 3 non-blocking audit LOWs + the reachability hygiene** (dead `gateSubscriptionExtraction`; `apiKeyHelper` owner-checklist; runtime-seconds cap; meetingValidate-ordering-info) — Carry-forward.

## Reachability / cross-doc

- Reachability: the crossing's armed path + 18.28's guard are reachable e2e (crossing reachability audits + 18.28 rolled Step-7.5 into the existing call site — constant-only extension, no boot edit).
- Cross-doc invariants: NONE this round beyond the already-recorded `agent_extraction` Appendix-A row; 18.28 is a worker-internal constant (no frozen surface).

## Preflight status (`/orchestrate-end`)

Runnable gates GREEN (typecheck 20/20; worker 1803/0, providers 361/0, contracts 723/0; `pnpm audit --prod` 0-vuln; `spec-lint tests 18` PASS). Lint/format-check waived (env gap). Round sealed locally; **push is OWNER-RUN** (lead relays `git push`).

## How to use what was built

Phase 18's live path is source-leg-complete + gate-CLEAR. The follow-up rounds pick up the deferred breadth. Before the FIRST employer-raw armed run, the residual runbook CHECKPOINT-1 items (live-docs re-verify of the shadowing set + `NODE_EXTRA_CA_CERTS`/`apiKeyHelper` owner checks) must close — the code guard is now full-set (18.28).

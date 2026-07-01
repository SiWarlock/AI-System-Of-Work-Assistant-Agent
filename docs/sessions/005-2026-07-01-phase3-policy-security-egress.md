# Session 005 — Phase 3: Policy, Security & Egress (`@sow/policy`)

- **Date:** 2026-07-01
- **Predecessor:** `004-2026-06-30-phase2-operational-storage.md` (Phase 2 — operational storage, CLEAR)
- **Operating model:** single-operator, Workflow-driven (Claude Code, ultracode). NOT an agent team.
- **Outcome:** **Phase 3 COMPLETE + CERTIFIED (`/phase-exit 3`: CLEAR).** `packages/policy` — the §5 decision core (four hard denials, egress veto, ING-7 admission gate, pure session-auth primitive) — built, green (173 tests), and certified by both reviewer sub-agents. A 6-lens adversarial-verify pass caught 5 real bugs (1 CRITICAL egress-veto bypass), all fixed + regression-tested.

> **Cold-start note:** self-contained. Resuming with fresh context → read this doc + `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + the target phase) + memory `system-of-work-prd`, then use the **Resume prompt** at the bottom.

---

## Headline

Phase 3 builds `@sow/policy` — the governed decision core all §6/§7/§8 consumers sit behind. Every decision is a typed, **pure**, **fail-closed**, audit-emitting, **redaction-safe** `PolicyDecision`. It lands the **four §5 hard denials** (safety rules 4/5/6 + write-adapter-outside-gateway) and is the **first real consumer of the candidate-data gate composition Finding** (Phase-1 LESSONS §3). Built via one Workflow fan-out: foundation → wave1 → wave2 (egress spine) → synthesis → adversarial verify.

## Scope (7 tasks, `packages/policy` greenfield)

| Task | Deliverable | Files | Hard denial |
|---|---|---|---|
| 3.1 | `PolicyDecision<T>` + four-hard-denial `DenialReason` taxonomy + clock-free `AuditSignal` (+ package scaffold) | `decision.ts` · `denials.ts` · `audit-signal.ts` · `index.ts` | — (REQ-NF-001) |
| 3.2 | Workspace policy resolution + visibility levels + cross-workspace raw-retrieval DENY | `workspace-policy.ts` · `visibility.ts` | **#2** DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL |
| 3.3 | Provider-matrix route resolution (deterministic, allowlist-bound, no implicit fallback) | `provider-matrix.ts` | — (REQ-S-005) |
| 3.4 | EgressPolicy enforcement + Employer-Work raw-content egress VETO | `egress.ts` · `processors.ts` | **#1** EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED |
| 3.5 | ToolPolicy eval + ING-7 untrusted-content admission gate + gate-composition discharge | `tool-policy.ts` · `admission.ts` | **#3** UNTRUSTED_CONTENT_MUTATING_TOOL + **#4** WRITE_ADAPTER_OUTSIDE_GATEWAY |
| 3.6 | Approval policy predicate (fail-closed requiresApproval; auto-allow private-only) | `approval-policy.ts` | — (REQ-F-012) |
| 3.7 | Renderer↔worker session-auth **primitive only** (mint/verify + Origin/Host allowlist) | `session-auth.ts` | — (REQ-S-004/NF-004) |

## Decisions (this session)

- **Workflow shape = serial-foundation + parallel-consumers, NOT an independent fan-out.** Unlike Phase 1's 27 independent models, Phase 3 has a real intra-phase DAG (3.1 → 3.2 → {3.3 → 3.4}, 3.6; 3.5/3.7 need only 3.1). So the workflow serializes the foundation (3.1) + the second dep-hub (3.2 via wave-1), then fans the consumers, then a synthesis stage wires the barrel + runs the full suite, then adversarial skeptics.
- **Gate-composition Finding discharged at the §5 consumer (3.5).** `admitCandidateJob(candidate)` composes `validate()` (ajv structural) + `AgentJobSchema.parse` (the Zod `.refine` layer ajv drops) + the ING-7 predicate. A biconditional test proves ajv-alone ADMITS a `read_only` ToolPolicy with `allowsMutating:true` while the composed gate REJECTS it. (Advances/discharges the Phase-1 carry-forward for the §5 path; §7/§9 consumers still to follow.)
- **`AuditSignal` is clock-free (purity).** `packages/policy` is pure — no clock — so decisions emit a timestamp-free `AuditSignal`; the impure caller stamps `occurredAt` via `toAuditRecordInput(signal, occurredAt)` → an `AuditRecord`-shaped object. (Same pure/impure split the domain layer uses.)
- **OWNER-APPROVED DEFERMENT (2026-07-01): task 3.7 apps/* wiring → Phase 7/9.** Task 3.7 lists 3 wiring files in `apps/worker` + `apps/desktop`, but those app shells hold only CLAUDE.md/LESSONS.md today (no package.json/tsconfig) — the files would be un-typechecked orphans. Owner approved shipping **only the pure `session-auth.ts` primitive** in `packages/policy` this phase (fully TDD'd) and deferring the wiring: `apps/worker/src/api/auth-guard.ts` → **Phase 7** (when the worker shell lands), `apps/desktop/main/session-token.ts` + `apps/desktop/preload/inject-token.ts` → **Phase 9** (desktop shell).

## Findings & carry-forward

- **Adversarial verify (6 lenses) found 5 real findings — all fixed + regression-tested** (`test/adversarial-regressions.test.ts`, RED→GREEN confirmed):
  1. **CRITICAL — egress-veto bypass (safety rule 5).** `processors.ts extractHost` stripped URL userinfo (`@`) BEFORE isolating the authority, so `http://evil.com/@127.0.0.1` (and path/query/fragment/backslash/scheme-less variants) was misread as host `127.0.0.1` → `isLoopbackEndpoint`=true → `processorOfRoute`=null → the Employer-Work egress veto ALLOWED raw employer content to a remote host with ack OFF. **Fix:** isolate the authority (strip path/query/fragment + backslash) BEFORE userinfo; tighten `file:`/`unix:` to inspect the authority; harden `processorOfRoute` vs null/neither/both-key routes.
  2. **MED — endpoint credential leak (safety rule 7).** Raw `route.endpoint` (can carry `user:pass@host` basic-auth) was placed verbatim in AuditSignal refs. **Fix:** host-only `endpointHostRef()` + a `URL_USERINFO_CREDENTIAL` pattern in the redaction guard.
  3. **MED — approval-gate bypass (REQ-F-012).** `requiresApproval` auto-allowed external writes to every target but telegram (a deny-list). **Fix:** inverted to an auto-allow-ELIGIBLE allow-list `{calendar}` (the sole §9 Flow-6 sanctioned surface).
  4. **MED — `resolveRoute` fail-open.** Prototype-member capability names (`constructor`/`__proto__`/…) read an inherited member → garbage-route ALLOW. **Fix:** `Object.hasOwn` guard.
  5. (defense-in-depth) `processorOfRoute` null/neither/both-key hardening (folded into #1's fix).
- **Candidate-data gate composition FINDING — DISCHARGED for §5.** `admitCandidateJob` (`admission.ts`) composes ajv `validate()` + `AgentJobSchema.parse` (the `.refine` layer ajv drops) + the ING-7 predicate; a biconditional test proves ajv-alone admits a `read_only`+`allowsMutating:true` ToolPolicy that the composed gate rejects (LESSONS §3). Still open for §7 broker + §9 meeting validator.
- **New carry-forward:** `policy_denial`/`egress_status` OBS-2 health classes (named constants; add to `FailureClass` enum if §16 wants distinct items) · the Phase-7 broker must always supply `resolveRoute`'s `localConfig` (arch-drift AMBIGUOUS) · wire `isRedactionSafe` into the emit path (security `[low]`) · approval-policy taxonomy + candidate-settable `approvalPolicy` firm up at §8/§9.
- **Pre-known arch_gap (from the brief):** the frozen `FailureClass` enum has no `policy_denial` member — the `AuditSignal.healthSignalClass` is abstracted behind a named constant `POLICY_DENIAL_HEALTH_CLASS` and left OPTIONAL (a DENY is often correct fail-closed behavior, not a health fault). Pin a `policy_denial` OBS-2 class upstream if §16 wants distinct policy-denial health items. (Same one-line-swap pattern as Phase-2's `db_unavailable`.)
- **Still open from Phase 1/2:** candidate-data gate composition (now discharged for §5; §7/§9 remain); `db_unavailable` OBS-2 enum add; HealthItem persistence → Phase 10 (approved); ESLint/Prettier still placeholders.

## Process note

ONE Workflow fan-out (14 agents, ~37 min) — **no burst-stall this run** (unlike Phase 1's 8-agent die-off and Phase 2's parity-repair stall). All 5 stages completed clean: foundation (16 tests) → wave-1 (3.2/3.5/3.7 parallel) → wave-2 (3.3→3.4 chain + 3.6) → synthesis (barrel + 134 tests green) → 6-lens adversarial verify. **The verify stage was the story:** unit tests alone (134 green) would have shipped a CRITICAL egress-veto bypass; the adversarial skeptics (each `xhigh`, prompted to REFUTE) found it + 4 more. Repair was done inline (not a second workflow) with regression tests encoding each exact bypass — RED confirmed against the buggy code, then GREEN after the fixes. Then a formal `/phase-exit 3` with two reviewer sub-agents that **independently re-derived** every fix as closed.

## `/phase-exit 3` — verdict

**CLEAR** (2026-07-01).
- [x] All 3.1–3.7 + acceptance (3) ticked (3.7 apps/* wiring = owner-approved deferment → Phase 7/9).
- [x] `/preflight` — 173 `@sow/policy` tests + 1158 repo-wide green; typecheck clean (contracts/domain/db/policy); `pnpm audit --prod` clean; lint = `tsc` placeholder; `format:check` waived.
- [x] Spec coverage — every module `spec(§5)`-tagged; four hard denials + gate-composition biconditional pinned by tests.
- [x] **`arch-drift-auditor`: CLEAR** — 6 anchors / 30 statements, 0 DRIFT / 0 STALE-DOC / 1 AMBIGUOUS (`localConfig` optional → Phase-7 broker contract, no security regression). `docs/audits/phase3-arch-drift.md`.
- [x] **`security-reviewer`: CLEAR** — safety rules 4/5/6/7 all PASS; all 5 fixes independently re-derived as closed; no new critical/high; 1 low defense-in-depth → carry-forward. `docs/audits/phase3-security.md`.
- [x] Reachability judgment-waived (no `@sow/policy` consumer until §7 broker/Phase 5 + §9 workflows/Phase 7).

## Commit map (Phase 3)

| Commit | What |
|---|---|
| `bc18914` | feat(policy): Phase 3 §5 — the whole `@sow/policy` package (12 modules + tests) incl. the 5 adversarial-verify fixes + regression suite |
| _(this doc + plan/DECISIONS/audits sync + phase-exit)_ | Phase-3 close-out |

---

## Resume prompt (cold start → Phase 4/5/6)

> Resume the System of Work Assistant build (repo: SoW-build, `main`, pushed to origin). **Phases 0–3 are COMPLETE and certified.** Phase 3 (`@sow/policy`, §5) shipped the governed decision core: the four hard denials (Employer-Work egress veto · direct cross-workspace raw-retrieval · ING-7 untrusted-content admission · write-adapter-outside-gateway), deterministic allowlist-bound provider-matrix resolution, a fail-closed approval predicate, and the pure renderer↔worker session-auth primitive — all typed PolicyDecisions, PURE, fail-closed, audit-emitting, redaction-safe. **173 `@sow/policy` tests; repo-wide 1158 green; typecheck + `pnpm audit --prod` clean.** Read `docs/sessions/005-…` (this handoff) + `004-…`, memory `system-of-work-prd` + `solo-session-full-closeout` + `workflow-fanout-burst-stall-repair` + `workflow-concurrency-rate-limits`, and `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + the target phase).
>
> **Phase 1 + 3 unblock the wave — Phase 4/5/6 may now run concurrently** (all gate on `1, 3`, satisfied; no edges between them: P3→P4, P3→P5, P3→P6 are independent branches). **Run them 2-at-a-time** (rate-limit-conservative per memory `workflow-concurrency-rate-limits` — the owner is rate-limit-sensitive; ≤2 concurrent workflows, narrow `parallel()` batches ~≤3–4, retry only failed agents). Recommended order: **Phase 4 (§6 Knowledge/GBrain/GCL — KnowledgeWriter, write-through/divergence layer, GCL Visibility Gate; the biggest phase, ~20 tasks incl. the amended 4.14–4.20 write-through set) + Phase 5 (§7 Provider/Runtime Broker)** first, then **Phase 6 (§8 Connector/Tool Gateways)** (Phase 6 is on the critical path 3→6→7).
>
> **Carry forward (see plan Carry-forward for full detail):** (1) **candidate-data gate composition** — DISCHARGED for §5 via `admitCandidateJob` (the reference pattern: ajv `validate()` + `AgentJobSchema.parse` + predicate); the §7 broker + §9 meeting validator MUST reuse it, never ajv alone. (2) `policy_denial`/`egress_status` OBS-2 health classes are named constants — pin as `FailureClass` enum members if §16 wants distinct items. (3) The §7 broker must always supply `resolveRoute`'s `localConfig`. (4) session-auth apps/* wiring is an owner-approved deferment → Phase 7 (worker guard) / Phase 9 (desktop mint+inject). (5) `db_unavailable` OBS-2 add; HealthItem persistence → Phase 10 (approved); wire `isRedactionSafe` into the emit path; stand up real ESLint+Prettier.
>
> **Method:** single-operator + Workflow fan-outs; honor TDD (deterministic code test-first) + the eval path for LLM-driven generation; Zod-as-source for any new contract; **run a strong adversarial-verify stage** on safety-critical phases (it caught a CRITICAL egress bypass in Phase 3 that unit tests missed); commit per batch (explicit `git add`, Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context)`); push origin/main. **Run the FULL close-out discipline per memory `solo-session-full-closeout`** — session doc, hot-routing, `/orchestrate-end` (incl. Step-5.5 Carry-forward triage), and a formal `/phase-exit <n>` with the arch-drift + security reviewer sub-agents. Effort: ultracode. Don't touch `.env`/`scaffold/`.

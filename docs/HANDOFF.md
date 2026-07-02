# System of Work Assistant — Build Handoff (current state)

> **Single current-state entry point.** Updated 2026-07-02, after **Phase 8 (§10 Local App API) + Phase 10 (§16 cross-cutting)** landed + certified (Phases 0–8 + 10 certified; the worker-wiring proof spine runs live on real Temporal). For per-phase detail see `docs/sessions/NNN-*`; for binding project decisions see memory `system-of-work-prd`; the authoritative task tracker is `IMPLEMENTATION_PLAN.md`.

## TL;DR

- **Repo:** `SoW-build`, branch `main`, **everything committed + pushed to origin/main** (latest code commit `2a54480` + the session-010 close-out docs on top; remote `git@github.com:SiWarlock/AI-System-Of-Work-Assistant-Agent.git`). Working tree clean.
- **Phases 0–8 + 10 are COMPLETE and CERTIFIED.** **Phase 8 (§10 Local App API)** — loopback tRPC + WS push-stream, per-launch session-token + Origin/Host auth (constant-time, anti-DNS-rebind, loopback-only), UI-safe projection field-allowlist (WS-8/§10), read-model queries + commands (approval exactly-once cross-channel), `tracked()`/`lastEventId` stream with fail-closed over-horizon resync, §12 auth/leakage suites + the <2s dashboard benchmark. **Phase 10 (§16 cross-cutting)** — non-bypassable redaction+logger, error-routing taxonomy, 3 persistent operational-truth tables (health/schedule/lease), System-Health surface, worker supervision + degraded modes + backup/recovery + config/time. Both **`/phase-exit`: CLEAR** (all 6 auditors — `docs/audits/phase{8,10}-{arch-drift,security,reachability}.md`).
- **Repo-wide: 2973 tests green + 5 gated skip + 2 todo; typecheck 10/10 packages clean; `pnpm audit --prod` clean.**
- **Next:** the **Phase-8/10 app-shell wiring wave** (mount the loopback API server + live authed round-trip test + swap the persistent stores into the live composition — the direct analog of the worker-wiring wave that followed Phase 7), then **Phase 9 (Electron Desktop UI, desktop track)** which consumes the §10 API + owns the Electron-main supervisor spawn + renderer WS handshake. (Deferrals documented in `IMPLEMENTATION_PLAN.md` Carry-forward + session 010.)

## What the product is

A Mac-first, local-first, self-hosted personal operating system — a **governed local control plane over Obsidian-compatible Markdown** — spanning employer work, side projects, and personal life. Architecture sentence: *candidate-data-in, validated-and-policed-out; Markdown is the only canonical semantic truth and KnowledgeWriter is its only autonomous writer.* Binding contract = `ARCHITECTURE.md`; 13-phase build plan = `IMPLEMENTATION_PLAN.md`.

## Phases delivered (all CERTIFIED)

| Phase | Package(s) | What |
|---|---|---|
| 0 | — | de-risk spikes (Electron/GBrain/Hermes/providers/streaming/perf) — all GO |
| 1 | `@sow/contracts`, `@sow/domain` | 27 frozen Zod-as-source seam models + JSON-Schema gate + the 6 DOMAIN_MODEL state machines + key builders + validators |
| 2 | `@sow/db` | dual-dialect operational store (SQLite + Postgres/PGLite) passing ONE repo contract suite; migration/backup/degraded-mode |
| 3 | `@sow/policy` | §5 governed decision core: 4 hard denials (egress veto, cross-workspace, ING-7, write-adapter-outside-gateway), matrix resolution, approval predicate, session-auth |
| 4 | `@sow/knowledge` | KnowledgeWriter (sole Markdown writer) + write-through/divergence 7-invariant layer + GBrain read-adapter + GCL Visibility Gate |
| 5 | `@sow/providers` | Broker (ModelProviderPort + AgentRuntimePort) + fixed-order gate pipeline + egress veto + conformance harness |
| 6 | `@sow/integrations` | Connector Gateway (reads, no silent drops) + Tool Gateway (the ONLY external-write path: envelope + atomic reserve → zero duplicate writes) + NotebookPort |
| 7 | `@sow/workflows`, `@sow/worker` (+ `@sow/db` amend) | §9 durability foundation (LIFE-1/2/3/5) + all 13 Temporal workflows |
| 8 | `@sow/worker` (`api/**`), `@sow/policy`, `@sow/contracts` (`api/**`), `@sow/evals` | §10 Local App API — loopback tRPC + single WS push stream, session-token/Origin auth, UI-safe projection boundary, queries + commands, reconnect/backpressure, §12 auth/leakage suites + <2s benchmark |
| 10 | `@sow/domain`, `@sow/db`, `@sow/worker`, `@sow/contracts`, `@sow/evals` | §16 cross-cutting — mandatory redaction+logger, error-routing taxonomy, 3 operational-truth tables (health/schedule/lease), System-Health surface, supervision + degraded modes + backup/recovery + config/time |

*(Phase 9 — Electron Desktop UI, desktop track — is the remaining pre-11 phase; it consumes §10 + owns the supervisor spawn + renderer WS wiring.)*

## Architecture + patterns that MUST carry forward

1. **Zod-as-source contracts (ADR-008):** each Appendix-A seam model = `.strict()` Zod → `z.infer` type → generated JSON Schema → frozen `.snap` field-set → ajv-strict registry. A field add/remove/rename requires `ARCHITECTURE.md` Appendix A + schema + `.snap` in the SAME round.
2. **Candidate-data gate composition (LESSONS §3) — FULLY DISCHARGED (§5/§7/§8/§9):** never ajv `validate()` alone — compose ajv + the model's Zod `.parse` (the `.refine` layer ajv drops) + the §3 universal rules + the domain predicate. `admitCandidateJob` is the reference.
3. **Phase-7 two-layer workflow pattern:** PURE orchestration drivers (over `@sow/domain` state machines + injected activity ports + `resolveRun` idempotency + health sink) — sandbox-safe (NO `@temporalio`, NO `node:crypto`, NO `Date.now()` in drivers) → Vitest-tested with fakes, no Temporal server. Activities do the I/O + wire real adapters. Live-Temporal tests gated behind `SOW_TEMPORAL=1` (default-skipped, like Phase-2's `SOW_PG_DOCKER`).
4. **Governance invariants (every workflow):** derive-committed-outputs-from-validated-data + bound-workspace (never a caller-supplied plan); semantic writes ONLY via KnowledgeWriter; external writes ONLY via the Tool Gateway envelope (reserve-then-create = idempotent); cross-workspace reads ONLY via the GCL Visibility Gate; a distinct OBS-2 health item on every failure.
5. **The recurring bug-class adversarial verify keeps catching:** *a guard that reads a field/flag that is NOT what actually flows to the side effect.* (7.6 validated an extraction but committed a caller-supplied plan; approval misread an idempotent-no-op as a real transition → double-dispatch; cross-calendar leakage guard checked a decoy field; deletion-saga idempotency keys were content-blind.) Every safety-critical wave gets an adversarial-verify pass + an independent re-verify on each fix.

## Build method (established, works)

- **Single-operator + Workflow fan-outs.** Rate-limit-conservative: **≤2 concurrent workflows, narrow `parallel()` batches ~≤3–4, retry only failed agents** (memory `workflow-concurrency-rate-limits`).
- **Wrap synth/verify stages in `parallel()`** so a StructuredOutput report-format hiccup can't fail the whole run (the work always lands on disk regardless).
- **Workflow scripts are plain JS** — no TS annotations; **escape inner backticks** (`\``) inside template-literal briefs or the script won't parse.
- **TDD** for deterministic code (test-first); the eval path for LLM generation.
- **Adversarial-verify** every safety-critical phase, then re-verify each fix until CLEAR.
- **Commit per batch:** explicit `git add <path>` (never `-A`); Conventional Commits + trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`; allowlist TDD-fixture secrets by fingerprint in `.gitleaksignore` with FULL-LINE comments (inline `#` breaks gitleaks). Push origin/main at phase close-out.
- **Full solo close-out** (memory `solo-session-full-closeout`): session doc, hot-routing, `/orchestrate-end` incl. Step-5.5 Carry-forward triage, formal `/phase-exit` with arch-drift + security + reachability sub-agents.
- **Don't touch** `.env` / `scaffold/`.

## What's next (in order)

1. **Phase-8/10 APP-SHELL WIRING wave (the direct analog of worker-wiring after Phase 7).** Mount the loopback tRPC+WS API server in the running worker bootstrap (compose the query/command/systemHealth routers + push stream into `appRouter`, run `createApiServer`+`applyWSSHandler` behind the 8.1 `makeAuthInterceptor` + `assertLoopbackBind`); swap the persistent `@sow/db` `{healthItems,scheduleBookkeeping,instanceLeases}` stores into the live proof-spine composition (currently in-memory); wire `createLogger`/`createHealthSurface`/supervision+degraded/backup into the composition root; add an in-process SOW-gated authed round-trip integration test (spike-0.5 Live-validation gate). This discharges the Phase-8/10 reachability waiver. (Full carry-forward list — fencing token, accepted redaction residual, doc STALE-DOCs, eval-suite registration, EVALUATION_CRITERIA row — in `IMPLEMENTATION_PLAN.md` Carry-forward.)
2. **Phase 9 — Electron Desktop UI** (desktop track; depends 9,2): the nine UI surfaces over the §10 API; the renderer contextIsolation/preload security shell; the Electron-main worker-supervisor SPAWN (feeds `decideRestart`, calls `reacquireLease`+`recoverRun` on respawn); the mint/inject session-token + renderer WS handshake.
3. **Phase 11 — Deployment/Install/Rollback** (desktop track; depends 9,2): the V1 boot sequence + install doctor + the backup cron scheduler.

## Open carry-forward (non-blocking; see IMPLEMENTATION_PLAN "Carry-forward")

- `ProvenanceOrigin` has no `project_sync`/deletion member (7.13→`ingestion`, 7.14→`human`) — frozen-contract round if §6 wants distinct.
- Phase-7 security LOWs: the redaction/log sink now redacts a surfaced error `cause` (**✅ done in Phase 10.1** — `redactError` gates `.code` through the per-field classifier); the heuristic cross-calendar leakage detector allowlist remains open (Phase-10+ hardening). New Phase-8/10 carry-forward (app-shell wiring wave, lease-fencing token, accepted redaction residual, doc STALE-DOCs, eval-suite registration) is in `IMPLEMENTATION_PLAN.md` Carry-forward.
- OBS-2 `FailureClass` named-constant cluster (`policy_denial`/`egress_status`/`provider_routing_unavailable`/`outbox_blocked`/`db_unavailable`) — pin as distinct enum members in one round if §16 wants them distinct.
- ESLint + Prettier still `tsc`/waived placeholders (`format:check` waived phase-wide).
- Also authored this session (out of build track): UI/UX design docs for Claude Design at `docs/design/ui-ux/{ui-ux-spec,design-system}.md` (aesthetic: calm governed control plane; first screen: Today / Command Center).

## Environment gotchas

- Temporal 1.19.0 installed workspace-wide; native `core-bridge` present for `aarch64-apple-darwin`. `protobufjs` pinned to `^7.6.3` via `pnpm-workspace.yaml` `overrides` (cleared a moderate advisory); `@swc/core`/`protobufjs` build scripts set `false` in `allowBuilds` (prebuilt/fallback artifacts suffice).
- pnpm 11: overrides live in `pnpm-workspace.yaml`, NOT `package.json` (the `pnpm` field there is ignored).
- Tests live in `<pkg>/test/**/*.test.ts`; run per-package via `pnpm --filter <pkg> exec vitest run`; repo-wide `pnpm -w test`; typecheck `pnpm typecheck`.

## Resume prompt

See the resume pointer at the bottom of `docs/sessions/010-2026-07-02-phase8-phase10-local-api-crosscutting.md` (the Phase-8/10 app-shell wiring wave + Phase 9), and the same is echoed in-chat at handoff.

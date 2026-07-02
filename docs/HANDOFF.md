# System of Work Assistant — Build Handoff (current state)

> **Single current-state entry point.** Updated 2026-07-02, after the worker-wiring proof spine landed (Phases 0–7 certified; 3 §9 drivers now run live on real Temporal). For per-phase detail see `docs/sessions/NNN-*`; for binding project decisions see memory `system-of-work-prd`; the authoritative task tracker is `IMPLEMENTATION_PLAN.md`.

## TL;DR

- **Repo:** `SoW-build`, branch `main`, **everything committed + pushed to origin/main** (HEAD `11d7e6b`; remote `git@github.com:SiWarlock/AI-System-Of-Work-Assistant-Agent.git`). Working tree clean.
- **Phases 0–7 are COMPLETE and CERTIFIED**, and the **worker-wiring proof spine is DONE (2026-07-02)** — the 3 fully-wireable §9 drivers (meeting-closeout, approval-flow, ingestion-triage) now RUN live on a real Temporal worker over real adapters (`SOW_TEMPORAL=1` 4/4).
- **Repo-wide: 2447 tests green + 5 gated skip + 2 todo; typecheck 10/10 packages clean; `pnpm audit --prod` clean.**
- **Next:** **Phase 8 (§10 Local App API, worker track)** ∥ **Phase 10 (cross-cutting, eval-security)** — different tracks, may run 2 concurrent Workflows. (The worker-wiring wave was scoped to the proof spine; the other 10 drivers' 40 fake-only activities are deferred by natural phase — see `worker-wiring-scope` memory + session 009.)

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

1. **WORKER-WIRING wave — proof spine DONE (2026-07-02, `d755c7b`+`11d7e6b`; session 009).** The 3 fully-wireable §9 drivers (meeting-closeout, approval-flow, ingestion-triage) run live on a real Temporal worker: WW-1 DB cross-process no-dup-write (`ReceiptStore.reserve` unique-constraint insert + `workflowRunRefs.idempotencyKey` closing `resolveRun`'s race), WW-2/3 the real `meetingOutputsProjection` + `apps/worker` composition root (real KnowledgeWriter/Broker/Tool-Gateway/policy/db, deterministic vendor stubs) + `@temporalio` wrappers + `Worker.create` + `SOW_TEMPORAL` integration test (4/4). **Scoped to the proof spine** — deferred by natural phase (session-009 carry-forward): the other 10 drivers' **40 fake-only activities** (agent-runners/synthesizers → eval/Phase 12; read-model/dashboard/notify → Phase 8/9; deterministic remainder → follow-on), real vendor SDK transports, session-auth → Phase 8.1, workflow-safe `@sow/contracts`/`@sow/domain` barrels, sole-writer (`@sow/knowledge`) path containment.
2. **Phase 8 — §10 Local App API** (worker track; depends 7): loopback tRPC API + WebSocket event stream for the desktop renderer; per-launch session-token auth; read models + System Health surface for §11.
3. **Phase 10 — Cross-cutting** (eval-security track; depends 2,7): non-bypassable structured logging + mandatory redaction sink; the persistent System Health `health_items` table + repo (the Phase-2/7 HealthItem-persistence deferment); worker supervision; Temporal-unavailable + Keychain-locked degraded modes; backup/recovery; config/time.

Phase 8 ∥ Phase 10 are different tracks → may run 2 concurrent Workflows.

## Open carry-forward (non-blocking; see IMPLEMENTATION_PLAN "Carry-forward")

- `ProvenanceOrigin` has no `project_sync`/deletion member (7.13→`ingestion`, 7.14→`human`) — frozen-contract round if §6 wants distinct.
- Phase-7 security LOWs → Phase 10: heuristic cross-calendar leakage detector could allowlist calendar-payload keys; the redaction/log sink must redact a surfaced error `cause` (drivers currently expose only `.code`).
- OBS-2 `FailureClass` named-constant cluster (`policy_denial`/`egress_status`/`provider_routing_unavailable`/`outbox_blocked`/`db_unavailable`) — pin as distinct enum members in one round if §16 wants them distinct.
- ESLint + Prettier still `tsc`/waived placeholders (`format:check` waived phase-wide).
- Also authored this session (out of build track): UI/UX design docs for Claude Design at `docs/design/ui-ux/{ui-ux-spec,design-system}.md` (aesthetic: calm governed control plane; first screen: Today / Command Center).

## Environment gotchas

- Temporal 1.19.0 installed workspace-wide; native `core-bridge` present for `aarch64-apple-darwin`. `protobufjs` pinned to `^7.6.3` via `pnpm-workspace.yaml` `overrides` (cleared a moderate advisory); `@swc/core`/`protobufjs` build scripts set `false` in `allowBuilds` (prebuilt/fallback artifacts suffice).
- pnpm 11: overrides live in `pnpm-workspace.yaml`, NOT `package.json` (the `pnpm` field there is ignored).
- Tests live in `<pkg>/test/**/*.test.ts`; run per-package via `pnpm --filter <pkg> exec vitest run`; repo-wide `pnpm -w test`; typecheck `pnpm typecheck`.

## Resume prompt

See the full cold-start resume prompt at the bottom of `docs/sessions/008-2026-07-02-phase7-workflows.md` (Phase 8 ∥ Phase 10 + the worker-wiring prerequisite), and the same is echoed in-chat at handoff.

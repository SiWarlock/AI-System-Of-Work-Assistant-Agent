# Session 103 — Phase-18 Path-β desktop legs: subscription-arming forwarding (18.32) + native allowlisted .env loading (18.34)

- **Date:** 2026-07-20
- **Phase:** 18 (§19.5 real ModelProvider / subscription crossing) — Path-β "in-app auto-ingest capability" round, all dormant / default-OFF (nothing armed, run, or spent)
- **Role:** desktop-impl (implementer), team `session-4f4687dd`, single-track `main`
- **Predecessor:** [`102-2026-07-20-phase18-autoingest-arm-worker.md`](102-2026-07-20-phase18-autoingest-arm-worker.md) (worker-impl's concurrent close-out: 18.31 egress-allowlist seam + 18.33 committed L64 armed dry-run go/no-go)
- **Successor:** _(none yet)_

> **Concurrent-close-out numbering note:** this is a full-team cycle — worker-impl reserved **102** (via 101's successor link) for its 18.31/18.33 doc; I took **103**. I did NOT edit 101 (correctly points to 102) or 102 (worker-impl territory, being written concurrently). The 102→103 successor link should be added by worker-impl or reconciled at `/orchestrate-end`.

## Why this session existed

The Phase-18 subscription crossing shipped (source leg live). The owner chose to enable auto-ingest as a **real in-app feature (Path-β)**. FINDING that scoped this round: the desktop app wired the auto-ingest *trigger* (`SOW_INGEST_WATCH`/`SOW_VAULT_ROOT`/`SOW_MANAGE_TEMPORAL` → the watcher) but its `WorkerHostConfig` assembly never set the worker **subscription-extraction arming axis** nor the **egress-config surface** — so an in-app file drop fired the trigger but the extraction ran the unarmed stub → fail-closed → no note. This round threads the arming + egress-config surface through the desktop config so the app **can** run subscription-armed auto-ingest — **built dormant / default-OFF**; the actual ENABLE flip stays owner-gated. A follow-on hardening slice (18.34) closed the `.env`-boundary shadow/secret risk the arming surface introduced.

## What was built

### 18.32 — thread subscription-arming + egress allowlist through `WorkerHostConfig` (commit `0d8e7c56`)

**Files created:**
- `apps/desktop/main/worker-arming-env.ts` — pure, electron-free: `readWorkerArmingEnv(env) → { subscriptionArm?, egressAllowedProcessors? }`; parses `SOW_SUBSCRIPTION_ARM` (strict `"1"|"true"`, worker L28), `SOW_SUBSCRIPTION_MODEL`, `SOW_EGRESS_ALLOWED_PROCESSORS` (comma-split/trim/drop-empties). Absent env ⇒ `{}` (byte-equivalent).
- `apps/desktop/worker-host/arming-forward.ts` — `subscriptionArmForward(config)` (conditional-spread into the `bootWorker` arg) + `buildAutoIngestGateOpts(config)` (forwards `egressAllowedProcessors` as plain strings into the `gateAutoIngest` opts — no brand cast; worker brands `string→ProcessorId` internally). Type-only imports (`WorkerHostConfig`, `boot.AutoIngestGateOpts`) keep it side-effect-free.
- `apps/desktop/test/main/worker-arming-env.test.ts`, `apps/desktop/test/main/arming-forward.test.ts`.

**Files modified:**
- `apps/desktop/main/worker-supervisor.ts` + `apps/desktop/worker-host/index.ts` — both `WorkerHostConfig` mirrors gain `subscriptionArm?:{enabled?;model?}` + `egressAllowedProcessors?:readonly string[]`; the worker-host interface `export`ed for the sync-pin; `start()` spreads `subscriptionArmForward(config)` into `bootWorker` and consumes `buildAutoIngestGateOpts(config)`.
- `apps/desktop/main/index.ts` — spreads `...readWorkerArmingEnv(process.env)` into the `WorkerHostConfig` build.

### 18.34 — native allowlisted `.env` loading in Electron main (commit `fc3031f7`)

**Files created:**
- `apps/desktop/main/dotenv-allowlist.ts` — pure, electron-free: `RECOGNIZED_SOW_ENV_KEYS` (the 9-key `SOW_*` allowlist), an inlined 13-var `SUBSCRIPTION_SHADOWING_ENV_KEYS` (verbatim from `subscription-auth-guard.ts:56`, for the escalated warning ONLY), a minimal dependency-free parser (`Object.create(null)` map), and `loadAllowlistedDotenv(contents, existingEnv) → { hydrate, skipped{key,reason} }`.
- `apps/desktop/test/main/dotenv-allowlist.test.ts`.

**Files modified:**
- `apps/desktop/main/index.ts` — `hydrateAllowlistedDotenv()` reads the repo-root `.env` (try/catch ⇒ no-op), applies `hydrate` to `process.env`, warns on `skipped` (KEY only, rule 7); called at the top of `startWorker()` (before any `SOW_*` read; the forked worker child inherits main's `process.env`).

## Decisions made

- **IPC carries plain data only (§19.5).** `WorkerHostConfig` crosses a `child_process.fork` structured-clone channel, so the desktop forwards only `{enabled,model}` — never the `makeCompletion`/`checkReachable` thunks. `bootWorker` supplies those; its `checkReachable ?? FAIL_CLOSED_REACHABILITY` default keeps an **env-only arm HEALTH-denied** (the dormant OFF-lock). This makes the app *capable*, not *armed*.
- **`betas` dropped** from the desktop interface — `BootConfig.subscriptionArm` has no `betas` field, so a forwarded `betas` was statically dead (no consumer). Re-add with the worker slice that consumes it.
- **Invariant type-identity sync-pin.** The two mirrored `WorkerHostConfig` interfaces are pinned identical via `TypeEquals<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>...) ? true:false` — NOT bare bidirectional assignability, which is **blind to optional-field drift** (both mirrored fields are optional, so assignability would pass on exactly the drift it must catch). Caught by the code-quality review as a vacuous pin.
- **18.34: the allowlist is the safety gate, not the parser.** A shadowing var / secret is not `SOW_*` ⇒ structurally never hydrated, regardless of parse quirks. So a minimal in-repo parser (dotenv is absent from the repo; adding a dep for simple config values isn't warranted) is safe + fully auditable.
- **Inline the 13-var shadowing set** — `SUBSCRIPTION_SHADOWING_ENV_KEYS` is not barrel-exported from `@sow/worker`; a deep import would drag a node-heavy worker edge into the main tier (desktop LESSONS §5). Inlined for the escalated warning only; drift affects warning *specificity*, never the gate. A `// TODO(barrel-export …)` marker + a banked Future-TODO track single-sourcing it later.
- **Empty `.env` value = unset** — `SOW_VAULT_ROOT=` was hydrating `""`, and main reads it `?? default` (empty ≠ nullish ⇒ `vaultRoot=""` ⇒ `mkdirSync("")` boot-break). The parser now drops empty values so a blank line can't clobber a default. Existing `process.env` wins; missing `.env` no-op.

## Decisions explicitly NOT made (deferred)

- **Allowlist 9-vs-14 scope** — the 9 keys cover every main+worker-host read, but the forked worker *child* reads more `SOW_*` config (`SOW_API_PORT`, `SOW_CANONICAL_BRAIN_PATH`, `SOW_CONTROL_PLANE_TASK_QUEUE`, `SOW_OPERATIONAL_DB_PATH`, `SOW_VAULT_ROOT_PATHS`) that won't load from `.env` once dev.sh's blanket `source` is removed. Shipped the 9 (zero narrowing this turn — dev.sh still blanket-sources until reconciled); the orchestrator **banked** the expand-to-14 decision to surface with the dev.sh edit at round-close.
- **`dev.sh` reconcile + `.env.example`** — orchestrator round-close edit (deferred by the owner park directive); I did NOT touch `dev.sh`/`.env.example`.
- **The required-vs-optional `subscriptionArm.enabled` producer subtype** — `WorkerArmingConfig.enabled` is required vs the wire copies' optional; a precise producer subtype, safe (usage-site spread + sync-pin guard drift). Left as-is per orchestrator ruling.

## TDD compliance

**Clean — no violations.** Both slices were RED-first: each test file was written and confirmed failing (module-missing) before the implementation, then driven to GREEN. Every review-fix (the invariant sync-pin, model-trim, empty-value drop, parser edge cases) landed with its accompanying test in the same slice. Both slices are deterministic desktop code (config parsing + IPC-config threading) — squarely in the `/tdd` path, no eval-path exemptions.

## Reachability

- **18.32** — `readWorkerArmingEnv` reached from `main/index.ts` `startWorker()` (the `app.whenReady()` launch chain); `subscriptionArmForward` + `buildAutoIngestGateOpts` reached from `worker-host/index.ts` `start()` (the `bootWorker` arg + the `gateAutoIngest` call). Reached on every app launch; dormant/byte-equivalent when the env is unset.
- **18.34** — `hydrateAllowlistedDotenv` reached from the top of `startWorker()`; `loadAllowlistedDotenv` from there. Runs on every launch; a no-op when no repo-root `.env` exists (today's default).
- **No tested-but-unwired gaps.** Verified at `/tdd` Step 7.5 for each slice; no later slice removed the wiring.

## Open follow-ups

Step-9 items were routed hot and orchestrator-confirmed during the session (its `/orchestrate-end` is the single verify pass). Still-open items:

- **Orchestrator round-close doc writes (banked):** ARCH §19.5 note (app capable of subscription-armed auto-ingest, dormant, probe+flip owner-gated) + desktop **Lesson §14** (IPC forwards plain-data arming opts only; worker-side FAIL_CLOSED keeps it dormant = OFF-lock across the fork; sub-lesson: mirrored-interface sync-pins need the invariant type-identity form). ARCH §5/§16 note (the `.env` boundary is allowlisted — a plaintext `.env` can't shadow the subscription/egress or auto-load a secret) + desktop **Lesson §15** (allowlist-is-the-gate; empty=unset; existing-wins; warn-key-only). ENABLE-runbook INFO-2/-3 (keep worker `boot.ts:1327 checkReachable ?? FAIL_CLOSED_REACHABILITY` fail-closed; `SOW_EGRESS_ALLOWED_PROCESSORS` is an owner-gated egress-GRANTING knob).
- **`dev.sh` reconcile + `.env.example`** — drop the `set -a; source .env; set +a` block ⇒ `exec pnpm --filter @sow/desktop dev`; add `.env.example`. Orchestrator round-close; **gate on the 9-vs-14 allowlist-scope decision above.**
- **Allowlist 9-vs-14 scope** — decide + apply with the dev.sh edit (orchestrator lean: expand to 14 so removing dev.sh doesn't silently narrow the worker-child ops keys).
- **Future TODO (phase-owned):** barrel-export `SUBSCRIPTION_SHADOWING_ENV_KEYS` from `@sow/worker` so 18.34 can single-source it (marker in `dotenv-allowlist.ts`); the in-app L64 fake-completion dry-run harness (composes with worker 18.33, now landed `db45eb6e`) as the go/no-go before the owner in-app ENABLE flip.
- **Deferred (low, non-blocking):** the egress allowlist isn't deduped (harmless — worker EgressPolicy is set-membership). Security INFO ×3 (SOW_SUBSCRIPTION_*/EGRESS_* `.env`-hydratable by design; negligible ANSI log-injection) — no action.

## Reviews

Both slices ran the **mandatory security-reviewer** (egress/arming + shadow/secret non-hydration are safety-invariant) + code-quality-reviewer:
- **18.32:** security CLEAN (7/7 invariants PASS, 0 findings); code-quality 1 high (the vacuous sync-pin — fixed) + 4 lower.
- **18.34:** security CLEAN (7/7 PASS, 0 findings; prototype-pollution vectors empirically verified neutralized); code-quality 0 high / 2 medium (empty-value + edge-tests — both fixed) / 5 low.
No Step-9 `Finding` escalations.

## Preflight (`/session-end` final gate)

`install ✓ · typecheck ✓ (repo-wide) · desktop tests 361/0 ✓`. `lint` + `format:check` **WAIVED — documented env gap** (`eslint` not installed; no root `format:check` script), consistent with prior Phase-14–18 rounds; neither names any slice file. Repo-wide test not re-run (this is a doc-only close-out over already-committed, per-slice-green code; the repo-wide typecheck pass covers cross-package type breaks). Both slices were committed GREEN at `/tdd` Step 10 (18.32 `0d8e7c56`, 18.34 `fc3031f7`).

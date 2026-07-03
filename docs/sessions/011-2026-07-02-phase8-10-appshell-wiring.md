# Session 011 — Phase-8/10 app-shell wiring wave (the API runs live)

- **Date:** 2026-07-02 · **Mode:** single-operator + Workflow fan-out · **Track:** worker
- **Predecessor:** `010-2026-07-02-phase8-phase10-local-api-crosscutting.md` (Phase 8 + Phase 10 built + certified; production mount deferred)
- **HEAD at close:** `d44f5d8` (wiring wave) + close-out docs on top
- **Gates:** default suite **3007 pass / 12 gated skip / 2 todo**; `SOW_API=1` live **7/7**; typecheck **10/10**; `pnpm audit --prod` clean.

## What this was

The direct analog of the worker-wiring wave that followed Phase 7: Phase 8 + Phase 10 shipped their leaf modules certified but **unmounted** (the `/phase-exit` reachability audits classified the API + substrate factories UNREACHABLE-BY-DESIGN, deferred). This wave **mounts them** — the §10 API now runs on a real loopback HTTP+WS transport behind auth, and the §16 persistent substrate goes live in the composition — **discharging the reachability waiver for the mounted paths.**

Run as a 3-stage Workflow pipeline (`Adapters → Mount → Verify`).

## Delivered

- **Persistent-store swap** (`composition/store-adapters.ts` + `backends.ts`): three adapters map the real `@sow/db` `{healthItems,scheduleBookkeeping,instanceLeases}` repos onto the `@sow/workflows` ports. `assembleBackends` now uses the DB-backed `HealthItemStore` (the proof-spine health sink **persists to sqlite**) + adds `scheduleStore`/`instanceLeaseStore` + a redacting `createLogger`. Every adapter **fails closed** on a real `DbError` (only `not_found` folds to the absence sentinel — a fault never returns a plausible-wrong answer, which for the lease CAS would double-grant).
- **Real `@sow/db` port adapters** (`api/adapters/{readModel,commands}.ts`): bind the 8.3/8.4 ports to the real repos — read-model rows → UI-safe card sources (absent → `ok([])`), unknown workspace → typed `err`, approval commands exactly-once via the real `decideApprovalCas`, dispatch only through the worker.
- **Router mount** (`api/server.ts`): `createApiServer` composes query+command+systemHealth+stream routers into `appRouter` (`AppRouter` re-derived).
- **Real transport** (`api/mount.ts`): `startApiServer` stands up `createHTTPServer` (httpBatchLink) + `applyWSSHandler` (`ws`) on one `127.0.0.1` port behind the SAME `makeAuthInterceptor` pre-handler on both paths (WS token off the first-message `connectionParams`, never a URL); `assertLoopbackBind` at startup; keepAlive `{pingMs:1000,pongWaitMs:2000}`.
- **Boot entrypoint** (`boot.ts`): `bootWorker` composes `assembleBackends` + `startApiServer` + `createLogger` + the Temporal-unavailable degraded controller + the proof-spine register hook. It **accepts** an injected per-launch token + Origin allowlist (the Electron-main mint/spawn is Phase 9).
- **Live integration test** (`test/integration/api-live.test.ts`, `SOW_API=1`-gated, socket-free by default): a real `@trpc/client` round-trip on an ephemeral loopback port — wrong-token + DNS-rebind rejected pre-handler on HTTP AND WS, valid token → UI-safe empty read-model, stream resume from `lastEventId`, non-loopback bind refused. **7/7.**

## Adversarial verify — both HOLD

- **Mounted-auth (real transport):** HOLDS — the interceptor runs pre-handler on the actual `createHTTPServer` context + `applyWSSHandler` handshake; token off header/first-message (never a URL); wrong-Origin/Host rejected on the real upgrade; `assertLoopbackBind` enforced; UI-safe projection is what's serialized to the socket.
- **Store-swap:** HOLDS — the persistent `HealthItemStore` preserves no-duplicate-external-write (safety rule 3) + §10.3 dedupe (key from `item.id`); the lease CAS preserves LIFE-1 single-owner (contention = `ok(false)`, not a throw); adapters fail closed on `DbError`.

## Carry-forward (4 LOW — from the wiring verify; documented in `IMPLEMENTATION_PLAN.md`)

1. Converge `mount.ts` `makeWsContext`'s inline token/Origin extraction onto the audited `runStreamHandshake` (drift risk; live-tested correct today — the recurring bug-class, low-severity here).
2. Read-model query `input` (workspaceId) rides the GET URL query-string (the token is header-only) → POST sensitive inputs or add access-log redaction.
3. `approvalInbox`/`ingestionInbox` return GLOBAL pending approvals — the frozen `Approval` has no `workspaceId`, so workspace-scoping needs the `actionRef`→workspace read-model join (UI-safe today, no raw leak).
4. Pre-existing: the receipt-store existence-check folds every `DbError`→miss (the reserve is the real fail-closed guard).

## Resume pointer

The §10 API is LIVE. Next: **Phase 9 (Electron Desktop UI, desktop track)** — the nine UI surfaces over the now-live API, the renderer security shell, the Electron-main supervisor spawn + the session-token mint/inject + renderer WS handshake (the `bootWorker` seam is ready for them). See `docs/HANDOFF.md`.

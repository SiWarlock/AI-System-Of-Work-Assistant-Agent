# Session 013 — Phase 9.4b: live worker integration (the running desktop app)

- **Date:** 2026-07-03 · **Mode:** single-operator (build) · **Track:** desktop (+ worker, + all `@sow/*` build system)
- **Predecessor:** `012-2026-07-03-uiux-design-and-phase9-foundation.md` (design lock + 9.1–9.4a foundation, HEAD `bd21ce0`)
- **HEAD at close:** `135bd58` · **12 commits** (`d7c81af`…`135bd58`), all LOCAL (no remote configured)
- **Gate:** worker typecheck clean · 316/17-skip · desktop typecheck (node+web) clean · 66 · contracts 587 · tree clean

## What this session delivered

A **running desktop app** backed by a **real, spawned worker process**. `pnpm --filter @sow/desktop dev` → Electron main spawns the `@sow/worker` control plane as a supervised child, the renderer subscribes to it live over tRPC-WS, and the locked Liquid-Glass Today surface renders with a green **Live** pill. Owner-confirmed on screen.

This is the **transport seam** of Phase 9 (renderer ↔ live worker), not the surface data-wiring. See "What's still missing" for the precise boundary.

## The architecture that landed (how the pieces fit)

```
Electron main (apps/desktop/main)
  ├─ mints per-launch session token (session-token.ts, 9.2)
  ├─ registers app://sow privileged scheme + traversal-safe static handler (app-protocol.ts)  [prod]
  ├─ builds the mode-tight Origin/Host allowlist + pinned loopback port (worker-launch.ts)
  ├─ createWorkerSupervisor: child_process.fork(desktop-host.mjs)               (worker-supervisor.ts)
  │     execPath = SYSTEM node · execArgv = [--conditions=sow-built, --import register-loader]
  │     injects {token, launchId, allowlist, apiHost/port, dbPath, vaultRoot} over child IPC
  │     restarts on exit (bounded backoff); publishes {httpUrl,wsUrl} to worker-holder
  └─ preload bridge: app:getVersion · session:getToken · worker:getConnection   (preload/bridge.ts)

worker child  (apps/desktop/worker-host/index.ts, bundled by esbuild → out/worker/desktop-host.mjs)
  ├─ reads config from IPC → boot.bootWorker(...) with NO proofSpineParams (Temporal-degraded)
  ├─ resolves the BUILT @sow/* dist via the `sow-built` export condition + the resolve-loader
  │     (extensionless ESM → +.js) · native deps (better-sqlite3) from apps/worker/node_modules
  ├─ opens sqlite (genesis migration) + vault under userData; stands up the loopback HTTP+WS API
  └─ reports {ready, port}

renderer  (apps/desktop/renderer)
  App.tsx → startLive(store):  getConnection() + getToken() → createLiveClient (splitLink: wsLink
    subscriptions w/ token via connectionParams, httpBatchLink queries w/ Bearer)
    → createWsStreamTransport → createEventStream (reconnect/backoff/worker-down; live on onStarted)
    → hydrate: query.dashboard + systemHealth.items → hydrateCards/hydrateHealth (empty read-model today)
  Today.tsx renders: ConnectionPill(store) · Waiting-on-you(store.cards) · System-health(store.health)
```

## Slice-by-slice (the 12 commits)

| Commit | Slice | Summary |
|---|---|---|
| `d7c81af` | A (worker §5) | Removed `checkOrigin`'s `Origin==Host` cross-check → **independent** Origin+Host allowlisting so a *native* cross-origin renderer is admitted. security-reviewer: 0 findings. |
| `96bfbf2` | B (worker CORS) | Strict single-origin CORS (preflight + exact ACAO, never `*`/credentials). Proven over real sockets (api-live cross-origin HTTP+WS + CORS, SOW_API=1). |
| `43ecf3f` | C (desktop main) | `app://sow` privileged scheme + traversal-safe resolver; pinned-port + Q4-tight allowlist builder. |
| `0c2914f` | D1 (worker boot) | `proofSpineParams` optional → `connectTemporal` degrades cleanly (no fabricated fixture data). |
| `a2e3109` | D2/D3 (build) | **The big one.** 9 `@sow` packages build structure-preserving to `dist` + a `sow-built` export condition; the worker-host entry + resolve-loader + esbuild entry build; declared under-declared worker deps. |
| `cc74a64` | D4 (desktop main) | `createWorkerSupervisor` + `child_process.fork` glue (system node) + `build:sow` in dev/build. |
| `f1e9503` | D5 (preload) | `worker:getConnection` channel ({httpUrl,wsUrl}, no token) + inventory + snapshot. |
| `9e2f55e` | E (renderer) | Real ws-transport + live-client + `startLive`; replaced the dev seed. |
| `5773fb1` | fix | Go "live" on subscription `onStarted`, not first event (empty read-model reads as connected). |
| `00b2784` | follow-up | Persistence (dbPath/vaultRoot under userData) + initial read-model hydrate. |
| `a5f95e2` | follow-up | (degraded-health attempt) + turbo-cached `build:sow`. |
| `135bd58` | fix | Reverted the broken degraded-health `put` (wrong store contract — see findings). |

## Load-bearing findings (READ THESE — they shaped everything)

1. **Bundling the worker breaks `@sow/contracts`' schema loading.** `schema/registry.ts` reads its JSON Schemas via `readFileSync(new URL('../../schemas', import.meta.url))`. Any bundler collapses `src/schema/registry.ts` to a shallower path → the `../../schemas` relative resolve breaks (and CJS makes `import.meta.url` empty). **Therefore** each `@sow` package builds **structure-preserving** via `tsc` (dist mirrors src) with a **`sow-built` export condition** (`{ "sow-built": "./dist/index.js", "default": "./src/index.ts" }`) so dev/tests/Vite keep using source unchanged, and the spawned child runs with `--conditions=sow-built`.
2. **The packages are bundler-authored ESM** — `moduleResolution: Bundler`, **extensionless** relative imports, `import.meta.url`. Plain `tsc` emits extensionless ESM Node can't run; CJS would break `import.meta.url`. **Solution:** a tiny **child-only ESM resolve-loader** (`worker-host/resolve-loader.mjs`, via `--import register-loader.mjs`) that appends `.js`/`/index.js`. Zero impact on the dev toolchain.
3. **Under-declared runtime deps.** `apps/worker/src/composition/backends.ts` does `require_("better-sqlite3")` + `require_("drizzle-orm/better-sqlite3")` (createRequire) but they weren't `apps/worker` deps — resolved via pnpm hoist in vitest, but NOT from the built `dist` location. Declared them.
4. **Electron `child_process.fork` defaults to the ELECTRON binary** (Electron's Node ABI). We fork with `execPath = system node` so `better-sqlite3` keeps its system-node ABI in dev. Packaging must move to `utilityProcess` + `@electron/rebuild`.
5. **A fresh (null-cursor) stream subscribe does NOT replay** pre-subscribe events (`planResume` is cursor-driven). So boot-time publishes are missed by a fresh renderer — surfacing state must go through the read-model query (hydrate) or a persisted store, not a one-shot publish.
6. **The production health store is the sqlite adapter** whose `put` is **4-arg** (`item, dedupeKey, subjectRef, lastSeen` → `DbResult = Promise<Result>`); the 1-arg in-memory store is `@deprecated`/unused. A direct `put(item)` silently fails. Surfacing a health item needs the **health surface materializer** (`createHealthSurface`).

## What's still missing (the honest boundary)

**The Today window is ~2 store-driven sections + static mockup chrome.** Only these route through the live worker: the **connection pill**, **Waiting-on-you** (`store.cards`), **System health** (`store.health`). Everything else in `Today.tsx` — Daily brief prose, Today's schedule (Standup/Vendor/Priya), Recent activity, the Approvals-3 / Inbox-5 badges, the amber Health dot, "Egress: local-only", the workspace switcher — is **hard-coded static** (`static illustrative content`), a 9.4a design-fidelity port. It renders identically regardless of the worker.

**Phase-9 remaining (not started):**
- **§9.4 proper** — the Global Today's **GclProjection sanitized grouped results + policy-gated drill-down** (the sanitized-global read path). What ships now is the transport + a `UiSafeDashboardCard` list, not the §9.4 acceptance criteria.
- **Wire the static Today sections to real read-model sources** — schedule ← Calendar read-model, Recent activity ← audit log, Daily brief ← a generator, nav counts ← inboxes. Each needs a real read-model + (for many) a worker read-model projector.
- **9.5–9.14** — Workspace/Project surfaces, Copilot, Ingestion Inbox, Approval Inbox (Mac+Telegram), Calendar, Recent Changes, System Health surface, workspace onboarding, the dashboard warm-load benchmark, the adversarial desktop-security hardening pass.
- **Preload bridge is minimal** — only `app:getVersion` / `session:getToken` / `worker:getConnection`; §9.1's file-picker / open-in-vault privileged actions aren't built.

**9.4b-specific follow-ups (clean, scoped):**
- **Surface the Temporal-degraded state** via the health surface materializer (createHealthSurface) so System Health shows "Temporal unavailable" instead of "All systems healthy". (Reverted the wrong-contract `put`.)
- **Hydrate is wired but unverified-with-data** (empty read-model). Verify it surfaces real cards/health once a read-model exists; confirm the cross-origin HTTP query's CORS preflight succeeds against the running worker.
- **Full end-to-end procedure typing** — the renderer client is typed against `AnyTRPCRouter` (subscription/query paths are `(client as any)`); needs `@sow/worker` to emit an `AppRouter` `.d.ts` (a worker-track change).

**Packaging (deferred by design — a dedicated future slice):** `utilityProcess` + `@electron/rebuild` (Electron-ABI native) + `app://` prod paths + shipping the built `@sow` dist + a real productName. The current spawn is **dev-correct** (system-node child); packaged spawn is a separate effort.

## Next steps (recommended order)

1. **`/phase-exit`-style reconcile of 9.1–9.3 checkboxes** (they're substantially met with nuances) + a formal decision on whether the current 9.4 counts as partial.
2. **Degraded-health via the materializer** (small, high-signal — makes System Health honest).
3. **§9.4 proper** — GclProjection grouped results + drill-down (the real §9.4 acceptance) — this is the first "real data" surface and exercises the GCL visibility gate end-to-end.
4. **Read-model projectors + wire the static Today sections** to live data (schedule/activity/brief/counts).
5. **9.5+** surfaces, then the benchmark + hardening pass, then **packaging**.

## Build/run reference

- `pnpm --filter @sow/desktop dev` — builds the 9 `@sow` dist (turbo-cached) + the entry, launches Electron, spawns the worker.
- Persisted state: `~/Library/Application Support/@sow/desktop/{sow.db,vault}`.
- Worker child spawn: system `node --conditions=sow-built --import worker-host/register-loader.mjs out/worker/desktop-host.mjs`.
- The worker's socket e2e tests are `SOW_API=1`-gated (api-live.test.ts + boot-degraded.test.ts).

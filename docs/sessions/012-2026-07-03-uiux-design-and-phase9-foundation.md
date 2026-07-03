# Session 012 — UI/UX design lock-in + Phase-9 security foundation

- **Date:** 2026-07-03 · **Mode:** single-operator (design discussion → build) · **Track:** desktop
- **Predecessor:** `011-2026-07-02-phase8-10-appshell-wiring.md` (§10 API live on loopback)
- **HEAD at close:** `2940fef`

## Part A — UI/UX design discussion (COMPLETE, owner-approved)

Turned the stale `docs/design` direction into a locked spec through an interactive, mockup-driven discussion. **Aesthetic LOCKED: macOS-native "Liquid Glass"** — frosted-white/silver translucent panes over a soft pastel desktop, Apple system-blue accent, SF Pro + SF Mono, real Electron window vibrancy in the build (the mockups' `backdrop-filter` is only the approximation).

**Decisions (all in `docs/design/ui-ux/material-direction.md`):** design tokens · spacing/overflow discipline · reserved-color rule (color = workspace OR status only; classifiers are neutral mono tags) · 3-pane shell (nav · content · Copilot right sidebar, collapsible/expandable) · Option-B nav (daily pages + Health up top, config under Settings) · global workspace switcher scopes the app · workspace identity = Treatment 1 subtle scope (app stays blue; workspace = switcher dot + thin scope line), colors **Employer=blue #0a84ff / Personal-Business=emerald #1fae6b / Personal-Life=indigo #5e5ce6** (indigo replaced amber to avoid the warn-color clash) · light default, dark supported · prototype-first order.

**Seven reference mockups** in `docs/design/ui-ux/mockups/`: today (light + dark) · approvals · calendar · inbox · knowledge · projects — covering every genuinely-distinct surface. Health + Settings deferred to just-in-time build (pattern-inheriting).

Design commits: `b66df71` · `d318da9` · `f837c38`.

## Part B — Phase 9 foundation (9.1–9.3, TDD, committed)

Scaffolded `@sow/desktop` (electron-vite: Electron + Vite + React + TS strict) into the workspace and built the renderer↔worker security seam.

- **9.1 (`543e61a`) — shell security baseline.** Hardened `BrowserWindow` (contextIsolation, sandbox, no node integration, webSecurity, no subframe/worker node); strict CSP via `onHeadersReceived` (prod: same-origin + loopback worker; dev: Vite HMR); navigation + new-window deny; narrow typed preload bridge (`window.sow`) built electron-free from one channel source; checked-in preload inventory + drift snapshot test. macOS Liquid Glass shell (hiddenInset + sidebar vibrancy).
- **9.2 (`0788b1d`) — session token.** Main mints a per-launch crypto-random token (memory-only, never persisted/logged), minted before window load; delivered to the renderer ONLY via the audited `session:getToken` preload channel; client attaches it as `Authorization: Bearer` (matches worker `bearerFromHeader`); no silent unauthenticated retry.
- **9.3 (`2940fef`) — event-stream + UI-safe store.** External store (useSyncExternalStore-compatible) holding only `UiSafe*` projections keyed by id + connection status + resume cursor; pure `applyStreamEvent` reducer; reconnect policy (bounded exponential backoff, hard cap, distinct worker-down state); `validateStreamEvent` gates every wire frame against `streamEventSchema`; transport-agnostic controller.

**Gates:** `@sow/desktop` typecheck (node + web) clean; **31/31 tests** (security + session-token + client + projections + stream controller); electron-vite production build succeeds. Launch: `pnpm --filter @sow/desktop dev`.

## Resume pointer — 9.4 (Global Today over the live worker)

The next slice is the live-worker integration + Today render. Starting map:

1. **Spawn the worker as a supervised child process** — `@sow/worker` is source-TS with native deps (better-sqlite3, temporal), so Electron main runs it via a TS runtime child process, not a bundle. `bootWorker(config)` (apps/worker/src/boot.ts) accepts an injected `SessionToken` + `WorkerOriginAllowlist` + `ProofSpineParams` + `BackendsConfig` (sqlite path, vault). Temporal-unavailable degraded mode is fine for a first render (empty read-model).
2. **Plumb the connection** — main captures the worker's ephemeral loopback port (`RunningApiServer.port`) and passes `{ baseUrl, token, origin }` to the renderer via a NEW preload channel (extend the bridge + inventory + snapshot).
3. **Origin/Host allowlist alignment** — the worker's `originAllowlist` requires the renderer's page Origin AND the loopback Host to both be allowlisted with matching authority (anti-DNS-rebind). Register the Electron renderer's real page origin (custom `app://` protocol recommended over `file://`) in the allowlist main hands `bootWorker`.
4. **Wire the real wsLink transport** into `createEventStream` (token via `connectionParams`, resume from `lastEventId`) + the httpBatchLink client for queries; the `StreamTransport` seam is ready.
5. **Port the Today mockup to React** over the store (reuse `material-direction.md` tokens); render from `UiSafeDashboardCard[]` + health + approvals.

**Deferred (carry-forward):** the renderer's client is typed against tRPC's generic router — full end-to-end procedure typing needs `@sow/worker` to emit a `.d.ts` type entry (importing its source-inferred `AppRouter` drags `packages/db` source into the renderer's DOM tsconfig: node `Buffer` vs DOM `BlobPart`). A worker-track follow-up; rendered data stays typed via `@sow/contracts`.

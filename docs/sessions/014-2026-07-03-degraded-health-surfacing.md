# Session 014 — Phase 9: degraded-health surfacing (System Health shows "Worker down")

- **Date:** 2026-07-03 · **Mode:** single-operator (build) · **Track:** worker (+ desktop worker-host)
- **Predecessor:** `013-2026-07-03-phase9-4b-live-worker.md` (live-worker transport seam, HEAD `c609f75`)
- **HEAD at close:** `9bccdd6` · **4 commits** (`41f0a93`…`9bccdd6`), all LOCAL (no remote configured)
- **Gate:** worker typecheck clean · **325 passed** / 18 skipped · SOW_API=1 boot-degraded integration 2/2 · desktop typecheck (node+web) clean · 66 · child dist (`build:sow` + `build:worker`) rebuilt · tree clean
- **Review:** security-reviewer **0 findings** (could not refute the placeholder-safety claim) · code-quality-reviewer **2 medium (both fixed) + 2 low (deferred)**

## What this session delivered

The recommended next-step #1 from session 013: **the Temporal-degraded first render now surfaces an operator-visible `worker_down` System-Health item** — the renderer's "System health" section shows **"Worker down · error · Open"** instead of a false "All systems healthy". This was the gap the reverted `135bd58` left.

## The gap (root cause)

`bootWorker` built **two disconnected health stores**:
- `createSystemHealthQueryPort(backends)` reads the **persistent `@sow/db` `health_items` table** (`backends.healthItems`) — this is what the renderer's `systemHealth.items` query returns.
- The Temporal-degraded controller's `HealthSurface` was built over an **in-memory** `HealthSurfaceStore` (`boot.ts` `createInMemoryHealthSurfaceStore`).

So even if the degraded controller recorded a `worker_down` item, it landed in process memory and never reached the query the renderer reads. And the worker-host did `void booted.connectTemporal()` — dropping the degraded result, so nothing ever drove the controller at all.

## The fix (3 slices + 1 review-response, 4 commits)

| Commit | Slice | Summary |
|---|---|---|
| `41f0a93` | 1 (worker) | `createPersistentHealthSurfaceStore(healthItems)` — a `HealthSurfaceStore` bridge over the **persistent bare `HealthItemStore`**, wired into `bootWorker` replacing the in-memory store; removed the dead in-memory helper. 6 TDD tests over real sqlite. |
| `2578f07` | 2 (worker) | `reportInitialConnect(booted, {now, logger})` — on a degraded initial connect (`!result.ok`) drives `degraded.onConnectionLost(...)`; never throws (§16). 3 TDD tests. |
| `4ba4858` | 3 (desktop) | worker-host `await`s `reportInitialConnect` **before** `send({ready})` (closes the finding-#5 hydrate race) + a SOW_API-gated end-to-end integration proof. |
| `9bccdd6` | review | (medium 1) WARN-log the persist-fault path so a silently-dropped item is never invisible; (medium 2) tighten the placeholder doc to name the *current* readers. |

## The load-bearing design decision (no `@sow/db` change needed)

The `@sow/db` `HealthItemRepository.put(item, dedupeKey, subjectRef, lastSeen)` **already owns** the OBS-2 dedupe UPSERT + `occurrenceCount`/`lastSeen` columns. So the bridge does **not** need a schema/contract-suite extension:

- `put(record)` → `healthItems.put(record.item)` — the repo does the dedupe + bookkeeping (single-sourced, no double-count). The surface's own computed `occurrenceCount`/`lastSeen` are dropped.
- `getByDedupeKey`/`list` wrap the bare `HealthItem`. `occurrenceCount`/`lastSeen` are surfaced as **placeholders** (`1` / `openedAt`) because the bare store doesn't read those columns back.

**Placeholder-safety (adversarially verified, security-reviewer could not refute):** the placeholders are read by `enrichAndPersist` (recurrence) and `persistLifecycleTransition` (ack/resolve), but every such read flows only into a `record` field that `put` **drops** (the repo re-derives it) — so a placeholder never reaches a **persisted**, **UI-visible** (the query reads the bare `list()`; `occurrenceCount` isn't on the UI-safe projection), or **lifecycle-decision** value (those read `prior.item.state`, which is honest — the frozen item carries it). Documented loudly at the adapter; if a future caller ever persists/displays a round-tripped count, extend `HealthItemRepository` to read those columns back instead.

## Display path (confirmed end-to-end)

`surface.record(worker_down)` → `healthItems` (persistent table) → `systemHealth.items` query → `toUiSafeHealthItem` (drops `message`/`auditRef` — safety rule 7) → `hydrateHealth` → `HealthSection` renders `humanizeToken(failureClass)` = "Worker down" + `{severity} · {state}`. Pinned by Slice 1's sqlite tests + the SOW_API-gated boot-degraded integration (`bootWorker → reportInitialConnect → worker_down open item via backends.healthItems.list()`).

## Deferred (low, from code-quality review — no production risk)

- The fault test's `rejects.toThrow(/unavailable/)` matches the error-code fragment inside the message; kept for consistency with the sibling `store-adapters.test.ts` convention (tighten to `/failed \(unavailable\)/` if the template ever changes).
- The `splitDedupeIdentity` fallback branch (non-canonical id) has no direct coverage in this slice; reachable only via a materializer-bypassing id (bounded).

## What's still missing (unchanged from session 013)

- **§9.4 proper** — the Global Today's **GclProjection sanitized grouped results + policy-gated drill-down** (the sanitized-global read path exercising the **WS-8 GCL visibility gate**; safety rule 4). The first REAL-DATA surface — recommended next.
- **Wire the static Today sections to real read-models** — Daily brief / schedule / recent activity / nav counts are still hard-coded `static illustrative content`.
- **9.5–9.14** surfaces + the dashboard warm-load benchmark + the desktop-security hardening pass.
- **Full AppRouter typing** — renderer client is `AnyTRPCRouter` (`(client as any)`); needs `@sow/worker` to emit an `AppRouter` `.d.ts`.
- **Packaging (deferred)** — `utilityProcess` + `@electron/rebuild` + `app://` prod paths.

## Build/run reference

- `pnpm --filter @sow/desktop dev` — builds the `@sow` dist (turbo-cached) + the host entry, launches Electron, spawns the worker; System Health shows "Worker down" on the degraded first render.
- The worker's socket + boot-degraded integration tests are `SOW_API=1`-gated.

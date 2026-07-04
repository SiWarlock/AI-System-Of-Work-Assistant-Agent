# Session 018 — §9.5/data: surfaces design fan-out + data-unlock D1 (real read-model data)

- **Date:** 2026-07-04 · **Mode:** single-operator (build) · **Tracks:** worker (+ design across contract/desktop/knowledge)
- **Predecessor:** `017-2026-07-03-push-path-scope-isolation-and-liveness.md` (HEAD `98232c0`)
- **HEAD at close:** `6ae8036` · **1 feature commit this doc covers** (`6ae8036`), all LOCAL (no remote)
- **Gate:** repo-wide `turbo typecheck test` **31/31 green** (worker 342/361 default · 356 under SOW_API=1 · db 331 · contracts/policy/desktop unchanged) · tree clean
- **Reviews:** data-unlock D1 — security **0 critical/high** (could not refute isolation/secret/one-writer/path-containment/not-a-seed) + code-quality **1 high / 2 med / 2 low** (high + isolation-low + a test-medium fixed in-slice; dup-medium flagged; 2 low sealed/deferred).

## The owner ask + how it was sequenced

Owner: *"do all three (§9.5 Project dashboard, Recent Changes, data-unlock) — pick the logical next, or parallelize."* Because all three touch the SAME load-bearing files (`packages/contracts/api/ui-safe.ts` allowlist+freeze, worker `queries.ts`/`readModel.ts`, `Today.tsx`), true parallel *implementation* would collide + can't run the per-slice TDD+review gate. So the **design** was parallelized (a Fable workflow — 3 target designs + a sequencing pass), then implementation runs sequentially in the main loop.

**Design fan-out verdict + safe order** (build-ready designs saved in the workflow journal):
1. **Data-unlock FIRST** — feasibility verdict **YES, not blocked**: nothing in production writes `read_models` (only backup-restore does), and `countCheckboxes`/`admitProjection` are pure/Temporal-free, so a dev-provision module makes surfaces show REAL data with no vendor I/O. Touches none of the 4 hot shared files. Smallest self-contained win; converts every later UI slice from "renders empty" to "verified against real content."
2. **Project dashboard** — carries the renderer routing foundation (route store + AppShell extraction, unblocks 9.6-9.14) + a new `UiSafeProjectDashboard` contract (deterministic progress, REQ-F-011) + the `project_cards` shape.
3. **Recent Changes** — purely additive after PD's allowlist settles; folds into Today's "Recent activity" (locked design — not a dedicated page); new `UiSafeRecentChange` contract over the existing `audit` table.

## What shipped this session — data-unlock D1 (`6ae8036`)

A DEV-ONLY worker provisioner (`apps/worker/src/composition/provisionDev.ts`) that turns local Obsidian-style Markdown into REAL read-model rows:
- `provisionDevWorkspace(deps, spec)` reads a vault note, parses its GFM checkboxes with the SAME deterministic parser the project-sync activity uses (`countCheckboxes`/`computePercent` — REQ-F-011, no model, no guessed %), builds a project card, upserts it (by cardId, accumulating siblings) into the **workspace-scoped** `workspace_cards`/`project_cards` rows, and unions the workspaceId into the fail-closed `workspace_registry` (WS-8). Fails closed on a missing note or an ambiguous marker (PRJ-4).
- `BootConfig.devProvision?` (OFF by default) — `bootWorker` runs it best-effort after `assembleBackends` (per-spec failure logged + skipped, try/catch-guarded; never blocks boot). Reachable from the live worker-host → `bootWorker`.

**Why it's NOT a seed** (honors the §9.4 "empty-until-data, no seed" decision): the percent derives from real file bytes through the real deterministic parser; visibility flows through the real fail-closed registry gate; it writes the exact rows `createDbReadModelQueryPort` reads. Absent files/flag, surfaces stay empty. It writes ONLY rebuildable read-model rows — never Markdown, never a semantic mutation (KnowledgeWriter's sole job — KN-4/KN-9), never secrets.

**Isolation correction from review (in-slice):** D1 writes WORKSPACE-scoped rows ONLY. The ungated global `dashboard_cards` row is deliberately NOT written — a per-workspace project card belongs to the workspace scope, and the cross-workspace surface must go through the GCL Visibility Gate (`global_surface`), which is the deferred D2 step. Also: a genuine store-fault is now distinguished from a benign `not_found` miss (a fault no longer clobbers other workspaces' cards).

### What lights up now vs. still empty
- **Real, live:** select a **workspace scope** (once `devProvision` is on with a note) → Today shows a real project card whose count is the deterministic checkbox percent. An unprovisioned scope stays fail-closed (WS-8).
- **Still empty:** **Global** Today (its cross-workspace "Across workspaces" GCL surface is D2 — gated) and the static Today sections (daily brief / schedule / nav counts).

## Remaining sequence (build-ready designs in hand)

- **D2 — gated global surface (finish data-unlock):** build `global_surface` GCL projections through the real `admitProjection` gate so Global Today's "Across workspaces" shows real gated content. Deferred: needs per-workspace visibility policy provisioned (D1 provisions read-models + registry, not policy) — a fiddlier slice.
- **② Project dashboard:** new `UiSafeProjectDashboard`/`UiSafeProjectProgress` contract (allowlist+freeze; REQ-F-011 percent refine; prose blockers/waiting/next-actions single-line, evidence refs opaque-ids-only) → worker `project_cards` shape + `query.project` honoring projectId + a dashboard sink → renderer route store + AppShell extraction (the routing foundation) → the Projects surface (deterministic progress display, never a UI-computed %). **Load-bearing:** the contract shape + the hand-rolled routing approach (no router lib) shape 9.6-9.14 — confirm/flag at the routing slice.
- **③ Recent Changes:** new `UiSafeRecentChange` contract (no workspaceId; drop payloadHash) + `recent_changes` read-model + `recentChanges({workspaceId})` query (re-validated, desc-ordered, capped) → wire Today's static "Recent activity" list scope-aware (Global shows nothing — WS-8). Projector deferrable.

## Load-bearing invariants (unchanged)
- `@sow` packages build structure-preserving behind `sow-built`; **rebuild the child dist (`pnpm --filter @sow/desktop run build:sow`) after this worker change** before the desktop dev run picks up `provisionDev`. Fork the worker child with system-node execPath.
- The isolation gate stays server/worker-side (registry gate, GCL gate, reducer scope-gate) — never the renderer view.
- Commits are LOCAL (no remote).

## Build/run + test reference
- Turn D1 on live: run the worker with `devProvision` specs (BootConfig) pointing at vault notes — the worker-host env trigger to flip it on is a small follow-up. Then a workspace scope shows the real card.
- Per-package: `pnpm --filter @sow/<pkg> typecheck && test`. Worker boot/socket tests are `SOW_API=1`-gated (`boot-provision.test.ts`, `boot-degraded.test.ts`, `api-live.test.ts`). Provisioner unit tests: `apps/worker/test/provision-dev.test.ts` (8).

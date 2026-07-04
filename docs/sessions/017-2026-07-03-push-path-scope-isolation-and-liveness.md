# Session 017 — §9.5 push-path: workspace-scope ISOLATION + LIVENESS

- **Date:** 2026-07-03 · **Mode:** single-operator (build) · **Track:** desktop
- **Predecessor:** `016-2026-07-03-session-end-handoff.md` (HEAD `9568616` → this session opened at `6419044`)
- **HEAD at close:** `db4b559` · **2 feature commits** (`39132ea`, `db4b559`), all LOCAL (no remote)
- **Gate:** contracts 594 · policy 211 · worker 335/18-skip · **desktop 98** (was 82; +16 this session) · repo-wide typecheck 20/20 · tree clean
- **Reviews:** 4 subagent passes (security + code-quality per slice). Slice 1: security **0 findings** (could not refute 5 isolation properties) + code-quality **0 findings**. Slice 2: security **0 findings** (could not refute isolation under any interleaving) + code-quality **0 high / 2 med / 2 low** (all resolved: 3 fixed in-slice, 1 documented-deferred).

## What this session did — closed the §9.5 push-path carry-forward (both halves)

Session 016 delivered §9.5 slice-1 (scope-aware **PULL** reads — the scope switcher clears + re-queries per scope, no cross-scope blend) and left the **PUSH** path as a documented carry-forward: a `read_model.change` stream event still upserted its card **regardless of scope**. This session closed that push-path gap in two slices.

| Commit | Slice | Type | Summary |
|---|---|---|---|
| `39132ea` | 1 | fix | **Push-path ISOLATION.** `applyStreamEvent` now folds a `read_model.change` card into `cards` ONLY in Global scope (where `cards` is the `query.dashboard` cross-workspace aggregate the push emits). In a workspace scope it advances the resume cursor (no re-request / no false gap) but **never blends the card** — `UiSafeDashboardCard` carries no `workspaceId`, so a workspace tab could otherwise surface a FOREIGN workspace's card. Closes "switching tabs never blends across workspaces" for the push path (Key safety rule #4). Also hardened `isWorkspaceScope` to **fail CLOSED** on an unknown scope (defense-in-depth, per security review). |
| `db4b559` | 2 | feat | **Push-path LIVENESS.** Restores live updates a workspace scope lost to the isolation suppression: on each `read_model.change` push, re-query that scope's cards through the scope-correct pull path (`query.workspace`) and replace. New `scope-refresh.ts` (`createScopeRefresher`) with a latest-wins token + stale-scope guard + no clear-first (no flicker); Global scope is a no-op (stays live via the direct fold). New `onReadModelChange` hook on the event-stream controller wires it. |

## The security model (why the gate is where it is)

- **Isolation is in the pure reducer** (`applyStreamEvent`, `store/projections.ts`), not the renderer view — the SAME `state.scope` drives both the fold-gate and the rendered tab, so they cannot diverge. The security reviewer walked every A→B / B→A interleaving and could not force a cross-workspace card into a workspace tab.
- **Fail-safe in both directions on an unknown scope:** `isWorkspaceScope` (the isolation gate) fails **CLOSED** → suppress the push; `scopeMeta`/the refresher fail to a **no-op** → no query, no card mutation. An out-of-union scope (a future persisted/deep-linked/IPC value) therefore yields a frozen-but-safe tab, never wrong data. (Intentional asymmetry — documented in `scope.ts`.)
- **The liveness refresh uses only the WS-8-enforced single-workspace pull** (`query.workspace(workspaceId)`, `workspaceId` from the hardcoded scope union — never user free-text), moving only already-UI-safe cards. No new sink/log/auth path.

## Honest boundary — LIVE WIRING over EMPTY DATA (unchanged posture)

Everything is wired + TDD-covered, but the read-models are **empty until ingestion runs** `buildGclProjection` on provisioned workspaces (onboarding §9.12). So no `read_model.change` events actually flow yet — the isolation + liveness plumbing is correct-but-invisible until data exists. Same plumbing-over-empty posture as 9.4b/§9.4.

## Deferred / follow-ups (documented in code)

- **`hydrateScope` ↔ push-refresh share no ordering token** (`live.ts` doc comment). The scope-change re-hydrate and the push-refresh each apply `replaceCards` under INDEPENDENT latest-wins tokens, so a rare **same-scope** race (a switch into B whose slow initial query resolves after a fast push-refresh for B) can transiently overwrite fresh with stale. **Scope-correct (B-under-B), non-isolation, self-healing on the next push.** A shared generation token (or an `AbortController`) would close it. Both reviewers classified it non-material.
- **§9.5 SURFACE checklist still open** (Project dashboard, Recent Changes). Both require a **new frozen UI-safe contract + a new worker read-model** that do not exist today (`query.project` returns generic cards and ignores `projectId`; no audit/knowledge-mutation read-model). Per the §9.4 owner-approval precedent + the escalation taxonomy, the new contract-surface SHAPE is a load-bearing owner decision — surfaced via `AskUserQuestion` this session (timed out; menu recorded below). They render empty until data regardless.

### The teed-up decision (for the owner's return)

Which §9.5 target next — **Project dashboard** (headline surface; new deterministic-progress contract per REQ-F-011 + new read-model + introduces renderer surface routing) vs **Recent Changes → Today** (smaller; wire Today's static "Recent activity" list to a new scoped audit/knowledge-mutation read-model) — or pivot to the **data-unlock path** (onboarding §9.12 → ingestion) so every wired-but-empty surface shows real content. All commit a new frozen contract except the data-unlock.

## Load-bearing invariants (unchanged — re-stated for the next session)

- `@sow` packages build **structure-preserving** behind the `sow-built` export condition + child-only resolve-loader — never bundle. This session was **renderer-only** (Vite-bundled) → **no `build:sow` rebuild** was needed. Rebuild the child dist only after a worker/policy/contracts change.
- Fork the worker child with `execPath` = system node (ABI). Renderer imports `@sow/contracts` via subpaths, never the barrel. Paint the pastel wallpaper, never window vibrancy.
- **The §9.4/§9.5 isolation gate is server/reducer-side** (`globalDrillDown` re-derives server-side; `applyStreamEvent` gates by `state.scope`) — never move it to the renderer view.
- Commits are LOCAL (no remote).

## Build/run + test reference

- `pnpm --filter @sow/desktop dev` — build the `@sow` dist (turbo-cached) + host entry, launch Electron, spawn the worker child. The scope switcher works; under a workspace scope the push path is now isolated (no foreign card) AND live (re-hydrates on push).
- Per-package: `pnpm --filter @sow/<pkg> typecheck && test`. Desktop suite is 98/98. Worker socket + drill-down e2e are `SOW_API=1`-gated (unaffected — renderer-only change).
- New tests this session: `test/renderer/projections.test.ts` (+6 scope-isolation), `test/renderer/scope.test.ts` (+1 fail-closed), `test/renderer/event-stream.test.ts` (+3 liveness hook), `test/renderer/live-refresh.test.ts` (+6, NEW).

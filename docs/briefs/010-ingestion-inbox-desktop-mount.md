# /tdd brief — ingestion_inbox_desktop_mount (task 9.7-C — routable desktop Ingestion Inbox surface consuming query.ingestionInbox; empty-until-producer)

## Feature
Mount the **desktop Ingestion Inbox surface** (cycle 3 of the task-9.7 arc): a routable renderer page that consumes the live `query.ingestionInbox → UiSafeIngestionItem[]` (shipped in 9.7-A) + a `hydrateIngestionInbox` cold-load + a renderer store projection, rendering the parked-source items as cards with a proper **empty-state**. Closes the task-9.7 read path end-to-end (renderer → tRPC query → WS-8 → UI-safe → render). **Renderer-only** — no worker/contract change. Ships **empty-until-producer**: the query returns `[]` today (the producer core landed in 9.7-B is dormant; its Temporal always-on wiring is deferred because the upstream `sourceIngestion` park flow is a stub), so the surface renders its empty-state now and lights up automatically once the wiring lands. Directly mirrors the shipped **Approvals page** (session 027, `770f2f0`…`eca2660`).

## Use case + traceability
- **Task ID:** 9.7 ingestion-inbox desktop surface (cycle 3 of the Rank-2 arc; 9.7-A read path + 9.7-B producer core shipped). Phase-9 user-facing surface.
- **Architecture sections it implements:** `ARCHITECTURE.md §11` (Electron Desktop UI — the surface) + `§10` (Local App API — the consumed `query.ingestionInbox`) + safety rule **4 (WS-8 workspace isolation — the surface queries per the active workspace scope; Global shows nothing here)**. Implementer confirms the §11/§10 anchor at Step 0.
- **The proven MIRROR (implementer maps exact file:line at Step 0):** the **Approvals page** — `apps/desktop/renderer/surfaces/approvals/Approvals.tsx` (the routable surface), `hydrateApprovalInbox` (cold-load fan-out over `query.approvalInbox`), the renderer store projection for approvals (`renderer/store/projections.ts` `PROJECTIONS`), the `live.ts` query wiring (`renderer/lib/live.ts`), the AppShell route mount + the route store (`renderer/chrome/AppShell.tsx`, `renderer/store/route.ts`), and the nav entry. Session 027 mounted Approvals as a routable page on the AppShell/Route foundation — this slice adds the sibling Ingestion Inbox surface the same way.
- **The contract consumed (already shipped, unchanged):** `UiSafeIngestionItem` (`packages/contracts/src/api/ui-safe.ts`) + `query.ingestionInbox(workspaceId) → Result<readonly UiSafeIngestionItem[], FailureVariant>` (9.7-A). No worker/contract edit.

## Scope boundary (IN vs deferred)
- **IN (this slice):** a NEW routable `IngestionInbox` surface (`apps/desktop/renderer/surfaces/ingestion-inbox/index.tsx`) rendering `UiSafeIngestionItem` cards (sourceId/type/sensitivity/summary) + an empty-state; `hydrateIngestionInbox` cold-load (mirror `hydrateApprovalInbox`); a renderer store projection for ingestion items; `live.ts` query wiring; the AppShell route + nav mount. Deterministic render tests (jsdom + @testing-library/react — the LESSONS §4 second-tier harness) + store-projection unit tests.
- **DEFERRED (named follow-ups — record, don't build):** (1) the **triage-resolution UI** (re-classify / routing-override / set-sensitivity → a single triage-disposition command) — the ACTION side of tracker 9.7; needs a `command.disposeTriage` renderer wiring (its own slice). (2) a live **STREAM** path for ingestion items (mirror the approvals `.update` stream) — cold-load hydrate is enough while empty-until-producer; wire the stream when the producer's Temporal wiring lands. (3) listbox ARIA roving-focus (shared codebase-wide a11y follow-up, not a regression).

## Acceptance criteria (what "done" means)
- [ ] NEW routable `IngestionInbox` surface renders one card per `UiSafeIngestionItem` (sourceId / type / sensitivity / single-line summary) and a distinct **empty-state** ("No items awaiting triage" or the design's copy) when the list is empty. No raw fields beyond the 4 UI-safe ones are read/rendered (the contract already dropped them; the surface must not reach past it).
- [ ] `hydrateIngestionInbox` cold-loads via `query.ingestionInbox` for the ACTIVE workspace scope on connect (mirror `hydrateApprovalInbox`); a query `err` surfaces as a typed non-crashing state (no throw), not a blank/broken page.
- [ ] A renderer store projection holds the ingestion items (mirror the approvals projection); the surface reads from the store. Feeding it the hydrate result renders the cards; feeding `[]` renders the empty-state.
- [ ] **WS-8 / scope:** the surface queries per the active workspace scope; under **Global** it shows the empty-state (the 9.7 read path is workspace-scoped, surfaces nothing globally) — no cross-workspace blend. (Mirror the scope handling the approvals/dashboard surfaces use.)
- [ ] Routable + reachable: the surface is mounted on the AppShell route + nav (mirror Approvals); navigating to it renders (empty-state today).
- [ ] Renderer-scoped `turbo typecheck test` green (this is renderer-only — consumes the existing `@sow/contracts` `UiSafeIngestionItem` + the mounted query; NO worker/contract change). The jsdom render tests + store-projection tests green.

## RED test outline (write cases first)
1. `renders_cards_from_store` — a store seeded with 2 `UiSafeIngestionItem`s ⇒ the surface renders 2 cards showing sourceId/type/sensitivity/summary.
2. `renders_empty_state_when_none` — an empty store ⇒ the distinct empty-state renders (not a blank page, not a spinner-forever).
3. `hydrate_populates_store` — `hydrateIngestionInbox` given a fake client returning 2 items ⇒ the store holds 2 items (surface then renders them).
4. `hydrate_error_is_non_crashing` — the query returns `err` ⇒ hydrate resolves to a typed empty/error state; the surface renders the empty-state (or an inline error), never throws / white-screens.
5. `store_projection_pure` — the store projection over a hydrate payload is a pure, deterministic mapping to the render model (no drift from `UiSafeIngestionItem`).
6. `scope_global_empty` — under the Global scope the surface shows the empty-state (the workspace-scoped query yields nothing globally) — no cross-workspace items.
7. `route_mounts_surface` — navigating to the ingestion-inbox route renders the surface (reachable on the AppShell route).

## Cross-doc invariant impact
- **NONE.** Renderer-only surface consuming the already-shipped `UiSafeIngestionItem` + `query.ingestionInbox`. No Appendix-A seam, no schema/snapshot, no `@sow/contracts` change, no cross-doc-table row. (Same family as the Approvals page mount, which was `Cross-doc invariant: none`.)

## Things to flag at Step 2.5 (design questions — default votes)
1. **Cold-load only vs. stream now (load-bearing scope).** Default vote: **cold-load hydrate only** this slice (mirror the initial approvals hydrate); the live `.update` STREAM path is DEFERRED (the list is empty-until-producer, so a stream adds nothing until the producer's Temporal wiring lands — and the 9.5 stream-scope-filter precedent needs a `workspaceId` on the streamed item, which `UiSafeIngestionItem` intentionally drops). Confirm.
2. **Empty-state copy + the triage-action affordance.** Default vote: render a read-only inbox + empty-state THIS slice; the triage-resolution ACTIONS (re-classify / routing-override / set-sensitivity → `command.disposeTriage`) are the DEFERRED follow-up (tracker 9.7 action side). Confirm we ship read-only now.
3. **Scope behavior under Global.** Default vote: empty-state under Global (the read path is workspace-scoped, WS-8 — no Global ingestion aggregation), matching how the workspace-scoped surfaces behave. Confirm.

## Wiring / entry point (Step 7.5)
- **Entry point:** the `IngestionInbox` surface is a routable page on the AppShell route + nav (mirror Approvals); `hydrateIngestionInbox` runs on connect. Reachable now — renders the empty-state until the producer's Temporal wiring populates the read-model. Name the route + hydrate call at Step 7.5.
- **Blocks:** the triage-resolution UI (deferred) mounts on this surface. Does not block anything else.
- **Depends on:** 9.7-A (`query.ingestionInbox` + `UiSafeIngestionItem`, live) + the AppShell/Route foundation + the jsdom render-test harness (all present).

## Estimated commit count
**1.** The surface + hydrate + store projection + live wiring + route mount + tests (all renderer-side; consumes the existing query/contract). Renderer-scoped gate. NOT a safety-critical leakage surface (the contract already dropped raw refs at 9.7-A; this only reads the 4 UI-safe fields) ⇒ Step-8 review is OPTIONAL (per policy: not invariant-touching) — but a quick self-check that the surface reads NOTHING past `UiSafeIngestionItem` is worth a line at Step 8.

## Lessons-logged candidates (implementer flags Step 9)
- Unlikely to need a new lesson (mirrors the Approvals page). If the empty-until-producer render pattern surfaces something reusable, fold into the existing UI-safe / read-model lesson (§10). Implementer's call.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read the Approvals page mirror end-to-end (`Approvals.tsx`, `hydrateApprovalInbox`, the store projection, `live.ts` query wiring, the AppShell route + nav mount) + confirm `query.ingestionInbox` + `UiSafeIngestionItem` shapes. Load `apps/desktop/CLAUDE.md` for the desktop-area conventions + the jsdom render-test harness (LESSONS §4).
2. Step 2.5 — ping Q1–Q3 (defaults above; Q1 cold-load-vs-stream + Q2 read-only-vs-actions are the scope-shaping ones) BEFORE writing cases.
3. RED first (render-cards + empty-state + hydrate + scope-Global-empty are the load-bearing ones).
4. Step 8 — review OPTIONAL (not a safety-invariant slice); DO self-check the surface reads only the 4 `UiSafeIngestionItem` fields (never reaches past the contract) + hydrate-error is non-crashing.
5. Step 9 — categorized flags (the deferred triage-action UI + the stream path) + ship-ask.

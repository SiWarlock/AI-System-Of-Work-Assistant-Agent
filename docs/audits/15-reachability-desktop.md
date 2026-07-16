# Reachability Audit — Phase 15, DESKTOP area (`apps/desktop`)

- **HEAD:** `1461c815`
- **Area:** `apps/desktop` (renderer)
- **Phase-15 surface under audit:** 15.8 Ingestion Inbox reroute/assign-project action (commit `cd1b7cb4`, "closes G60 desktop half")
- **Scope (incremental):** the 5 production files 15.8 touched — `renderer/App.tsx`, `renderer/lib/live.ts`, `renderer/lib/reroute-picker.ts` (new), `renderer/lib/triage-disposition.ts`, `renderer/surfaces/ingestion-inbox/index.tsx`. Prior Phase-15 desktop reachability facts (15.x note-body / inbox producer) are worker-area, not desktop, and untouched here.
- **Method:** codegraph (`codegraph_explore` for verbatim source; `codegraph_callers` for buildTriageMutationInput / reroutePickerOptions / createTriageDisposition / IngestionInbox) + targeted confirmation of the two dynamic-dispatch hops codegraph could not follow (React JSX render + handle-object field assignment).

## Production entry point

The renderer root component **`App()`** (`renderer/App.tsx`), mounted by the Electron renderer bootstrap — the single UI-safe window. This is the pre-existing, trusted renderer entry; all UI reachability terminates here.

## New / changed exports audited

| # | Symbol | File:line | Kind | Class |
|--:|---|---|---|---|
| 1 | `reroutePickerOptions` | `renderer/lib/reroute-picker.ts:41` | function | REACHABLE |
| 2 | `buildTriageMutationInput` | `renderer/lib/triage-disposition.ts:76` | function | REACHABLE |
| 3 | `ReroutePickerOptions` | `renderer/lib/reroute-picker.ts` | interface | REACHABLE |
| 4 | `RerouteWorkspaceOption` | `renderer/lib/reroute-picker.ts` | interface | REACHABLE |
| 5 | `RerouteProjectOption` | `renderer/lib/reroute-picker.ts` | interface | REACHABLE |
| 6 | `RerouteTarget` | `renderer/lib/triage-disposition.ts:27` | interface | REACHABLE |
| 7 | `TriageMutationInput` | `renderer/lib/triage-disposition.ts:36` | interface | REACHABLE |
| 8 | `TriageCommandBuild` | `renderer/lib/triage-disposition.ts:44` | type | REACHABLE |
| 9 | `IngestionInboxProps.reroute` (extended) | `renderer/surfaces/ingestion-inbox/index.tsx:48` | prop | REACHABLE |
| 10 | `StartLiveHandle.disposeTriage` (extended sig) | `renderer/lib/live.ts:60` | field | REACHABLE |

REACHABLE: 10 · UNREACHABLE: 0

## Proof chain A — `reroutePickerOptions` (registry-sourced picker)

`App()` (`App.tsx`) invokes `reroutePickerOptions(state.onboarded, state.projects, resolveOnboardedWorkspaceId(...))` → binds `const rerouteOptions` → passed `reroute={rerouteOptions}` to `<IngestionInbox>` on the ingestion route (`App.tsx:258-261`, `state.route.surface === "ingestion"`). Inside the surface, `IngestionCard` renders the workspace/project `<select>`s from `reroute.workspaces` / `reroute.projects` and gates the project sub-picker on `reroute.projectsWorkspaceId` (WS-8).
- codegraph_callers(`reroutePickerOptions`) = `App` (App.tsx:41). Sole caller is production; no test-only reference.
- **REACHABLE** from the renderer entry.

## Proof chain B — `buildTriageMutationInput` (payload builder → `disposeTriage.mutate`)

Button click path, bottom-up:
1. `IngestionCard.submitReroute()` / `dispose()` call `onDispose(item.sourceId, disposition, target?)` (`ingestion-inbox/index.tsx:89,111`).
2. `onDispose` is `App.onDisposeTriage` (passed `onDispose={hasLiveWorker ? onDisposeTriage : undefined}`, `App.tsx:260`).
3. `App.onDisposeTriage` calls `handle.disposeTriage(sourceId, disposition, target)` (`App.tsx:140`), where `handle` = the `StartLiveHandle` from `startLive(store)` (`App.tsx:54`).
4. `startLive` assigns `disposeTriage: createTriageDisposition(live.client)` on the returned handle (`live.ts:140`).
5. `createTriageDisposition`'s returned closure calls `buildTriageMutationInput(sourceId, disposition, target)` (`triage-disposition.ts:107`), then `client.command.disposeTriage.mutate(built.input)` (`triage-disposition.ts:110`).
- codegraph_callers(`buildTriageMutationInput`) = `createTriageDisposition` (sole caller); codegraph_callers(`createTriageDisposition`) = none (miss: consumed via the object-literal field `disposeTriage:` at `live.ts:140`, a dynamic-dispatch hop grep/index does not follow) — confirmed by direct read. Both hops are production, no test-only reference.
- The **reroute branch** of `buildTriageMutationInput` (the `disposition === "reroute"` arm, target-encoded idempotency key, `reroute_target_required` fail-closed) is exercised in production: `App` always passes `reroute={rerouteOptions}` so the Reroute control renders, and `submitReroute` dispatches `disposition:"reroute"` with a registry-picked `target`.
- **REACHABLE** from the renderer entry, terminating at the triage tRPC `command.disposeTriage.mutate`.

## Dynamic-dispatch hops codegraph missed (confirmed manually)

- `IngestionInbox` — codegraph_callers = none; actually rendered as JSX `<IngestionInbox …/>` at `App.tsx:258` (React render is not a static call edge). REACHABLE.
- `createTriageDisposition` — codegraph_callers = none; actually invoked at `live.ts:140` as the `disposeTriage` handle field. REACHABLE.

Both are the expected JSX-render / handle-field patterns (apps/desktop LESSONS §4, §11), not genuine gaps.

## Result

All 10 new/changed Phase-15 desktop exports trace to the production renderer entry `App()`; the two flagged targets (`buildTriageMutationInput`, `reroutePickerOptions`) are both called on the production path, not only from tests (`test/renderer/*.test.ts`, `test-dom/*.test.tsx` references are additional, not sole).

**Phase-exit gate (desktop): CLEAR — 0 unreachable, 0 wiring tasks recommended.**

Note (out of scope, informational): the commit's `Reachable from …` line and the LIVE `/design-review` of the reroute control + `aria-controls` a11y are already logged as a Future TODO in `cd1b7cb4`; those are UX/review debt, not a reachability gap.

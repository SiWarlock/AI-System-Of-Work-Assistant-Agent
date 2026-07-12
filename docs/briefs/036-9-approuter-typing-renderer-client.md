# /tdd brief — approuter_typing_renderer_client (Phase 9, pivot slice 2)

## Feature
Type the desktop renderer's tRPC client against the worker's **concrete** `AppRouter` instead of the generic `AnyTRPCRouter`, and remove the **9** `client as any` casts across the 8 renderer `lib/` files. End-to-end procedure typing: `client.query.*` / `client.command.*` / `client.systemHealth.*` / `client.stream.*` / `globalDrillDown` all resolve to their real UI-safe input/output types at compile time. This is a **typing refactor — tsc/typecheck-as-RED, not classic unit-TDD**. Pure local, non-HITL, no safety surface (types only). Cross-package (worker build-config + desktop tsconfig + renderer) ⇒ repo-wide `pnpm -w turbo run typecheck test` gate.

## Use case + traceability
- **Task ID:** 9-approuter-typing — PHASE-9 carry-forward item (e) ("full AppRouter typing — the renderer client is typed against `AnyTRPCRouter`; needs `@sow/worker` to emit an `AppRouter` type entry"; origin session 013). Cross-cutting renderer-client typing that advances the Phase-9 renderer surfaces, incl. the 9.5 workspace-tabs / project-dashboard / recent-changes client calls (scope-refresh, drilldown) this slice retypes.
- **Architecture sections it implements:** `ARCHITECTURE.md §11` (Electron Desktop UI — the renderer's typed loopback tRPC client). (§11 ∈ Phase 9 Spec anchors — **no widen**. The worker already *produces* the type; this slice only makes the renderer *consume* it and enables the build-emit that lets it — no §10 API behavior change.)
- **Related context:** the PIVOT-IN-PROGRESS note (pivot slice 2); pivot slice 1 = 9-a11y (`5c55011`). The deferral is documented in-code at `apps/desktop/renderer/lib/trpc.ts:4-10` — the client is typed generic **because** importing the worker's *source-inferred* `AppRouter` drags `@sow/db` source into the renderer's DOM tsconfig (node `Buffer` vs DOM `BlobPart` global conflict); the stated fix is "the worker must emit a `.d.ts` type entry." Desktop **Lesson 1** (the `sow-built` export-condition + structure-preserving `dist` build) is the pattern this slice extends.

**Confirmed current state (pre-orient):**
- Worker **already exports** the type: `apps/worker/src/api/server.ts:109` `export type AppRouter = ReturnType<typeof composeAppRouter>`, re-exported from the package entry `apps/worker/src/index.ts`. `apps/desktop` already deps `@sow/worker` (`workspace:*`).
- Worker build does **NOT** emit declarations today: `apps/worker/tsconfig.build.json` sets `declaration: false` → **no `dist/index.d.ts` exists**. `@sow/worker` `exports["."]` = `{ "sow-built": "./dist/index.js", "default": "./src/index.ts" }` (default → source).
- Base tsconfig (`tsconfig.base.json`): `moduleResolution: "Bundler"`, `verbatimModuleSyntax: true`, `declaration: true` (base default, overridden off in the worker build), `skipLibCheck: true`.
- Desktop `tsconfig.web.json`: extends base, `lib: ES2022+DOM`, `types: ["vite/client"]`, `include: ["renderer","preload/api.d.ts"]`, **no** `paths`/`references`/`customConditions`.
- `turbo.json`: `typecheck` `dependsOn: ["^build"]` (upstream `@sow/worker` builds `dist/**` before desktop typecheck runs).

**Cast / type-annotation inventory (verified — the exact edit surface):**
- Client creation (`CreateTRPCClient<AnyTRPCRouter>` + `createTRPCClient<AnyTRPCRouter>`): `trpc.ts:31,32` (+ deferral NOTE `:4-10`); `live-client.ts:25,35`.
- Consumer fn signatures (`client: CreateTRPCClient<AnyTRPCRouter>`) + their `const c = client as any` casts: `live.ts` params `:120,171,205,248` / casts `:134,177,217,256` (4); `approval-decision.ts:29`/cast`:35`; `scope-refresh.ts:26`/cast`:37`; `drilldown.ts:17`/cast`:23`; `copilot-ask.ts:17`/cast`:23`; `ws-transport.ts:17`/cast`:25`.
- Totals: **9** `client as any` casts, **8** files, ~11 `AnyTRPCRouter` annotation sites, each preceded by `import type { AnyTRPCRouter } from "@trpc/server"`.

## Acceptance criteria (what "done" means)
- [ ] `@sow/worker` emits `dist/index.d.ts` (and `dist/api/server.d.ts`) on `pnpm --filter @sow/worker build`; `AppRouter` is present in the emitted declaration.
- [ ] The renderer's tRPC client is typed `CreateTRPCClient<AppRouter>` (via `import type { AppRouter } from "@sow/worker"`) at all client-creation sites (`trpc.ts`, `live-client.ts`) and all consumer signatures (`live.ts`, `approval-decision.ts`, `scope-refresh.ts`, `drilldown.ts`, `copilot-ask.ts`, `ws-transport.ts`).
- [ ] **All 9 `client as any` casts gone** — 8 fully removed (query/command/systemHealth calls resolve to concrete procedure types; a wrong name/input is now a compile error). The 9th (`ws-transport.ts` `stream.onEvent`) becomes a **typed, compile-checked adapter** (`client.stream as unknown as { onEvent: StreamOnEventProc }`), **not** `as any` — the worker intentionally types the subscription sub-router `AnyRouter` to keep the `AppRouter` declaration emittable (TS2742; `pushStream.ts:131-139`), so `stream.onEvent` is erased on the emitted type. The adapter's payload anchors to the stream-event contract + stays runtime-validated by `streamEventSchema`. **Net: zero `as any`/`@ts-expect-error` in `renderer/lib`.** (Step-7.5 resolution — the anticipated TS2742 (Step-2.5 #2) materialized on the subscription only; query/command/systemHealth typed clean.)
- [ ] The renderer's DOM tsconfig (`tsconfig.web.json`) type-checks clean — importing `AppRouter` does **NOT** pull `@sow/db`/`node` source into the DOM program (no `Buffer`/`BlobPart` conflict). `@sow/contracts` type resolution is unchanged (stays DOM-safe).
- [ ] The `trpc.ts:4-10` deferral NOTE is deleted (replaced, if useful, by a one-line note on the build-order dependency).
- [ ] Repo-wide `pnpm -w turbo run typecheck test` green; `/preflight` clean. Existing renderer render-tests + `trpc`/client unit tests stay green.
- [ ] No frozen-contract / Appendix-A model field change (confirm none — the `@sow/worker` package `exports` + build config are not a frozen contract).

## Wiring / entry point (Step 7.5)
**none-new** — the typed client **IS** the existing production client. `createWorkerClient` (`trpc.ts`) + `createLiveClient` (`live-client.ts`) are already consumed by the renderer bootstrap + worker-host on the real app path; this slice tightens their types in place. No new route/job/entry point. The build-emit change is behind the existing package resolution.

## Files expected to touch
> **Step-2.5 resolution (proven, `--explainFiles`-verified 2026-07-12):** B1-as-first-specified was insufficient. **Finding 1** — `AppRouter` is not a top-level `@sow/worker` export; `src/index.ts` does `export * as apiServer from "./api/server"`, so the redirect targets `dist/api/server.d.ts` (which exports `AppRouter` directly) — **no `src/index.ts` change, no `package.json` `exports` change** (`paths` bypasses package-exports resolution). **Finding 2** — `AppRouter`'s type graph transitively imports `@sow/db` (`server.d.ts → commands.d.ts → approvalCommands.d.ts → import "@sow/db"`); with no built `@sow/db` d.ts it falls back to node-`Buffer` **source** (`skipLibCheck` skips `.d.ts`, not source) → the DOM conflict. Fix = **also** emit + redirect `@sow/db`. `--explainFiles` confirmed only `@sow/db` is node-heavy among the {contracts, db, domain, policy} source the web program pulls; contracts/domain/policy stay DOM-safe on source. The list below reflects the proven design.

**Modified:**
- `apps/worker/tsconfig.build.json` — `declaration: true` (+ `declarationMap: true`) so the build emits `dist/**/*.d.ts` (incl. `dist/api/server.d.ts`).
- `packages/db/tsconfig.build.json` — **`declaration: true`** (Finding 2) so `@sow/db` emits `dist/index.d.ts`; the web tsconfig redirects to it and `skipLibCheck` skips its node-`Buffer` declaration. (Added at Step 2.5; within this single-track's territory.)
- `apps/desktop/tsconfig.web.json` — **two** surgical `paths` entries: `"@sow/worker": ["../worker/dist/api/server.d.ts"]` + `"@sow/db": ["../../packages/db/dist/index.d.ts"]`. Redirects ONLY the two node-heavy packages to their built declarations; contracts/domain/policy untouched (DOM-safe source).
- ~~`apps/worker/package.json` exports `types`-condition~~ — **NOT needed** (`paths` bypasses package-exports).
- `apps/desktop/renderer/lib/trpc.ts` — `AnyTRPCRouter`→`AppRouter`; drop the `:4-10` deferral NOTE.
- `apps/desktop/renderer/lib/live-client.ts` — `AnyTRPCRouter`→`AppRouter` (interface field + `createTRPCClient` param).
- `apps/desktop/renderer/lib/live.ts` — 4 consumer signatures + remove 4 casts.
- `apps/desktop/renderer/lib/{approval-decision,scope-refresh,drilldown,copilot-ask,ws-transport}.ts` — signature + cast removal (1 each).

If implementation needs files beyond this list (e.g. an explicit type annotation at `server.ts` `composeAppRouter` to satisfy declaration emit — see Step-2.5 #2), **flag at Step 2.5** before going GREEN.

## RED test outline (Step 2)
This is a **typing refactor**; the RED is a **red `tsc`/typecheck**, not a vitest unit test. The implementer creates the RED, then makes it GREEN:

1. **RED (source-pull / untyped-proc) — the honest failing state.** Type ONE client-creation site (`trpc.ts`) + ONE consumer (`drilldown.ts`, removing its cast) against `import type { AppRouter } from "@sow/worker"` **before** the worker-emit + resolution redirect. Run `pnpm --filter @sow/desktop exec tsc --noEmit -p tsconfig.web.json` → it **FAILS** (either the `@sow/db`-source-into-DOM `Buffer`/`BlobPart` conflict, or `AppRouter` resolves to an unusable source-inferred shape). This is the documented `trpc.ts:4-10` blocker, reproduced.
2. **GREEN — enable the emit + redirect.** Flip worker `declaration:true`, add the `types` export condition, add the desktop resolution redirect; build worker; re-run the DOM typecheck → clean, and `c.query.globalDrillDown.query(...)` is now concretely typed.
3. **Full swap.** Apply `AppRouter` + remove all 9 casts across the 8 files. Run `pnpm -w turbo run typecheck test` → **green** (any genuine call-shape mismatch surfaces here as a real error to fix — that is the coverage).
4. **Optional deterministic pin (only if cheap):** a `test-dom` type-assertion (`expectTypeOf(client.systemHealth.items.query).returns...` `.not.toBeAny()`) — include ONLY if vitest `--typecheck` is already viable in the desktop config; otherwise the repo-wide typecheck gate is the pin. Do **not** stand up new type-test infrastructure for this slice.

**Coverage note for Step 2.5:** the acceptance is "the real router types verify every call site + repo-wide typecheck stays green with the casts gone." Map that to the `turbo typecheck` gate + the reproduced-then-resolved DOM-conflict RED, not to N new unit tests.

## Cross-doc invariant impact
- **Model field changes:** none — no contract / Appendix-A model touched.
- **Orchestrator doc rows to write hot (Step 9):** none anticipated. (If the `sow-built` `types`-condition pattern is judged a reusable convention, it's a **desktop/worker Lesson candidate**, not a cross-doc invariant.)
- **Shared-contract (§2.5-seam) model touched?** No. `AppRouter` is an inferred *type surface*, not a frozen Appendix-A contract; no schema-snapshot test applies.

## Things to flag at Step 2.5
1. **Type-resolution redirect mechanism — RESOLVED at Step 2.5 (proven).** Surgical `paths` (B1), but **two** entries, not one: `@sow/worker`→`../worker/dist/api/server.d.ts` (narrow — `index.d.ts` drags the whole `@sow/db`-importing surface) **and** `@sow/db`→`../../packages/db/dist/index.d.ts` (Finding 2 — the transitive node-heavy reach). contracts/domain/policy stay on DOM-safe source. The alternative — `customConditions: ["sow-built"]` + build d.ts for all `@sow/*` — was rejected (larger blast radius; the two-package redirect is the minimal `--explainFiles`-verified set).
2. **Worker declaration-emit risk — tRPC deeply-inferred `AppRouter`.** Flipping `declaration:true` may surface `TS2742` ("inferred type of X cannot be named without a reference to …") at the `composeAppRouter`/`AppRouter` export boundary. Default vote: **enable emit; if TS2742 fires, add the minimal explicit type annotation / named export at that one boundary in `server.ts`** — do NOT restructure the router. Flag if it cascades beyond one or two sites (that would widen the slice into worker-track surface).
3. **`declarationMap` on/off.** Default: **on** (go-to-def from the renderer into worker source; harmless `.d.ts.map` alongside). Minor — drop if it complicates the build.
4. **Build-order for a LOCAL (non-turbo) typecheck.** After this, `tsc -p tsconfig.web.json` depends on `apps/worker/dist/index.d.ts` existing. The repo-wide gate `pnpm -w turbo run typecheck` covers it (`typecheck dependsOn ^build`). Default: **rely on the turbo gate + document the "build worker first for a bare local typecheck" caveat** in a one-line note where the deferral NOTE was. Confirm you run the turbo gate, not a bare `tsc`, for the acceptance check.
5. **Cast-removal scope — one commit or split?** Default vote: **one atomic commit** — the worker-emit + resolution redirect + all 9 cast removals are one logical unit (the swap without the emit fails typecheck; they must land together to keep the tree green + bisectable). No safety surface → single commit.

## Dependencies + sequencing
- **Depends on:** pivot slice 1 (9-a11y, `5c55011`, landed). The worker's existing `AppRouter` export (present). The `sow-built` build/export-condition pattern (Lesson 1, present).
- **Blocks:** cleaner end-to-end typing for future renderer surfaces + any slice that adds a new procedure (mistyped calls now caught at compile time). Unblocks removal of the `trpc.ts` deferral debt.

## Estimated commit count
**1.** A focused cross-package typing refactor (worker build-emit + desktop resolution redirect + renderer swap), one logical unit, must land atomically to keep `turbo typecheck` green. **No safety invariant** (types only, no worker/contract/egress/secret behavior change) → **code-quality review suffices; security-reviewer NOT required** (per lead). One commit.

## Lessons-logged candidates anticipated
- **Convention candidate** — "a renderer/DOM tsconfig consumes a node-heavy workspace package's inferred type surface via its **built `.d.ts`** (surgical `paths` / `sow-built` `types` condition), never source — source resolution drags node globals (`Buffer`) into the DOM program (`BlobPart` conflict)." A concrete extension of desktop Lesson 1.
- **Future TODO — operational** — worker `declaration` emit adds build time; if the inferred `AppRouter` d.ts is large/slow, consider a dedicated narrow typed export. Note only if it bites.
- **Architecture-doc note candidate** — none expected (no behavior/contract change).

## How to invoke
1. Read this brief end-to-end (typing refactor; RED = red tsc, not a unit test; the design call is Step-2.5 #1). 2. `/tdd approuter_typing_renderer_client`. 3. Step 0 restate: type the renderer client against `@sow/worker`'s built `AppRouter` + drop the 9 casts; worker emits d.ts; desktop redirects `@sow/worker` resolution to the built declaration. 4. Step 1: confirm the file list. 5. Step 2/2.5: reproduce the DOM-conflict RED, then answer the five design questions (resolution mechanism, TS2742 risk, declarationMap, build-order, commit scope). 6. Step 8: code-quality review (no security surface). 7. Step 9: flags + ship-ask (esp. if TS2742 widened the worker surface).

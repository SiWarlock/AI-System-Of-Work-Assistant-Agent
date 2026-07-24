<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (Electron desktop UI)

> Full prose for every lesson logged during work in `apps/desktop/`. The compact index lives in `apps/desktop/CLAUDE.md` "Lessons logged" table.
>
> **Lesson numbers are stable IDs.** New lessons get the next sequential number. Numbers may be referenced from code comments, commit messages, and cross-references between lessons. **Don't reorder; don't reuse a deleted number's slot.**
>
> **Lessons start at §1.** Each code area has its own lesson sequence — lessons don't carry across code areas.

---

## Lesson format

```markdown
## <a id="N"></a>N. <Short topic> — <one-line rule>

**Date:** YYYY-MM-DD.
**Source slice:** <slice-id or commit hash>.

<2-5 paragraphs explaining: what was discovered, why it matters, how to
apply the rule, what edge cases are still open. Cite file:line references
where applicable.>

**Rule:** <one-sentence summary, same as the heading subtitle>.
```

---

## <a id="1"></a>1. Bundler-authored source-TS packages that read data files must build STRUCTURE-PRESERVING, not bundled — run them in a spawned process via an export condition + a resolve-loader

**Date:** 2026-07-03.
**Source slice:** 9.4b D2/D3 (`a2e3109`).

To run `@sow/worker` (source-TS + native deps) as a spawned child process, the instinct is to bundle it. **Bundling is the wrong tool here, and it fails for a concrete reason:** `@sow/contracts/src/schema/registry.ts` loads its JSON Schemas at runtime via `readFileSync(new URL('../../schemas', import.meta.url))`. Any bundler collapses `src/schema/registry.ts` into a shallower output path, so the `../../schemas` relative resolve points at the wrong directory and the schema registry silently returns empty (its read is `try/catch`-swallowed). CJS output makes it worse — `import.meta.url` is empty in CJS. Bundling was proven to break this end-to-end.

**The rule:** a package that reads sibling data files relative to `import.meta.url` (or `__dirname`) must run **from a location that mirrors its source layout**. So each `@sow` package builds **structure-preserving** via `tsc` (`rootDir: src` → `dist/` mirrors `src/`, so `dist/schema/registry.js`'s `../../schemas` still resolves), NOT bundled. To let the spawned child pick the built JS while dev/tests/Vite keep using source unchanged, add an **export condition**: `"exports": { ".": { "sow-built": "./dist/index.js", "default": "./src/index.ts" }, "./*": { "sow-built": "./dist/*.js", "default": "./src/*.ts" } }`, and run the child with `node --conditions=sow-built`. This is fully transparent to the source toolchain (verified: contracts 587 / worker 316 unchanged).

**Second half of the problem:** these packages are bundler-authored (`moduleResolution: Bundler`, **extensionless** relative imports). Plain `tsc` emits extensionless ESM that Node's ESM resolver rejects; CJS output would fix extensions but kill `import.meta.url`. The fix is a tiny **child-only ESM resolve hook** (`worker-host/resolve-loader.mjs`, registered via `--import`) that appends `.js`/`/index.js` to relative specifiers. It is scoped to the spawned child and never touches the dev toolchain. (`tsc-alias` is the alternative — a build-time import rewrite — but the runtime hook is smaller and keeps the emitted JS pristine.)

**Also surfaced:** `apps/worker/src/composition/backends.ts` does `require_("better-sqlite3")` / `require_("drizzle-orm/better-sqlite3")` (createRequire) — under-declared deps that resolved via pnpm hoist in vitest but NOT from the built `dist/` location. Declare what you `require_`.

**Rule:** a package that reads data files via `import.meta.url` must build structure-preserving (tsc, `dist` mirrors `src`) behind a `sow-built` export condition + a child-only extension-appending resolve-loader — never bundle it.

## <a id="2"></a>2. Electron `child_process.fork` spawns the ELECTRON binary — set `execPath` to system node to keep a native-module ABI

**Date:** 2026-07-03.
**Source slice:** 9.4b D4 (`cc74a64`).

`child_process.fork(module)` defaults `execPath` to `process.execPath`, which in an Electron main process is the **Electron binary** (Electron's Node ABI), not system node. A worker child forked that way loads native modules under Electron's ABI — so `better-sqlite3` built by pnpm for *system* node fails to load (ABI mismatch). Conversely, rebuilding it for Electron (`@electron/rebuild`) breaks the worker's own vitest suite, which runs under system node — a single `.node` binary can't serve both.

For DEV, fork the worker child with `execPath` = system node (`fork(entry, [], { execPath: process.env.SOW_WORKER_NODE ?? "node", ... })`) so native deps keep the system-node ABI the test suite already uses. Packaging is where Electron-ABI native code belongs: `utilityProcess.fork` + `@electron/rebuild` for the packaged app, which is a separate, package-time step (deferred by design — it would red-line the system-node test suite if done in dev).

**Rule:** in Electron, `child_process.fork` a Node child with `execPath` set to system node (not the default Electron binary) so native-module ABIs match the dev/test toolchain; move to `utilityProcess` + `@electron/rebuild` only at packaging.

## <a id="3"></a>3. The desktop `test/` dir compiles under the NODE tsconfig (no DOM) — keep `window`-free renderer logic in its own module so tests can import it

**Date:** 2026-07-03.
**Source slice:** §9.5 slice-2 liveness (`db4b559`).

The desktop package splits typecheck across two tsconfigs: `tsconfig.web.json` (lib `DOM`, `include: ["renderer", …]`) and `tsconfig.node.json` (lib `ES2023`, **no DOM**, `include: ["main", "preload", "test", …]`). Note the whole `test/` dir — including `test/renderer/*` — is compiled under the **node** config. So a renderer module that references `window` (e.g. `lib/live.ts`, which reaches the `window.sow` preload bridge) typechecks fine when only imported from `renderer/` (web config), but the instant a **test** imports it, `tsc -p tsconfig.node.json` compiles that module without the DOM lib and errors `TS2304: Cannot find name 'window'`.

This bit when adding `createScopeRefresher` to `live.ts` and importing it from a new test: the test dragged `live.ts` (and its `window` usage) into node compilation. The fix was architectural, not a lib tweak — `createScopeRefresher` has **no** `window`/bridge dependency (it needs only a tRPC client + the store), so it belongs in its own `renderer/lib/scope-refresh.ts`. `live.ts` imports it; the test imports the window-free module directly; node-config compilation stays clean. Bonus: better separation (the pure refresh logic isn't coupled to the bridge module).

**Rule:** renderer logic you want to unit-test must not transitively reference `window`/DOM globals, because `test/` compiles under the DOM-less node tsconfig — extract `window`-free, dependency-injected logic (client/store in, no bridge) into its own module and import THAT from the test, leaving the `window`-coupled glue (`live.ts`) imported only from `renderer/`.

## <a id="4"></a>4. Add JSX-render tests as a SECOND tier — a `test-dom/` dir + jsdom + its own tsconfig — never by loosening the node tier

**Date:** 2026-07-04.
**Source slice:** session 022 harness (`d1667c8`).

Lesson §3 keeps the `test/` tier DOM-less so window-free logic is the testable unit. But some behavior only exists in a mounted component — the left-rail nav dispatching `onNavigate` on click, the §9.4 scope switcher's open/select/Escape/outside-mousedown dismissal, the WS-8 empty-state branch a surface picks. Two prior reviews flagged that this UI wiring had **zero** automated coverage (review-verified only). The wrong fix is to add DOM lib to `tsconfig.node.json` / switch the vitest env to jsdom — that silently drops the DOM-less guarantee §3 depends on (a `window` reference would stop erroring, so window-coupled logic could sneak into a "pure" module untested-for-portability).

The right fix is a **parallel second tier** that leaves the node tier exactly as-is:
- `test-dom/*.test.tsx` — render tests, each with a `// @vitest-environment jsdom` docblock (the global vitest env stays `node`; only these files get a DOM).
- `tsconfig.testdom.json` — `lib: ["…","DOM","DOM.Iterable"]` + `jsx: "react-jsx"` + `include: ["test-dom"]` **only**. Scoping the include to `test-dom` (not `renderer`) matters: including `renderer` drags in `App.tsx`, whose `import.meta.env` needs `vite/client` and fails otherwise — the imported components (`AppShell`/`Projects`/…) are still type-checked **transitively** through the tests' imports, so there's no coverage hole. Add `vite/client` to `types` as a cheap guard for any transitively-pulled Vite feature.
- `vitest.config.ts` — add `test-dom/**/*.{test,spec}.tsx` to `include` + the `@vitejs/plugin-react` plugin (JSX transform); keep `environment: "node"` as the default. Wire `tsconfig.testdom.json` into the `typecheck`/`lint` scripts (a third `tsc -p`).
- Deps: `@testing-library/react` + `@testing-library/dom` + `jsdom` (dev). Assert with plain vitest `expect` + Testing-Library queries (`getByRole`/`getByText`) — no `@testing-library/jest-dom` needed; `afterEach(cleanup)`.

A render test that mounts the extracted-verbatim shell (the §9.4 switcher) is worth more than the assertion in the commit message: it **proves** an "moved structure, not behavior" refactor claim instead of trusting it.

**Rule:** cover component behavior with a **second** jsdom test tier (`test-dom/` + `tsconfig.testdom.json` + per-file `@vitest-environment jsdom`), never by adding DOM to the node tier — and scope the DOM tsconfig's `include` to `test-dom` so `App.tsx`'s `import.meta.env` isn't dragged in (components are checked transitively).

---

## <a id="5"></a>5. Consume a node-heavy workspace package's inferred type surface via its BUILT `.d.ts` (surgical `paths`), never source — source drags node globals into the DOM program

**Date:** 2026-07-12.
**Source slice:** task 36 / brief `036-9-approuter-typing-renderer-client` (`4ee886d`).

The renderer's tRPC client was typed against tRPC's generic `AnyTRPCRouter` with 9 `client as any` casts, deferring end-to-end procedure typing. The obvious fix — `import type { AppRouter } from "@sow/worker"` — fails under the desktop DOM tsconfig: resolving `@sow/worker` (and, transitively, `@sow/db`) from SOURCE pulls node-typed source (`node:*`, `Buffer`) into the DOM program, where the node `Buffer` global collides with DOM's `BlobPart`. `skipLibCheck` does NOT help — it skips `.d.ts`, not source. `--explainFiles` pinpointed the exact source-pull: of {contracts, db, domain, policy} reachable from `AppRouter`, only `@sow/db` is node-heavy.

The fix is to consume the node-heavy packages' BUILT declarations, not their source:
- Flip `declaration: true` in each node-heavy package's `tsconfig.build.json` (`@sow/worker`, `@sow/db`) so `pnpm build` emits `dist/**/*.d.ts`.
- In the DOM tsconfig(s) — `tsconfig.web.json` **and** `tsconfig.testdom.json` (both DOM tiers pull the client) — add **surgical `paths`** redirecting ONLY the node-heavy specifiers to their built declarations: `@sow/worker` → `../worker/dist/api/server.d.ts` (the narrow file that exports `AppRouter` directly — `index.d.ts` re-drags the whole surface) and `@sow/db` → `../../packages/db/dist/index.d.ts`. Leave DOM-safe packages (contracts/domain/policy) on source. Reading a `.d.ts` under `skipLibCheck` never pulls the node globals the DOM lib conflicts with. `turbo typecheck` `dependsOn: ["^build"]` guarantees the dist declarations exist before the desktop typecheck; a bare local `tsc -p tsconfig.web.json` needs the upstream build first.
- The node tier (`tsconfig.node.json`) needs NO redirect — no DOM lib ⇒ no `BlobPart` conflict — but it resolves `@sow/worker` from source, so the package's `src/index.ts` must carry a type-only top-level `export type { AppRouter, ApiCaller }` (the runtime entry does `export * as apiServer from "./api/server"`, a namespace — no top-level `AppRouter` without the re-export; type-only, no runtime collision).

**Corollary — an inferred type surface may DELIBERATELY erase a non-nameable member to stay declaration-emittable; the consumer bridges it with a TYPED adapter, not `any`.** `composeAppRouter` mounts the subscription sub-router typed `AnyRouter` on purpose: its concrete procedure map isn't nameable across a `declaration: true` emit (TS2742; `apps/worker/src/api/stream/pushStream.ts:131-139`). So on the emitted `AppRouter`, `stream.onEvent` is erased while query/command/systemHealth type perfectly. The renderer reaches it via a typed, compile-checked adapter — `client.stream as unknown as { onEvent: StreamOnEventProc }`, `StreamOnEventProc` anchored to the `@sow/contracts` `StreamEvent` contract + still `safeParse`d at runtime — NOT `client as any`. Net: end-to-end typing with zero `as any`/`@ts-expect-error` in `renderer/lib`. (Extends Lesson §1's `sow-built`/structure-preserving-`dist` discipline to the TYPE-consumption direction.)

**Corollary — a typing refactor must NOT change runtime behavior.** Concrete router types make some runtime guards look TS-redundant (a field is "always" an array / non-null on the type), but downstream tests + server-regressions still pin those defenses — a desktop test caught a dropped `Array.isArray` fold during this slice. Restore every runtime guard the types make redundant (drilldown `Array.isArray`, copilot/approval null-guards, `applied === true` strict-boolean coercion); the types are a compile-time aid, not a runtime guarantee about what the server actually sent.

**Rule:** consume a node-heavy workspace package's inferred type surface via its BUILT `.d.ts` through surgical `paths` in the DOM tsconfig(s) — never source (source drags `Buffer` into the DOM program → `BlobPart` conflict; `skipLibCheck` skips `.d.ts`, not source); bridge any deliberately-erased (TS2742) member with a typed adapter, not `any`, and keep every runtime guard the concrete types make TS-redundant.

**Pin:** the repo-wide `pnpm -w turbo run typecheck` gate (the web + testdom tiers fail if the `paths` redirect regresses) + `grep -rn "client as any" apps/desktop/renderer` returns 0 (no renderer client casts remain).

---

## <a id="6"></a>6. Renderer command-callers fail closed uniformly, and mint a DETERMINISTIC idempotency key for replay-safe re-entry

**Date:** 2026-07-12.
**Source slices:** approval-decision (9.8) + triage-disposition (9.7, task 37, `d4f38cf`).

The renderer is UNTRUSTED — it only REQUESTS a mutation; the worker + pipeline own the effect (one-writer, exactly-once, any workspace binding). Two conventions now recur across every renderer command-caller (`createApprovalDecision`, `createTriageDisposition`):

1. **Fail closed uniformly.** A command-caller folds EVERY non-success path — a typed `err` Result, a transport throw, AND a malformed/leaky `ok` (a `.strict()` schema re-validation failure) — to a single `{ ok: false }`, and surfaces nothing. A failed command never shows a partial/stale/leaky result; the UI keeps the item + a non-blocking `role="alert"` affordance. Wrap the `.mutate(...)` in try/catch (transport throw → `{ ok: false }`), and re-validate any returned UI-safe record against its `.strict()` schema (defense-in-depth against a future server-projector regression — the type says it's UI-safe, but a leaky record is DROPPED, never folded into the store).

2. **Mint a DETERMINISTIC idempotency key** when the command re-enters an idempotent pipeline that REUSES the caller's key. `UiSafeIngestionItem` carries no key (raw refs are dropped at the UI-safe boundary) and the worker reuses the caller's key verbatim — so a replay / double-click must land the SAME key → one effect. Derive it purely from stable inputs: `triageIdempotencyKey(sourceId, disposition) = ` `${sourceId}:${disposition}`. NEVER a fresh per-click UUID (defeats dedupe); NEVER surface the key on the UI-safe contract (heavier + the caller-mints model is what the command expects).

**Caveat — the deterministic key dedupes the SAME (target, action), not DISTINCT actions on one target.** A fast Accept-then-Reject on one item mints two DISTINCT keys → two pipeline effects. Closing that (a per-card in-flight disable) is a shared UX-robustness follow-up across Approvals + triage; the same-button double-click is already deduped.

**Rule:** a renderer command-caller returns a typed `{ ok }` result, folds typed-err / transport-throw / malformed-ok all to `{ ok: false }` (surface nothing; keep the item + a `role="alert"` affordance), and — for an idempotent-re-entry command — mints a DETERMINISTIC idempotency key from stable inputs so a replay/double-click lands one effect.

**Pin:** each command-caller has unit tests asserting the ok / typed-err / transport-throw / malformed-ok folds + (for keyed commands) same-input-same-key / distinct-input-distinct-key; the key is a pure function of its inputs.

---

## <a id="7"></a>7. A roving listbox in a POPUP also owns the open/close focus loop — focus-on-open + return-focus-to-trigger + reset-on-open — and the return-focus guard must arm ONLY while open

**Date:** 2026-07-12.
**Source slice:** ScopeSwitcher popup keyboard loop (task 38, `1110024`). Extends the shared roving-listbox contract (the project-wide roving lesson, `packages/contracts/LESSONS.md#22`; desktop a11y lessons are currently split between that file and this one — reconcile the canonical home at a close-out).

The shared `useRovingListbox` owns the WITHIN-listbox roving-tabindex behavior. When that listbox is rendered inside a POPUP (a menu-button-opens-listbox, e.g. the workspace ScopeSwitcher), the popup ALSO owns a focus loop the roving hook does not:
- **focus-on-open** — opening moves focus into the listbox onto the active (selected) option (the user should not have to Tab onto it). Drive it from the hook via an OPTIONAL `open?: boolean` — on the false→true edge, reset the roving activeIndex to the selected entry + focus the active option; `undefined` ⇒ unchanged, so an always-visible consumer (Projects) is unaffected.
- **return-focus-to-trigger** — a KEYBOARD-driven close (Escape or a selection) returns focus to the trigger button; an outside-click or tab-away close does NOT (focus follows the user's action). Implement it component-local (the hook stays trigger-agnostic) — mirror an existing same-file precedent if one exists (here the Copilot-rail `returnFocusToRail`).
- **reset-on-open** — reopening starts the roving position at the selected option, not a stale prior arrow position (the hook's `open`-edge reset covers this).

**The load-bearing gotcha (a MED caught in review):** the component-local return-focus guard must be ARMED ONLY WHILE OPEN. If the close-key handler (Escape) fires on an always-mounted wrapper even while CLOSED, it arms the guard, the no-op `setOpen(false)` never re-runs the `useEffect([open])`, and the flag LEAKS into a LATER non-keyboard dismissal (outside-click / tab-away) — wrongly returning focus and violating the no-return invariant. Gate the flag-set on `open`.

**Additive-only:** existing security-reviewed dismissals (outside-click / Escape / tab-away) + ARIA semantics stay byte-unchanged — ADD focus management around them.

**Rule:** a roving listbox in a popup adds focus-on-open + return-focus-to-trigger (keyboard-close ONLY) + reset-on-open (via the hook's optional `open`); the component-local return-focus guard arms ONLY while open (else a closed key-press leaks into a later non-keyboard dismissal); keep the existing dismissals/ARIA byte-unchanged.

**Pin:** render tests for focus-on-open / return-focus-on-Escape+select / NO-return-on-outside-click+tab-away / reset-on-reopen / dismissals-still-work / escape-while-closed-doesn't-arm.

---

## <a id="8"></a>8. Renderer scope reflects the fail-closed WS-8 onboarded registry — no placeholder-id resurrection

**Date:** 2026-07-15.
**Source slice:** 14.1 onboarding surface / fail-closed WS-8 scope model (`ad624a16`).

The renderer's scope model derives its selectable scopes from the onboarded/registered workspace set — a workspace becomes selectable ONLY once it is onboarded/registered. Empty-until-onboarded is the fail-closed default: the scope store must never resurrect a removed placeholder id as if it were populated, so an un-onboarded or removed workspace surfaces nothing and a stale/placeholder id can never silently widen the selectable set (WS-8).

**Rule:** the renderer scope model derives selectable scopes from the onboarded/registered set (a workspace is selectable ONLY once onboarded/registered); the scope store never resurrects a removed placeholder id as if populated — fail-closed empty-until-onboarded.

---

## <a id="9"></a>9. `isWorkspaceScope` keys off a STABLE `isGlobal` flag, not a nullable id, so onboarding state can't relax the isolation gate

**Date:** 2026-07-15.
**Source slice:** 14.1 onboarding surface / fail-closed WS-8 scope model (`ad624a16`).

The workspace-scope predicate keys on a stable `isGlobal` boolean, not a nullable workspace id. A null/absent id must NOT read as "global/relaxed" — otherwise evolving onboarding state (a not-yet-onboarded workspace whose id is still null) could silently weaken the WS-8 isolation gate. Anchoring the predicate to an explicit `isGlobal` flag keeps the isolation decision independent of the mutable id.

**Rule:** the workspace-scope predicate keys on a stable `isGlobal` boolean, not a nullable workspace id — a null/absent id must not read as "global/relaxed", so evolving onboarding state can never weaken the WS-8 isolation gate.

---

## <a id="10"></a>10. A config surface treats `tokenRef` as an opaque NAMED reference — never a secret shown/echoed/retained (rule 7 at the renderer)

**Date:** 2026-07-15.
**Source slice:** 14.2 connectors surface (`7d141528`).

The connector-config surface forwards `tokenRef` as an opaque NAMED reference the user chooses — never a secret value. It is reconstructed from an allowlist on return, never round-trips / stores / renders as a value, and is cleared from the input after submit. This enforces safety rule 7 (secrets never reach the renderer, logs, or Markdown) at the renderer boundary.

**Rule:** a connector-config surface forwards `tokenRef` as an opaque named reference the user chooses; it is reconstructed from an allowlist on return, never round-trips/stores/renders as a value, and is cleared from the input post-submit (rule 7 at the renderer boundary).

---

## <a id="11"></a>11. Reuse an existing hydrated store slice for a read path — don't duplicate a read path

**Date:** 2026-07-15.
**Source slice:** 14.3 System Health panel (`7d141528`).

When a surface needs data that is already available, reuse the existing hydrated store slice rather than adding a second/duplicate read path. The System Health panel rendered the already-hydrated `state.health` from the live stream instead of opening its own fetch — one source of truth, no divergent read to drift.

**Rule:** when a surface needs already-available data, reuse the existing hydrated store slice (e.g. the System Health panel rendered the already-hydrated `state.health` from the live stream) rather than adding a second/duplicate read path.

---

## <a id="12"></a>12. The desktop rule-4 cross-workspace authorization surface: UI-safe-only render, deliberate per-link approve, registered-only selectors, deterministic collision-free anchor-id, no pre-approval smuggling

**Date:** 2026-07-15.
**Source slice:** Phase-14 14.7 — the desktop cross-workspace-links approval surface (mirrors worker Lesson 32 / safety rule 4).

A rule-4 cross-workspace-links approval surface renders ONLY the UI-safe link summary — never raw cross-workspace content, and it exposes no content-read path. Approve is a deliberate per-link owner action showing the full link (from→to, projectionType/visibilityLevel); both endpoints are sourced from the registered-workspace set with a client self-link block (WS-8 defense-in-depth). It mints a DETERMINISTIC collision-free anchor-id (`from~to~projType~visLevel`, percent-escaped delimiter ⇒ injective) so re-authorizing the same anchor is idempotent, while a scope change is transparently a NEW link needing its own approval (mirrors worker Lesson 32); and it sends only the whitelisted create fields — no `status`/`approvedAt` pre-approval smuggling.

**Rule:** a rule-4 cross-workspace-links approval surface renders ONLY the UI-safe link summary (never raw cross-workspace content — no content-read path); makes approve a deliberate per-link owner action showing the full (from→to, projectionType/visibilityLevel); sources both endpoints from the registered-workspace set with a client self-link block (WS-8 defense-in-depth); mints a DETERMINISTIC collision-free anchor-id (`from~to~projType~visLevel`, percent-escaped delimiter ⇒ injective; re-authorizing the same anchor is idempotent, a scope change is transparently a NEW link needing its own approval — mirrors worker Lesson 32); and sends only the whitelisted create fields (no `status`/`approvedAt` pre-approval smuggling).

---

## <a id="13"></a>13. App-managed local-process supervision — loopback-forced, env-gated OFF-default, injected spawner seam, AND persists to app-data (structural no-in-memory)

**Date:** 2026-07-15.
**Source slice:** Phase-14 14.4 + 14.4-durability — the app-managed local Temporal dev-server supervisor (mirroring `gbrain serve`).

A supervised local dev-server (the app-managed Temporal, mirroring the `gbrain serve` pattern) forces loopback via the CLI flags themselves (`--ip`/`--ui-ip`) rather than trusting a bind-residual default — an explicit flag is stronger than an implied default. It spawns with an args-ARRAY + `{ stdio: "ignore" }` and NO `shell` field at all, so `shell: true` is structurally impossible. It is env-gated on `SOW_MANAGE_TEMPORAL === "true"` (STRICT `=== "true"`, not a truthy-coerce — Lesson-31-style), so the shipped default is OFF and byte-equivalent. The real spawner is an INJECTED seam — the real spawn binds only at boot, so the whole test suite spawns NO real server — and disposal leaves no orphan (dispose-first + kill in BOTH the reap path and shutdown).

Crucially it PERSISTS to app-data: `--db-filename <userData>/temporal/dev.db` (mkdir-recursive via an injected fs seam; the path is userData-derived + safe, never `/tmp`/in-memory), so operational state survives a restart (LIFE-3). The no-in-memory regression is pinned STRUCTURALLY — a typed-REQUIRED `dbFilename` param makes a start-dev-without-it un-buildable — not merely tested against. The hard-line→substrate downgrade this represents (G62) is owner-ratified + recorded, never self-adjudicated.

**Rule:** an app-managed local dev-server (the supervised Temporal mirroring `gbrain serve`) forces loopback via the CLI flags (`--ip`/`--ui-ip`, better than a bind-residual default), spawns an args-array + `{stdio:"ignore"}` with no `shell` field (shell:true structurally impossible), is env-gated STRICT `SOW_MANAGE_TEMPORAL === "true"` (shipped default OFF + byte-equivalent), takes an INJECTED spawner seam (the whole suite spawns no real server), disposes with no orphan (dispose-first + kill in reap + shutdown), AND persists to app-data (`--db-filename <userData>/temporal/dev.db`, mkdir via an injected fs seam, userData-derived/safe, never /tmp/in-memory — LIFE-3) with the no-in-memory regression pinned STRUCTURALLY (a typed-REQUIRED `dbFilename` makes start-dev-without-it un-buildable); a hard-line→substrate downgrade (G62) is owner-ratified + recorded, never self-adjudicated.

## <a id="14"></a>14. An Electron-main→worker-host IPC config forwards ONLY plain-data arming opts (function deps stay worker-side, the OFF-lock across the fork); a mirrored-interface sync-pin must use the invariant type-IDENTITY form, not bare assignability

**Date:** 2026-07-20. **Source slice:** 18.32 — desktop subscription-arming + egress-allowlist forwarding.

When the app arms a worker capability across the `child_process.fork` IPC boundary, the config crosses via structured-clone — so FUNCTION-valued deps (`subscriptionArm.makeCompletion`/`checkReachable`, `providerTransport.make`) CANNOT cross. Forward ONLY the plain-data arming slice (`subscriptionArm {enabled, model?}`); let `bootWorker` supply the real completion default and keep the real reachability probe a worker-host-side injection — so an env-only arm degrades HEALTH-denied (`FAIL_CLOSED_REACHABILITY`): a clean OFF-lock across the fork boundary (env sets the opt-in but can't go live without the worker-side probe). Extract the env→config parse into a PURE electron-free module (§3 — no `electron`/`app` import may reach the node-tier test) and the `WorkerHostConfig`→`bootWorker` mapping into a small pure helper; forward every new field via conditional-spread (omit-when-unset, never `:undefined`) so the unset default is byte-identical. Keep the two mirrored `WorkerHostConfig` interfaces in sync with a type-level pin — but it MUST be the invariant type-IDENTITY form (`(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)`), NOT bare bidirectional assignability, which is BLIND to optional-field drift (and both mirrored fields are optional, so a bare pin passes on exactly the drift it guards — a vacuous green). `pin: worker-arming-env.test.ts (plain-data-only + strict "1"|"true" parse) · arming-forward.test.ts (conditional-spread byte-equiv) · the interface type-identity assertion`.

## <a id="15"></a>15. A native config `.env` loader hydrates ONLY a recognized allowlist — structural exclusion of the shadowing set + secrets; the ALLOWLIST is the gate (not the parser); empty-value=unset, existing-env-wins, warn-names-KEY-only

**Date:** 2026-07-20. **Source slice:** 18.34 — native allowlisted `.env` loading (kills the `dev.sh` blanket source).

Replacing a blanket `source .env` wrapper with native loading, make the loader hydrate ONLY an enumerated `SOW_*` config allowlist into `process.env` — never blanket. This makes the safety STRUCTURAL: the subscription-shadowing env set + all secrets (VOYAGE/OPENROUTER) are excluded BY CONSTRUCTION (none is a recognized config key), so a plaintext `.env` can never shadow the subscription, redirect egress, or auto-load a secret — without maintaining a denylist. Because the ALLOWLIST (not the parser) is the gate, a minimal in-repo parser is safe + auditable (don't add dotenv for simple `KEY=VALUE` config — a parse bug can't hydrate a non-allowlisted key). Defense-in-depth: skip+WARN every non-allowlist key, KEY-only never the value (rule 7 / §16), escalating the warning for a known shadowing key (inline the canonical set when a barrel-export would drag a node-heavy cross-layer import — §5; the inline copy is warning-specificity only, drift NEVER weakens the gate). Guardrails: missing `.env` ⇒ no-op (no throw); existing `process.env` WINS (a real shell/CI export beats a stale `.env`); an EMPTY value is UNSET (a blank `KEY=` line must not hydrate `""` and clobber a downstream `?? default` — a real `mkdirSync("")` boot-break vector); `Object.create(null)` for the parse map (a `__proto__=` line surfaces as a visible skip, never pollution). `pin: dotenv-allowlist.test.ts (allowlist-only + shadowing-never-hydrated + secrets-not-hydrated + empty=unset + existing-wins + warn-key-not-value)`.

## <a id="16"></a>16. A renderer-supplied PATH crossing the trusted preload bridge is STILL untrusted — main containment is ONE pure electron-free predicate (lexical `+sep` → realpath re-containment → isFile-for-open), never-throws, fail-closed with no disclosure; keep `shell`/electron OUT of the pure module

**Date:** 2026-07-24. **Source slice:** 9.12 — path-scoped open-in-vault via preload IPC.

A privileged main op that acts on a renderer-supplied path (open-in-Obsidian / reveal-in-vault) treats the path as UNTRUSTED even though it crossed the trusted preload bridge — the bridge authenticates the CHANNEL, not the path VALUE (the plan's "main REJECTS any open for a path outside the configured roots — no arbitrary path open"). Containment is ONE pure electron-free predicate `guardVaultPath(requestedPath, roots, realpath)`: reject NUL / empty / non-string / malformed BEFORE any fs seam (assert the realpath+stat spies UNCALLED — proves fail-closed-before-fs) → lexically `resolve` and require `full === root || full.startsWith(root + sep)` over the configured roots (the `+ sep` kills the sibling-prefix escape `/vault-evil` vs root `/vault` — mirror `main/app-protocol.ts resolveAppRequest`) → realpath BOTH the target AND the matched root and RE-CHECK containment on the REAL paths (closes a symlink escaping the root — the layer `resolveAppRequest` lacks; mirror worker `copilotVaultRead` / L17) → for `open` require `isFile` (reveal is containment-only; a contained dir / repo-root is fine for `showItemInFolder`). Dispatch `shell.openPath` on the REALPATH-resolved absPath, not the requested path — this NARROWS the check→act TOCTOU (realpath at check-time still leaves a window; narrowed, not fully closed, absent an OS fd handoff). Fail-closed to a typed reject with NO fs side effect and NO disclosure of WHY (rule 7 / §16), NEVER throws (a seam throw → a typed `fs_fault`). Keep `import { shell } from "electron"` OUT of the pure module so it compiles + unit-tests under the DOM-less node tsconfig (L3) with injected realpath/stat/shell seams — the electron-coupled `ipcMain.handle` registration is verified by `/wired` + typecheck, not a unit test. New preload channel names must dodge the inventory forbidden-regex (`fs|file|shell|exec|secret|…`) — `vault:open`/`vault:reveal` are clean. The desktop analog of worker L5 (traversal-safe-by-construction) / L17 (realpath-before-open, one authoritative predicate). Multi-root follow-up: re-check the realpath'd target against ALL realpath'd roots, not just the lexically-matched one. `pin: open-in-vault.test.ts (outside-roots + traversal-escape + symlink-escape + sibling-prefix + NUL/malformed + non-file-for-open + never-throws-on-seam-fault + reject-makes-zero-shell-calls + open-invokes-openPath-with-realpath)`.

## <a id="17"></a>17. Electron MAIN must BUNDLE the pure `@sow/*` it imports at runtime (exclude from externalizeDepsPlugin) — a runtime `@sow/*` import left externalized-without-`sow-built` resolves to raw `.ts` → load crash; deep-import to dodge the barrel's heavy graph

**Date:** 2026-07-24. **Source slice:** 9.18 — ⚡ ./dev.sh startup-bug fix.

`@sow/*` workspace packages use a `sow-built` export condition (`sow-built → dist/*.js`, `default → src/*.ts`). The worker-host CHILD runs `--conditions=sow-built` so it resolves to built JS; **Electron MAIN's Node runtime does NOT activate `sow-built`**, so an externalized `@sow/*` resolves via `default` → raw `src/*.ts` → `require()` of TS → `SyntaxError: Unexpected token 'export'` at load (the app won't launch). REGRESSION CLASS: 9.12 added the first RUNTIME (non-type) `@sow/contracts` import into `main/open-in-vault.ts` and it silently broke launch — the run-path was green before ONLY because no main file imported `@sow/*` at runtime (preload's are type-only, erased). FIX: exclude the pure `@sow/*` from `externalizeDepsPlugin()` in the `main` build so Vite BUNDLES + transpiles the TS at build time (no runtime `.ts` require); keep `@sow/worker` + native modules EXTERNAL (main spawns the worker-host child, never imports @sow/worker directly). PREFER a DEEP subpath import (`@sow/contracts/primitives/result`) so the barrel's zod/ajv graph isn't dragged into main (bundle 390K→16.5K). Do NOT change the shared `@sow/contracts` package.json `default`→`dist` (breaks the source-based vitest/tsc flows). GUARD it with a build-artifact assertion (the built `out/main` has no runtime `@sow/*`/`.ts` require + no zod/ajv drag; RED when the exclude is removed) — an Electron full-launch test isn't CI-feasible. Same class applies at PACKAGING (prod build must resolve `@sow/*` to JS too). Extends L1/L2 (build/spawn packaging). `pin: bundle/main-bundle-resolution.test.ts (real electron-vite build; no .ts require / no zod-ajv drag; RED-on-exclude-removed)`.

## <a id="18"></a>18. An authoritative DURABLE lifecycle marker owned by main — pure injected-fs read/write → userData, surfaced via a narrow inventory-cleared preload channel, gating ONLY a UX mount decision, NEVER the WS-8 predicate; additive-authority not a hard lock; write-once backfill for existing installs

**Date:** 2026-07-24. **Source slice:** 9.17 — desktop first-run gating.

A renderer-only first-run gate (`!hasAnyOnboardedWorkspace(state)`) spuriously re-shows onboarding on a transient empty registry (worker unreachable at boot). Fix with an AUTHORITATIVE DURABLE marker owned by main: a pure electron-free `first-run.ts` read/write over an INJECTED fs seam persisted to `userData` (mirror L13's app-data persistence + L16's pure-module), surfaced via TWO inventory-cleared preload channels (`lifecycle:firstRunStatus`/`markOnboarded`; the write channel takes NO renderer args — fixed body + main-owned path, no traversal). The renderer gate CONSULTS it: complete ⇒ SUPPRESS onboarding (even on an empty registry — the fix), absent/fault ⇒ FALL BACK to the registry-derived gate (no regression) — ADDITIVE authority, never a new hard lock. ⚠ The marker gates ONLY the onboarding MOUNT decision — it must NEVER feed the WS-8 `isWorkspaceScope`/`isGlobal` predicate (isolation stays registry-derived, L9). A confirmed `createWorkspace` marks it; a WRITE-ONCE fire-once backfill (`shouldBackfillMarker` — true iff `registryHasOnboarded && marker RESOLVED-to-not-complete`; PENDING⇒don't-fire-premature, FAULT⇒fire since the WS-8 registry is authoritative onboarding evidence + the write is idempotent) sets the marker for EXISTING installs predating the feature. Residual: the very first post-upgrade boot with worker down shows onboarding once (protected thereafter). Pure DI'd gate logic in its own module (L3), tested under the node tsconfig; the App.tsx effect wiring is `/wired`+typecheck. `pin: first-run.test.ts + first-run-gate.test.ts (marker absent/present/fault decision table + backfill + gate_never_relaxes_ws8_isolation) + preload-inventory.snapshot.test.ts`.

## <a id="19"></a>19. A deterministic, MODEL-FREE Today daily-brief assembled from UI-safe store counts — rendered as a dumb prop, distinct from the on-request model-synthesized Copilot briefing; renders only counts (rule 5)

**Date:** 2026-07-24. **Source slice:** 9.20 — Today-live daily-brief + honest-empty schedule.

The Today "Daily brief" + "Today's schedule" were HARDCODED placeholder strings (read no read-model). The RICH brief is the model-synthesized Copilot briefing (`query.copilotBriefing` — needs a model; Phase-24.x) — NOT usable in a zero-model demo. So render a DETERMINISTIC brief from already-UI-safe store COUNTS: a pure, window-free `buildDailyBrief({recentChanges, ingestion, approvals})` (L3) composes a headline (the most-actionable non-zero, approvals>triage>recent) + a zero-dropped chip line (`meta`) + honest singular/plural wording; all-zero ⇒ an honest "all caught up", never a mockup. Return `{summary, meta, stats}` so BOTH the headline AND the chip line are deterministic + node-tested (Today stays a DUMB render of the `brief` prop; App.tsx computes it from `state.recentChanges.length`/`state.ingestion.length`/`pendingApprovalCount`). Renders ONLY counts/UI-safe summaries — no raw-content field can leak (rule 5). ⚠ Do NOT source a "blockers/open issues" stat from System Health (it conflates infra health with work items AND duplicates the System Health section right below — the demo would show the same issues twice); a work-blocker stat sources from PROJECT blockers. The brief's approval count is the intentionally-GLOBAL approval inbox (not scope-cleared) — UI-safe counts, ratified, not a WS-8 leak. The schedule renders an HONEST empty state ("No calendar connected") — no fabricated rows — until 9.9 Calendar. `pin: daily-brief.test.ts (seeded-counts + singular/plural + all-zero-honest + pure-ui-safe) + today-brief.test.tsx (brief-prop-rendered + schedule-honest-empty)`.

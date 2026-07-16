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

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

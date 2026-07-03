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

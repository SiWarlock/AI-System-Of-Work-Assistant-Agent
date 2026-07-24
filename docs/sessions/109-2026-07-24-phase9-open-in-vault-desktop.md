# Session 109 — Phase-9 open-in-vault (desktop), path-scoped preload/main integration

- **Date:** 2026-07-24
- **Phase:** 9 (desktop UI completion — the "make the daily briefing real" arc)
- **Track / role:** `main` / desktop-implementer
- **Predecessor:** [107 — OSB-parity amendment integration](107-2026-07-24-osb-parity-amendment-integration-orch.md) (last committed session doc)
- **Concurrent sibling (same round):** 108 — worker recent-changes audit-projection producer (task 9.5/#8, worker track), landing in parallel
- **Successor:** _TBD (next round)_
- **Task:** 9.12 — Obsidian first-class open/reveal integration via preload (path-scoped)
- **Commit:** `80d387c6` (slice) — this doc lands under a separate `docs(sessions)` commit
- **Brief:** `docs/briefs/156-9.12-open-in-vault-path-scoped.md` (spec-lint PASS `@9245bfca`)

## Why this session existed

The Phase-9 "make the daily briefing real" arc kicked off (following the §ARM-18 auto-ingest ENABLE crossing sealed live, `30ef70e0`, which now produces real KnowledgeWriter notes). The worker-side read-model producers are the load-bearing "real data appears" work (worker #8, concurrent). 9.12 is the self-contained, **zero-data-dependency** desktop parallel-start slice: open-in-Obsidian / reveal-in-vault, wired end-to-end but path-scoped so an untrusted renderer-supplied path can never open an arbitrary file. It was previously absent (`main/open-in-vault.ts` + the path-scoped preload channel did not exist — L381 leg g, blocker for the Phase-9 exit gate).

## What was built

### Files created
- `apps/desktop/main/open-in-vault.ts` — the load-bearing **pure, electron-free** `guardVaultPath(requestedPath, roots, op, deps)` + `performVaultAction(op, path, roots, deps)`. Three-layer containment (lexical `resolve`+`startsWith(root+sep)` → realpath re-containment of **both** target and matched root → `isFile` for `open` only), typed `Result<{absPath},VaultReject>`, never-throws (§16), fail-closed with no disclosure. `shell` is **injected** (not imported) so the module compiles + unit-tests under the DOM-less node tsconfig (desktop LESSON 2/3). `performVaultAction` acts on the **realpath** (not the requested path) — narrows the TOCTOU window — and maps `shell.openPath`'s error string to a bare `{ok:false}` (rule 7, no disclosure).
- `apps/desktop/main/vault-roots.ts` — a tiny **main-only, set-once** holder (`setVaultRoots`/`getVaultRoots`) mirroring `main/worker-holder.ts`, so the IPC handler reads the roots lazily at invoke-time (dodges registration-order / import-cycle fragility). Never exposed via preload; not a runtime reconfig surface.
- `apps/desktop/test/main/open-in-vault.test.ts` — 15 unit tests (node tier): 10 for `guardVaultPath` (happy path, outside-roots, `..` traversal, symlink escape, sibling-prefix, NUL/malformed with fs-seams-uncalled, non-file-for-open + reveal-allows-dir, never-throws-on-seam-fault, multi-root, empty-roots) + 5 for `performVaultAction` (zero-shell-on-reject, opens-realpath-not-requested, reveal→show-in-folder, error-string-not-disclosed, never-throws-on-shell-throw).

### Files modified
- `apps/desktop/preload/bridge.ts` — added the `vault` namespace to `SowBridge` (`open`/`reveal`) + `buildSowBridge` (`invoke("vault:open"/"vault:reveal", path)`) + appended the 2 channels to `PRELOAD_CHANNELS`. Channel strings clear the inventory forbidden-regex (`/db|sql|drizzle|fs|file|secret|keychain|connector|exec|shell/i`) and the `/token/i` assertion.
- `apps/desktop/preload/inventory.json` — added `"vault:open"`, `"vault:reveal"` (the desktop security-pinned snapshot artifact; updated in-slice, rides the slice commit with its snapshot test — NOT orchestrator territory).
- `apps/desktop/main/ipc.ts` — registered exactly one `ipcMain.handle` per new channel, binding the real `shell` + `node:fs` (`realpath`/`stat`) seams into `performVaultAction`; roots read lazily via `getVaultRoots()`.
- `apps/desktop/main/index.ts` — `setVaultRoots([vaultRoot])` once at boot (inside `startWorker`, after the existing `vaultRoot` resolve + `mkdirSync`).

## Decisions made
- **Roots source = (A) minimal:** `roots = [vaultRoot]` (the single `SOW_VAULT_ROOT`; the Global/Coordination repo is a subdir under it). `guardVaultPath` is **roots-agnostic** (`roots: readonly string[]`) so the source decision never touches the TDD core — the (B) multi-root parser is a pure wiring follow-up. (Orchestrator-confirmed.)
- **Separate `vault:open` + `vault:reveal` channels** (one → `shell.openPath`, one → `shell.showItemInFolder`; each an explicit inventory entry) over a single moded channel.
- **One cohesive slice** (guard + preload + main + inventory) — the guard carries the safety pin; no wiring churn threatened it, so a single commit was appropriate (brief estimate 1–2).
- **`reveal` does not require `isFile`** (only `open` does) — show-in-folder legitimately targets a directory / repo root; reveal still runs the full lexical + realpath containment.
- **Realpath BOTH the target and the matched root** — so a symlinked ancestor (e.g. macOS `/Users`) can't false-reject a legitimate path, while a symlink escape can't false-accept.
- **Added a `vault-roots.ts` holder** (beyond the brief's file list; flagged + approved at Step 2.5) — mirrors the existing `worker-holder.ts` pattern for the "computed in startWorker, read by an earlier-registered handler" shape.

## Decisions explicitly NOT made (deferred)
- **Multi-root `SOW_VAULT_ROOT_PATHS` desktop parser** — deferred; when it lands, re-check `realTarget` containment against **all** realpath'd roots, not just the lexical match (both reviewers flagged; fail-closed today under a single root).
- **Renderer consuming button / affordance** — which UI element supplies the note path from a UI-safe projection; deferred per the brief's Done-when scope ("the path-scoped preload channel + main handler land").
- **Defense-in-depth empty/whitespace-root drop in the guard** — security low #1; unreachable today (`mkdirSync` crashes boot on `""` before `setVaultRoots`); natural home is the multi-root parser.

## TDD compliance
**CLEAN.** All 15 tests were written first (Step 2), RED confirmed for the right reason (module `../../main/open-in-vault` not-found), Step-2.5 test-design review APPROVED by the orchestrator before GREEN, then minimum implementation to pass. No test written after implementation; no TDD violation. The electron-coupled wiring (`ipc.ts` handler registration + `index.ts` boot call) is verified by typecheck + reachability (not unit-tested — electron can't load under the DOM-less node test tsconfig; documented pattern per LESSON 2/3).

## Cross-doc invariant audit
**CLEAN — no model field change this session.** `vaultRootPaths` already exists (`packages/contracts/src/config/config-schema.ts:47`); no new/changed contract model, no Appendix-A edit, no schema-snapshot bump. Flagged "no cross-doc invariant change" at Step 9; orchestrator confirmed. (The ARCHITECTURE §11 open-in-vault posture note the orchestrator is hot-routing is a documentary note, not a model field change.)

## Reachability
- **`vault:open` / `vault:reveal`** — reachable from the production entry: `app.whenReady()` → `registerIpcHandlers()` (`main/index.ts:180`) → `ipcMain.handle("vault:open"/"vault:reveal")` (`main/ipc.ts`) → `performVaultAction` → `guardVaultPath` → `shell.openPath`/`shell.showItemInFolder`. Exposed to the renderer as `window.sow.vault.open/reveal` (`preload/index.ts` binds `ipcRenderer.invoke` into `buildSowBridge`).
- **Tested-but-unwired gap:** no renderer UI element yet CALLS `window.sow.vault.open/reveal` — the channel accepts a path and is `/wired`-reachable from the bridge, but the consuming button is a Future TODO (belongs to the Today-live / note-surface slice, which supplies the note path from a UI-safe projection). Per the brief's Done-when scope, this is expected, not a silent gap.

## Open follow-ups
Step-9 categorized items (routed hot by the orchestrator this round — L16 desktop lesson + ARCHITECTURE §11 note + Residuals(9)):
- **Convention candidate (→ desktop LESSON, orchestrator-routed):** a renderer-supplied path crossing the trusted preload bridge is STILL untrusted → main containment = one pure electron-free predicate (lexical `+sep` + realpath re-containment + `isFile`), never-throws, fail-closed with no disclosure; keep `shell` OUT of the pure module so it compiles/tests under the DOM-less node tsconfig — the desktop analog of worker L5/L17/copilotVaultRead.
- **Architecture-doc note (orchestrator-routed):** the open-in-vault path-scoping posture (main opens only realpath-contained vault paths; renderer never enumerates the fs) — §11 / REQ-UX-003.
- **Future TODO — belongs to a phase (→ Residuals(9)):** (a) multi-root `SOW_VAULT_ROOT_PATHS` desktop parser + re-check `realTarget` against ALL realpath'd roots; (b) renderer consuming button/affordance; (c) defense-in-depth empty/whitespace-root drop.

Reviewers (Step 8): **security 0 critical / 0 high / 0 medium / 4 low — no Finding to escalate; guard SOUND, no renderer-controllable bypass, all 7 project invariants PASS. code-quality 0 high / 0 medium / 3 low.** All residuals deferrable (the low residuals map to the three Future-TODOs above + the TOCTOU comment accuracy, which was fixed in-slice).

## How to use what was built
From the renderer, once a consuming affordance is wired: `await window.sow.vault.open("<absolute vault path>")` opens the note in its default editor (Obsidian); `window.sow.vault.reveal(path)` shows it in Finder. Both return `{ ok: boolean }` — `ok:false` on any rejection (outside roots / traversal / symlink escape / malformed / non-file-for-open / fs or shell fault), with no reason disclosed. Paths must be absolute and inside the configured vault root; the renderer never enumerates the filesystem.

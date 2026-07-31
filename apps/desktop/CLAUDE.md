<!--
  TEMPLATE: area CLAUDE.md → write to <code-area>/CLAUDE.md (e.g. app/CLAUDE.md).
  One per code area. For a multi-area project, generate one per area, each with
  its own stack + launch-protocol row. Keep the launch protocol, session
  start/end protocol, cross-doc-invariants discipline, layer rule, and
  lessons-index meta-rules VERBATIM — those are workflow machinery. Fill the
  stack + commands; leave the lookup table, forbidden patterns, cross-doc table,
  and lessons index near-empty (1-2 illustrative rows + a "populate as you go"
  note). Delete this comment.
-->

# System of Work Assistant `apps/desktop/` — Build Guide

> **You're in `apps/desktop/`.** This file plus root `CLAUDE.md` both load. The root file covers global project conventions + shared comm rules (track-prefix, escalation taxonomy, messaging budget); this file owns code-area conventions for Electron desktop UI.

## Launch protocol

| Working on... | cwd | Loads |
|---|---|---|
| Planning / docs / commits | repo root (`SoW-build/`) | root `CLAUDE.md` only |
| Electron desktop UI code | `apps/desktop/` | this `CLAUDE.md` + root |

<!-- For a multi-area project, add a row per additional code area. -->

If you find yourself fighting the wrong conventions, check your cwd.

## Session start/end protocol

**At session start:**
1. Read `IMPLEMENTATION_PLAN.md` (repo root) **by section, not whole** — `grep -n "^##" IMPLEMENTATION_PLAN.md` for offsets, then Read with offset/limit just "Currently in progress" + the active phase. (The file grows; never load it whole.)
2. Confirm with the user what feature this session is targeting.
3. Read the relevant section of `ARCHITECTURE.md` from the lookup table below.

**At session end** (only when the user explicitly says we're done):

1. **Implementer runs `/session-end`.** Implementer writes ONLY:
   - `apps/desktop/` code files (the slice's implementation)
   - test files (the slice's tests)
   - dependency manifest / lockfile (deps the slice adds)
   - `docs/sessions/<NNN>-<date>-<topic>.md` (session doc, created at `/session-end` Step 5)

   **Implementer must NOT touch (all orchestrator territory).** *This list is the canonical statement
   of the territory rule — `/session-end`, the brief template, and the generated
   `scripts/guards/territory-guard.sh` PreToolUse hook (which mechanically enforces it in team mode)
   all point here.*
   - `IMPLEMENTATION_PLAN.md`
   - `apps/desktop/LESSONS.md`
   - `apps/desktop/CLAUDE.md` (entire file — both the Cross-doc invariants table AND the Lessons logged index)
   - `ARCHITECTURE.md`
   - `docs/orchestrator-briefing.md` / `docs/tdd-brief-template.md` / `docs/briefs/` / `docs/runbooks/`
   - other top-level deliverable / design docs
   - `.gitignore` and root-level dotfiles (unless adding a new artifact to ignore, flagged at Step 9)

   At Step 10: **explicit `git add <path>` per slice file; never `git add -A`/`.`; never stage an orchestrator-territory file.** Changes to any orchestrator-territory file (a new cross-doc model, a lesson, an arch note) are **flagged at Step 9**, not edited here — the orchestrator writes them hot (root `CLAUDE.md` + the Step-9 matrix).

2. **Orchestrator runs `/orchestrate-end`** for round close-out + Carry-forward triage + round terminal commit + push.

## Lookup table — where to find canonical info

Don't paste these sections into the prompt. Grep the file:section, read only what you need. `/check-arch <topic>` dispatches off this table.

| Topic | File (relative to repo root) | Section |
|---|---|---|
| <subsystem A> | `ARCHITECTURE.md` | §X |
| <subsystem B> | `ARCHITECTURE.md` | §Y |
| Lessons logged (full prose) | `apps/desktop/LESSONS.md` | by lesson # |

<!-- Starts near-empty. Add a row whenever a topic is looked up twice. -->

**Code intelligence & docs (when available):** prefer a code-intelligence MCP / docs MCP over grep+read loops — see root `CLAUDE.md` "Code intelligence & docs."

## Stack

<!-- ▼ EXAMPLE BLOCK [id=area-stack]: stack quick-reference for implementer sessions. Canonical stack lives in root CLAUDE.md + ARCHITECTURE.md; this is the cheat sheet. ▼ -->
- **Runtime:** Node 22 LTS + TypeScript 5.x (strict)
- **Stack:** Electron (main/preload/renderer) · React + Vite · tRPC client
- **Validation:** Zod + JSON Schema (ajv)
- **Lint / types / tests:** ESLint / tsc --noEmit / Vitest
- **Territory (this track owns):** `apps/desktop/`
<!-- ▲ END EXAMPLE BLOCK [id=area-stack] ▲ -->

## Standard commands

```bash
# Install deps (run once; re-run when the manifest changes)
pnpm install

# Run the dev server (if applicable)
pnpm --filter <pkg> dev   # e.g. desktop / worker

# Tests
pnpm test

# Quality
pnpm lint
pnpm format:check
pnpm typecheck

# Preflight (use before saying "done" with a feature)
pnpm lint && pnpm typecheck && pnpm test
```

## TDD protocol

**Write the failing test first.** Applies to deterministic code — see the TDD posture in root `CLAUDE.md` for what is test-first vs. exempt.

**Commit per slice when practical.** Never bundle a safety-critical slice with anything else.

## Forbidden patterns

<!-- ▼ EXAMPLE BLOCK [id=forbidden-patterns]: forbidden patterns — 3-5 narrow, enforceable, domain-specific rules. Shape: "Don't <pattern X> because <reason / past incident>; use <alternative Y>." Test-pin them where possible. Starts small; accretes as lessons surface. ▼ -->
Do not:

1. **Write code without a failing test first** (deterministic code; UI behaviour via component/e2e tests).
2. **Enable Node integration in the renderer or disable contextIsolation** — the renderer is unprivileged; privileged ops go through the narrow preload bridge or the worker API.
3. **Give the renderer direct DB / filesystem / secrets / connector access** — it receives UI-safe projections only.
4. **Call the loopback worker API without the per-launch session token + Origin/Host allowlist** — loopback binding is NOT authentication.
5. **Render secrets, Keychain references, raw Employer-Work content, provider prompts, or AgentResult.logs into the UI** — only sanitized, policy-filtered projections; global surfaces use GCL sanitized grouped results.
<!-- ▲ END EXAMPLE BLOCK [id=forbidden-patterns] ▲ -->

## Cross-doc invariants — schema/docs mirroring

Several typed models in this codebase are **contracts** mirrored in `ARCHITECTURE.md` and indexed in the table below. The architecture doc is the canonical contract; the model is the executable enforcement. Drift produces silent disagreement.

**Authoring discipline (orchestrator owns this table).** The implementer never edits this table or `ARCHITECTURE.md` directly — it flags a field add/remove/rename at Step 9 as a `Cross-doc invariant change`; the orchestrator writes the row + the arch edit hot the same round (see root `CLAUDE.md` + `docs/orchestrator-briefing.md`). Commits stagger; the working tree stays aligned within the round.

| Model | `ARCHITECTURE.md` section | Notes |
|---|---|---|
| <model> | §X | <field summary> |

<!-- Starts empty (or with the first model if one exists). Populated as contract models land. -->

## Module organization

<!-- ▼ EXAMPLE BLOCK [id=module-layout]: module layout + layer dependency rule. Replace with the project's real directory tree and import-direction DAG. ▼ -->
```
apps/desktop/
  main/       windows · lifecycle · secrets broker · worker supervision · session-token mint
  preload/    narrow typed IPC bridge (privileged ops only)
  renderer/   React UI: the 9 surfaces · tRPC client · workspace-preset onboarding
```

Layer dependency direction: `renderer → preload → main`; renderer imports only UI-safe client contracts from `packages/contracts`, never worker internals.
<!-- ▲ END EXAMPLE BLOCK [id=module-layout] ▲ -->

## Subagents

See `.claude/agents/README.md` for the canonical inventory + integration points.

<!-- ▼ EXAMPLE BLOCK [id=area-subagent-candidates]: area-specific subagent candidates — list candidates that would earn their keep specifically in this area (e.g. an ABI/types syncer for a frontend area, a Pyth/feed verifier for a contracts area). Build only on real friction. ▼ -->

<!-- ▲ END EXAMPLE BLOCK [id=area-subagent-candidates] ▲ -->

## Lessons logged from prior sessions

The full prose for each lesson lives in `apps/desktop/LESSONS.md`. This index is the compact orientation surface.

⭐ **NOT THE WHOLE SET — the PROJECT-WIDE ledger is `packages/contracts/LESSONS.md`** (index: `packages/contracts/CLAUDE.md`), designated by root `CLAUDE.md`; cross-area rules are banked there, never here. ⛔ **Until 2026-07-31 this file pointed only DOWN at its own ledger and nothing pointed back UP** — so an implementer orienting off this doc (what the launch protocol tells you to load) had no path to the project-wide ledger at all. **Read both.**
⚠ **CITATION CONVENTION (adopted 2026-07-31): a bare `LNN` means THIS area's ledger; a cross-area citation CARRIES the ledger name — `contracts L39`, never bare `L39`.** Load-bearing because **every area ledger starts at §1**: `L39` names two different lessons and `L3` names four. *A dangling citation gets investigated; an ambiguous one gets believed.*

**Lesson numbers are stable IDs** — once assigned, they don't change. New lessons get the next sequential number. `/session-end` proposes additions when it detects them; the user approves before the entry is written and a row is added here.

Lessons start at §1.

| # | Date | Topic | Rule (one-liner) |
|--:|---|---|---|
| [1](LESSONS.md#1) | 2026-07-03 | Build source-TS pkgs structure-preserving for a spawned child | A package that reads data files via `import.meta.url` must build structure-preserving (tsc, `dist` mirrors `src`) behind a `sow-built` export condition + a child-only extension-appending ESM resolve-loader — never bundle it (bundling breaks the `../../schemas` relative resolve + CJS kills `import.meta.url`). |
| [2](LESSONS.md#2) | 2026-07-03 | Electron `fork` uses the Electron binary → native-ABI mismatch | In Electron, `child_process.fork` a Node child with `execPath` = system node (not the default Electron binary) so native-module ABIs match the dev/test toolchain; move to `utilityProcess` + `@electron/rebuild` only at packaging. |
| [3](LESSONS.md#3) | 2026-07-03 | `test/` compiles under the DOM-less node tsconfig | Renderer logic you want to unit-test must not transitively reference `window`/DOM (the `test/` dir compiles under `tsconfig.node.json`, no DOM lib); extract `window`-free, dependency-injected logic into its own module and import THAT from the test, leaving `window`-coupled glue imported only from `renderer/`. |
| [4](LESSONS.md#4) | 2026-07-04 | JSX-render tests are a SECOND tier, never a loosened node tier | Cover component behavior with a parallel jsdom tier (`test-dom/*.test.tsx` + `// @vitest-environment jsdom` docblock + `tsconfig.testdom.json` with DOM lib/jsx) — never by adding DOM to `tsconfig.node.json`/the default env (that drops the §3 DOM-less guarantee). Scope the DOM tsconfig `include` to `test-dom` so `App.tsx`'s `import.meta.env` isn't dragged in (components are checked transitively). |
| [5](LESSONS.md#5) | 2026-07-12 | Consume a node-heavy pkg's inferred type surface via its BUILT `.d.ts` (surgical `paths`), never source | To type the renderer against `@sow/worker`'s `AppRouter`: emit `.d.ts` (`declaration:true`) for the node-heavy pkgs (`@sow/worker`,`@sow/db`) + surgical `paths` in the DOM tsconfig(s) redirecting ONLY those to `dist/*.d.ts` — source drags node `Buffer` into the DOM program (`BlobPart` conflict; `skipLibCheck` skips `.d.ts`, not source). Node tier stays on source (add a type-only top-level re-export). Bridge a deliberately-erased (TS2742) member — e.g. the `AnyRouter` subscription sub-router — with a typed adapter, not `any`; keep the runtime guards the concrete types make TS-redundant. Extends §1. |
| [6](LESSONS.md#6) | 2026-07-12 | Renderer command-callers fail closed uniformly + mint a deterministic idempotency key | A renderer command-caller (`createApprovalDecision`/`createTriageDisposition`) folds typed-err / transport-throw / malformed-ok ALL to `{ok:false}` (surface nothing; keep the item + a `role="alert"` affordance; re-validate any returned UI-safe record against its `.strict()` schema). For an idempotent-re-entry command it mints a DETERMINISTIC key from stable inputs (`${sourceId}:${disposition}`) so replay/double-click = one effect — never a fresh UUID, never surface the key on the UI-safe contract. (Caveat: dedupes SAME action, not distinct actions on one target — a shared in-flight-disable is the follow-up.) |
| [7](LESSONS.md#7) | 2026-07-12 | A roving listbox in a POPUP owns the open/close focus loop; the return-focus guard arms ONLY while open | Popup-hosted roving listbox (e.g. ScopeSwitcher) adds focus-on-open + return-focus-to-trigger (keyboard-close ONLY — not outside-click/tab-away) + reset-on-open, via the shared hook's optional `open` signal (`undefined` ⇒ Projects unaffected); the component-local return-focus guard must arm ONLY while open, else a closed-Escape leaks the flag into a later non-keyboard dismissal (a MED). Additive over the security-reviewed dismissals/ARIA. Extends the roving contract (`contracts/LESSONS.md#22`). |
| [8](LESSONS.md#8) | 2026-07-15 | Renderer scope reflects the fail-closed WS-8 onboarded registry — no placeholder-id resurrection | The renderer scope model derives selectable scopes from the onboarded/registered set (a workspace is selectable ONLY once onboarded/registered); the scope store never resurrects a removed placeholder id as if populated — fail-closed empty-until-onboarded (WS-8). |
| [9](LESSONS.md#9) | 2026-07-15 | `isWorkspaceScope` keys off a STABLE `isGlobal` flag, not a nullable id, so onboarding state can't relax the isolation gate | The workspace-scope predicate keys on a stable `isGlobal` boolean, not a nullable workspace id — a null/absent id must not read as "global/relaxed", so evolving onboarding state can never weaken the WS-8 isolation gate. |
| [10](LESSONS.md#10) | 2026-07-15 | A config surface treats `tokenRef` as an opaque NAMED reference — never a secret shown/echoed/retained (rule 7 at the renderer) | A connector-config surface forwards `tokenRef` as an opaque named reference the user chooses; it is reconstructed from an allowlist on return, never round-trips/stores/renders as a value, and is cleared from the input post-submit (rule 7 at the renderer boundary). |
| [11](LESSONS.md#11) | 2026-07-15 | Reuse an existing hydrated store slice for a read path — don't duplicate a read path | When a surface needs already-available data, reuse the existing hydrated store slice (e.g. the System Health panel rendered the already-hydrated `state.health` from the live stream) rather than adding a second/duplicate read path. |
| [12](LESSONS.md#12) | 2026-07-15 | The desktop rule-4 cross-workspace authorization surface: UI-safe-only render, deliberate per-link approve, registered-only selectors, deterministic collision-free anchor-id, no pre-approval smuggling | A rule-4 cross-workspace-links approval surface renders ONLY the UI-safe link summary (never raw cross-workspace content — no content-read path); makes approve a deliberate per-link owner action showing the full (from→to, projectionType/visibilityLevel); sources both endpoints from the registered-workspace set with a client self-link block (WS-8 defense-in-depth); mints a DETERMINISTIC collision-free anchor-id (`from~to~projType~visLevel`, percent-escaped delimiter ⇒ injective; re-authorizing the same anchor is idempotent, a scope change is transparently a NEW link needing its own approval — mirrors worker Lesson 32); and sends only the whitelisted create fields (no `status`/`approvedAt` pre-approval smuggling). |
| [13](LESSONS.md#13) | 2026-07-15 | App-managed local-process supervision — loopback-forced, env-gated OFF-default, injected spawner seam, persists to app-data | An app-managed local dev-server (the supervised Temporal mirroring `gbrain serve`) forces loopback via CLI flags (`--ip`/`--ui-ip`), spawns an args-array + `{stdio:"ignore"}` with no `shell` field (shell:true structurally impossible), is env-gated STRICT `SOW_MANAGE_TEMPORAL === "true"` (shipped default OFF/byte-equivalent), takes an INJECTED spawner seam (the whole suite spawns no real server) + disposes with no orphan, AND persists to app-data (`--db-filename <userData>/temporal/dev.db` via an injected fs seam, never /tmp/in-memory — LIFE-3) with the no-in-memory regression pinned STRUCTURALLY (a typed-REQUIRED `dbFilename` makes start-dev-without-it un-buildable); a hard-line→substrate downgrade (G62) is owner-ratified + recorded. |
| [14](LESSONS.md#14) | 2026-07-20 | Electron-main→worker-host IPC config forwards ONLY plain-data arming opts (function deps stay worker-side); a mirrored-interface sync-pin needs the invariant type-identity form | Across the `fork` IPC boundary function deps (`makeCompletion`/`checkReachable`/`providerTransport.make`) can't cross — forward ONLY plain-data `subscriptionArm {enabled,model?}`, let `bootWorker` default the completion + keep the real probe worker-host-side (env-only arm degrades HEALTH-denied `FAIL_CLOSED_REACHABILITY` — an OFF-lock across the fork); extract env-parse + config-mapping into PURE electron-free helpers (§3), conditional-spread every field (omit-when-unset ⇒ byte-identical); the two mirrored `WorkerHostConfig` interfaces get an invariant type-IDENTITY pin (`(<T>()=>T extends A?1:2) extends …`), NOT bare assignability (blind to optional-field drift — a vacuous green on exactly what it guards). |
| [15](LESSONS.md#15) | 2026-07-20 | A native config `.env` loader hydrates ONLY a recognized allowlist — structural exclusion of the shadowing set + secrets; the ALLOWLIST is the gate not the parser; empty=unset, existing-env-wins, warn-KEY-only | Hydrate ONLY an enumerated `SOW_*` allowlist (never blanket) ⇒ the shadowing-env set + secrets are excluded BY CONSTRUCTION (none is `SOW_*`) so a plaintext `.env` can't shadow the subscription / redirect egress / auto-load a secret, no denylist maintained; the ALLOWLIST is the gate so a minimal in-repo parser is safe (no dotenv dep — a parse bug can't hydrate a non-allowlisted key); skip+WARN non-allowlist keys KEY-only (rule 7), inline the shadowing set if barrel-export drags a node-heavy import (warning-specificity only, never the gate); missing `.env` no-op, existing `process.env` wins, empty value = UNSET (blank `KEY=` must not clobber a `?? default` — `mkdirSync("")` boot-break), `Object.create(null)` map (no `__proto__` pollution). |
| [16](LESSONS.md#16) | 2026-07-24 | A renderer-supplied PATH crossing the trusted preload bridge is STILL untrusted — main containment is ONE pure electron-free predicate (lexical `+sep` → realpath re-containment → isFile-for-open), never-throws, fail-closed with no disclosure; keep `shell`/electron OUT of the pure module | The preload bridge authenticates the CHANNEL, not the path VALUE. `guardVaultPath(path, roots, realpath)`: reject NUL/malformed BEFORE any fs seam (spies UNCALLED) → lexical `resolve` + `full===root \|\| full.startsWith(root+sep)` (the `+sep` kills sibling-prefix `/vault-evil` vs `/vault`, mirror `resolveAppRequest`) → realpath BOTH target+matched-root, re-check on the REAL paths (closes symlink escape — the layer `resolveAppRequest` lacks; mirror worker `copilotVaultRead`/L17) → `isFile` for open (reveal is containment-only). Dispatch `shell.openPath` on the REALPATH absPath (NARROWS check→act TOCTOU, not fully closed). Fail-closed typed reject, no fs side effect, no disclosure of why (rule 7/§16), never throws. Keep `import {shell} from "electron"` OUT of the pure module so it tests under the DOM-less node tsconfig (L3); the `ipcMain.handle` registration is `/wired`+typecheck, not unit-tested. New channel names dodge the inventory forbidden-regex (`fs\|file\|shell\|exec\|secret`). Desktop analog of worker L5/L17. Multi-root follow-up: re-check realTarget vs ALL realpath'd roots. `pin: open-in-vault.test.ts (outside-roots + traversal + symlink-escape + sibling-prefix + NUL + non-file + never-throws + reject-zero-shell-calls + open-uses-realpath)`. |
| [17](LESSONS.md#17) | 2026-07-24 | Electron MAIN must BUNDLE the pure `@sow/*` it imports at runtime — a runtime `@sow/*` import left externalized-without-`sow-built` resolves to raw `.ts` → load crash; deep-import to dodge the barrel | `@sow/*` resolve via `sow-built → dist` / `default → src.ts`; the worker-host child sets `--conditions=sow-built`, Electron MAIN does NOT → an externalized runtime `@sow/*` import resolves to raw `.ts` → `SyntaxError` at load (app won't launch). REGRESSION: 9.12 added the first runtime `@sow/contracts` import into main (open-in-vault.ts); green before only because no main file imported `@sow/*` at runtime (preload's type-only/erased). FIX: exclude pure `@sow/*` from `externalizeDepsPlugin()` in the main build (Vite bundles+transpiles) + DEEP-import (`@sow/contracts/primitives/result`) to avoid the zod/ajv barrel drag (390K→16.5K); keep @sow/worker+native external; do NOT change the shared package.json default→dist (breaks source vitest/tsc). Same class at PACKAGING. `pin: bundle/main-bundle-resolution.test.ts (real build; no .ts require/no zod-ajv drag; RED-on-exclude-removed)`. |
| [18](LESSONS.md#18) | 2026-07-24 | An authoritative DURABLE first-run marker owned by main — pure injected-fs → userData, inventory-cleared preload channel, gates ONLY the UX mount NEVER the WS-8 predicate; additive-authority + write-once backfill | A renderer-only gate re-shows onboarding on a transient empty registry (worker down at boot). Fix: a main-owned durable marker (pure electron-free read/write over an injected fs seam → userData, L13/L16) + 2 inventory-cleared channels (`lifecycle:firstRunStatus`/`markOnboarded`, no-renderer-args write). Gate consults it: complete⇒suppress (even empty registry), absent/fault⇒registry fallback (additive authority, not a hard lock). ⚠ gates ONLY the mount, NEVER `isWorkspaceScope`/`isGlobal` (isolation registry-derived, L9). Confirmed-create marks it; a write-once fire-once backfill (`shouldBackfillMarker`: registryHasOnboarded && marker resolved-not-complete; PENDING⇒skip, FAULT⇒fire [registry authoritative, idempotent]) protects existing installs. `pin: first-run.test.ts + first-run-gate.test.ts + preload-inventory.snapshot.test.ts`. |
| [19](LESSONS.md#19) | 2026-07-24 | A deterministic MODEL-FREE Today daily-brief from UI-safe store counts — dumb-render prop, distinct from the on-request Copilot briefing; renders only counts (rule 5) | The rich brief is the model-synthesized Copilot briefing (Phase-24.x, needs a model) — not demo-compatible. Render a deterministic brief from store COUNTS: pure `buildDailyBrief({recentChanges,ingestion,approvals})` (L3) → headline (most-actionable non-zero, approvals>triage>recent) + zero-dropped `meta` chip + honest singular/plural; all-zero⇒"all caught up". Return `{summary,meta,stats}` (both node-tested; Today = dumb prop-render, App computes from state). Only counts render (rule 5). ⚠ don't source "open issues" from System Health (conflates infra + duplicates the Health section); the global approval count is ratified (not a WS-8 leak). Schedule = honest "No calendar connected" until 9.9. `pin: daily-brief.test.ts + today-brief.test.tsx`. |
| [20](LESSONS.md#20) | 2026-07-29 | A redaction boundary WITHHOLDS the unsafe value from the caller's type, not asks the caller not to render it | `ErrorBoundary`'s `fallback` is typed `(reset: () => void) => ReactNode` — **no error param at all** — so a caller CANNOT leak `error.message`/a stack because it is never handed one; the rule-7 obligation is discharged by the TYPE, not by every present+future caller remembering a convention. ⇒ when a boundary exists to keep a value from being displayed, express that by NOT PASSING the value: a convention says "don't render this", a signature says "you have nothing to render", and the second survives a contributor who never read the convention. Same family as 9.34's `AdmittedCopilotAnswer` brand + worker L31's literal-`false` arming flags — **make the unsafe state unrepresentable, not merely forbidden.** ⚠ Applies wherever a caller is handed something it must partially ignore (error objects, raw envelopes, unredacted rows): if it needs three of eight fields, hand it three. `pin: error-boundary.test.tsx fallback_exposes_no_raw_message_or_stack, mutation-verified`. |
| [21](LESSONS.md#21) | 2026-07-29 | Verify a TEST-INFRASTRUCTURE assumption empirically before building on it — the harness's behaviour is not the platform's | Extends **L3/L4**. Two instances in one slice. **(a)** The natural test for "the boundary does NOT catch handler failures" is `expect(() => fireEvent.click(...)).toThrow()` — **it does not throw**: per DOM spec jsdom's `dispatchEvent` reports a listener exception to the GLOBAL error handler, not the caller, and React DEV's `invokeGuardedCallbackDev` re-dispatches it as a DELAYED global report ⇒ a process-level unhandled exception **failing the whole suite while the test's own assertions were green.** ⚠ **A green test inside a red run is the worst diagnostic shape available** — real failure, attributable to nothing the test says, looks like someone else's regression. Rewritten to an async rejection the component handles itself (the real `{ok:false}` fold): same invariant, zero noise. **(b)** `tsconfig.web.json` listed `preload/api.d.ts` for the `window.sow` ambient; `tsconfig.testdom.json` never had, because no test-dom file had transitively pulled in `App.tsx` — the moment one did, 4 errors appeared **in the testdom pass only.** ⇒ the three tsc configs silently diverge on ambient `.d.ts` includes and the gap surfaces only when a test first reaches a file needing it; diagnosed by running each config STANDALONE rather than inferring from a combined run (correct in a shared tree where another area's WIP can produce a red). ⇒ **run the smallest version and look** — both cost one command to establish and a debugging session to infer; and **document the surprise in-file**, or the next person simplifies the test back into the trap. `pin: error-boundary.test.tsx boundary_does_not_catch_async_or_handler_failures + tsconfig.testdom.json`. |
| [22](LESSONS.md#22) | 2026-07-29 | A correctness property holding only because a BROAD FOLD flattens everything becomes a branching obligation the moment you narrow the fold — pin ALL its real call sites | `onboard-workspace.ts` folded every failure to `{ok:false}`, so *"onboarding never marks complete on a partial"* was TRUE **only because the fold made `markOnboarded()` unreachable** — nothing branched on the partial, so nothing could act on it. ⇒ **narrowing the fold converted a structural guarantee into a BRANCHING OBLIGATION**: the property didn't change, **what enforced it did** (from "no code path exists" to "our new branch must not take one"). **Pin it BEFORE widening** — afterwards the test proves the new code and nobody remembers the guarantee used to be free. ⭐ **Sharper half, cost a Step-2.5 round trip: pin ALL real call sites.** `markOnboarded` has TWO — `App.tsx:240` (handler) and `App.tsx:104` (the 9.17 backfill); the write-up asserted "called only inside App.tsx:223-240", which was FALSE. Tracing the second showed the guarantee thinner than it looked: on a partial `onOnboarded` never fires ⇒ `backfilledRef` stays false ⇒ **the fire-once guard does NOT block the backfill**; only `shouldBackfillMarker` returning false prevents a written marker, and that holds only because the store gains its workspace **inside the handler that didn't fire**. The guarantee survived via a two-step inference across a second call site, in a slice whose whole purpose was to stop relying on incidental correctness. ⚠ **The instrument that caught it was a FLAG, not a test** — the implementer wrote "markOnboarded is NOT separately pinned" rather than "both pinned"; **stating an asymmetry is what makes it reviewable.** **Do:** before narrowing a fold, enumerate what was true only because it flattened, then grep every call site of each guarantee's mechanism and pin them all. `pin: app-partial-scaffold-markonboarded.test.tsx, real-App, both sites, mutation-verified`. [full](LESSONS.md#22) |
| [23](LESSONS.md#23) | 2026-07-31 | A fetched-on-demand PER-ROW detail needs the `PostureCell` shape — invalidate on every SET REPLACEMENT, not only unmount, and CLEAR a stuck `loading` cell | Reuse `egress.tsx:77-135`'s per-item shape (`Record<id,Cell>` 3-state union + monotonic per-item seq guard + fail-closed presentation) for any row that fetches its own detail. **Two clauses do NOT transfer from it.** (a) **Invalidate on every set REPLACEMENT**, not just unmount: `hydrateScope` (`lib/live.ts:196-245`) clears+refetches `recentChanges` wholesale on scope change, and key separation covers A→B but **not A→B→back-to-A**, where the row's own id reappears and a stale resolution populates a row nobody re-activated. ⚠ Key separation is enforced in ANOTHER package (`deriveChangeId` hashes `workspaceId`, worker `recentChanges.ts:62-65`) so per **L66** the pin must NAME it, not rely on it silently. (b) **Clear a stuck `loading` cell** (security-reviewer's catch, the non-obvious half): the seq bump stops the wrong paint but leaves the row reading "Checking details…" **forever with no retry** — retain `ready`/`unavailable`, clear `loading`. **A guard that prevents a wrong result and strands the UI trades a visible error for an invisible one.** ⚠ Dep must be a DERIVED STABLE KEY, never the array reference: with `[changes]` no drill can EVER complete, and that is invisible to the obvious suite (the superseded-resolution test *passes harder* when nothing paints — **L80** aimed at an invalidator). Pin BOTH directions. `encodeURIComponent` deliberately not copied (sha256 hex cannot contain the delimiter) — reason stated in-code, since an unexplained divergence reads as an oversight. |

<!-- Starts empty. Each row links to its `LESSONS.md` anchor. -->

<!-- Slash commands: see root CLAUDE.md "Slash commands available." Implementer pair: /session-start + /session-end. -->

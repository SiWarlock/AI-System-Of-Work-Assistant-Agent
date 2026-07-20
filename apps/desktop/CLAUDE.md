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

<!-- Starts empty. Each row links to its `LESSONS.md` anchor. -->

<!-- Slash commands: see root CLAUDE.md "Slash commands available." Implementer pair: /session-start + /session-end. -->

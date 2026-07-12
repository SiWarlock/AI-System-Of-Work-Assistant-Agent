# Session 060 — impl10: GBrain pin-verify made REAL + reachable, then the Phase-9 pivot (a11y + AppRouter typing)

- **Date:** 2026-07-12
- **Phase:** 11 (install-doctor / pin-verify tail) → 9 (renderer pivot)
- **Implementer:** `impl10` (cycled in for `impl8`; orchestrators `orch9`→`orch11`; team `session-f2673cd5`, single-track on `main`)
- **Predecessor:** [059-2026-07-12-phase11-install-doctor-arc.md](059-2026-07-12-phase11-install-doctor-arc.md)
- **Successor:** _(next session)_

## Why this session existed

Cycled in at a clean boundary to finish the Phase-11 install-doctor/pin-verify tail, then — once the non-HITL Phase-11 deterministic runway was spent — pivot (owner-authorized) to LOCAL non-HITL Phase-9 renderer work. Five slices, each TDD-first (RED before GREEN), each adversarially reviewed, repo-wide `turbo typecheck test` 31/31 green throughout.

## What was built (5 slices, all committed)

**`9fa5760` — 11.5-e install-doctor collector argv/bin hardening (LOW).** `--` end-of-options separator before the one positional-PATH command (`/bin/ls -lde -- <vaultDir>`); absolutized the macOS security-STATE probes (`fdesetup`→`/usr/bin/fdesetup`, `security`→`/usr/bin/security`); version-presence bins stay bare. Closes Lesson-19's two named residuals. Dual review CLEAR.
- Modified: `apps/worker/src/install/{probe-collectors,posture-collectors}.ts` + their 2 tests + `test/install/doctor-cli.test.ts` (readBins/argv ripple).

**`3141118` — 11.3-a GBrain version-pin startup-verify made REAL over a local probe.** New `packages/knowledge/src/gbrain/startup-verify.ts` (`parseGbrainDoctorJson` fail-closed parser + `GbrainVersionProbe` port + `verifyGbrainStartup` composition over the built `checkVersionPin`, total never-throw) + `gbrain-version-probe.ts` (thin `execFile` adapter). **Finding (Option A, owner-deferred):** gbrain 0.35.1.0 exposes no local commit-SHA → the real probe fail-closes to `gbrain_unavailable` (documented in-code). Security CLEAR (0 findings), code-quality resolved.
- Created: `packages/knowledge/src/gbrain/{startup-verify,gbrain-version-probe}.ts` + `test/gbrain-startup-verify.test.ts`. Modified: `packages/knowledge/src/index.ts` (barrel).

**`c70426d` — 11.3-b wire `verifyGbrainStartup` into `bootWorker` (reachability + HealthItem).** New `apps/worker/src/gbrainStartupVerify.ts` best-effort boot helper (loads the pin, probes, surfaces the version-pin HealthItem on degrade; never throws/blocks boot); wired into `bootWorker` gated by `config.gbrainStartupVerify`, fire-and-forget. Closes the 11.3-a reachability waiver. Dual mandatory review CLEAR (never-crash-boot proven structurally; write-through flip stays HITL).
- Created: `apps/worker/src/gbrainStartupVerify.ts` + `test/gbrainStartupVerify.test.ts`. Modified: `apps/worker/src/boot.ts`.

**`5c55011` — 9-a11y roving-focus listboxes (pivot slice 1).** New shared `apps/desktop/renderer/lib/a11y/useRovingListbox.ts` (ARIA-APG roving-tabindex: single tab stop, Up/Down/Home/End, no-wrap, explicit Enter/Space selection); Projects + ScopeSwitcher converted off the every-option-`tabIndex=0` anti-pattern. Code-quality caught a real MEDIUM (count-shrink loses the tab stop → clamp-on-read + regression test).
- Created: `renderer/lib/a11y/useRovingListbox.ts` + `test-dom/roving-listbox.test.tsx`. Modified: `renderer/surfaces/projects/Projects.tsx`, `renderer/chrome/AppShell.tsx`.

**`4ee886d` — task 36 AppRouter typing (pivot slice 2).** Typed the renderer tRPC client against the worker's concrete `AppRouter` (was `AnyTRPCRouter`); removed all 9 `client as any` casts (8 fully typed + 1 typed adapter). Cross-package: `@sow/worker` + `@sow/db` emit `.d.ts`; desktop DOM tsconfigs redirect those to built d.ts via surgical `paths`. Code-quality CLEAR.
- Modified: `apps/worker/{tsconfig.build.json,src/index.ts}`, `packages/db/tsconfig.build.json`, `apps/desktop/{tsconfig.web.json,tsconfig.testdom.json}`, `apps/desktop/renderer/lib/{trpc,live-client,live,drilldown,approval-decision,scope-refresh,copilot-ask,ws-transport}.ts`.

## Decisions made

- **11.3-a Option A** (owner-approved): fail-closed parser keyed on candidate commit-sha fields; no contract change; the SHA-vs-tag + index-schema-source identity gaps deferred to the HITL `config/gbrain.pin` re-capture.
- **11.3-b**: surface via the raw `backends.healthItems.put` (same `health_items` table); extract a testable helper; config-gated default-OFF (deterministic CI boots); distinct `pin_load_failed` item.
- **9-a11y**: roving-tabindex (not `aria-activedescendant`); shared hook; explicit selection (arrows browse, don't select); no wrap / no typeahead; Projects + ScopeSwitcher only.
- **36**: surgical `paths` redirect to the BUILT `.d.ts` (not source); redirect `@sow/worker`→`api/server.d.ts` + `@sow/db`→`index.d.ts` (the only node-heavy pkgs in AppRouter's graph, per `--explainFiles`); the node tier stays on source via a type-only top-level `AppRouter` re-export; the `stream.onEvent` subscription (deliberately `AnyRouter` in the worker, TS2742-avoidance) is bridged with a typed adapter, not `any`.

## Decisions explicitly NOT made (deferred)

- 11.3-a/b: the HITL `config/gbrain.pin` re-capture + `writeThroughEnabled` flip + serving-oracle re-plumb — all owner-gated.
- 9-a11y: the ScopeSwitcher **popup keyboard loop** (focus-on-open + Escape-close + return-focus-to-button) — a distinct follow-up (keys on the open event, not mount).
- 36: the brief's `@sow/worker` package.json `types`-export change (unneeded — `paths` bypasses exports); the mixed `?.ok`/`.ok` style consistency (code-quality LOW, behavior-equivalent).

## TDD compliance

**Clean.** Every slice was RED-first: unit/render tests written before the implementation (11.5-e/11.3-a/11.3-b/9-a11y), and for the typing refactor (36) the RED was a red `tsc` (the reproduced DOM-conflict), GREEN via the emit+redirect, with the repo-wide `turbo typecheck test` gate as the pin. No TDD violations. Behavior preservation on 36 was verified (a desktop test caught a dropped defensive fold → restored).

## Cross-doc invariant audit

**No frozen-contract / Appendix-A model field changed this session.** 11.3-a/b reuse `GbrainPin`/`RunningGbrainVersion`/`HealthItem` as-is; 36's `AppRouter` is an inferred type surface (not an Appendix-A model), confirmed with the orchestrator. Nothing to mirror in `ARCHITECTURE.md`.

## Reachability

- 11.5-e: hardened collectors already consumed by `runInstallDoctor`/`sow-doctor`.
- 11.3-a: `verifyGbrainStartup` reachable via the gated real-adapter test; production boot entry landed in 11.3-b.
- **11.3-b: `/wired gbrain_version_pin` = bootWorker → gbrainStartupVerify → verifyGbrainStartup → checkVersionPin (CLOSED the 11.3-a waiver).**
- 9-a11y: in-place a11y refactor of two already-mounted surfaces.
- 36: the typed client IS the existing production client (`createWorkerClient`/`createLiveClient`); no new entry.

## Open follow-ups

- **HITL (owner-gated):** `config/gbrain.pin` re-capture (resolves the 11.3-a SHA-identity + index-schema-source Finding) + `writeThroughEnabled` flip + `/phase-exit 11`.
- **Production packaging:** boot must supply `config.gbrainStartupVerify {pinPath}` to make the version-pin verify always-on (default-OFF ≠ never-runs-in-prod).
- **Phase-9 a11y fast-follow:** the ScopeSwitcher popup keyboard loop (focus-on-open + Escape-close + return-focus).
- **36 residual (operational):** a bare `tsc`/IDE on a clean tree must build `@sow/worker` + `@sow/db` first (the redirect points at built d.ts; `turbo typecheck dependsOn ^build` covers the gate) — documented in-code.
- **Next session (impl12):** §9.7 triage-resolution ACTION UI.

## Lessons banked (orchestrator-written)

- **desktop Lesson 5** (orch11): consume a node-heavy pkg's inferred type surface via its BUILT `.d.ts` (surgical `paths`), never source (+ the `AnyRouter`-subscription typed-adapter corollary). Extends Lesson 1.
- Lessons 19 (exec-safety) + 20 (reachability-waiver-holder) applied across the Phase-11 slices.

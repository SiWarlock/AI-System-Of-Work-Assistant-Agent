# Session 104 — Phase-18 §ARM-18 CHECKPOINT-1 hardening (subscription arm no-surprise-spend)

- **Date:** 2026-07-20
- **Phase:** 18 (subscription-extraction ENABLE — §ARM-18 CHECKPOINT-1 pre-first-armed-run hardening)
- **Track:** main (single-track, worker area)
- **Predecessor:** [103-2026-07-20-phase18-desktop-arming-dotenv-loading.md](103-2026-07-20-phase18-desktop-arming-dotenv-loading.md)
- **Successor:** _(none yet)_

## Why this session existed

Three §ARM-18 CHECKPOINT-1 residuals had to close before the FIRST real armed subscription run: (1) the real spend-free reachability probe was bound in no production path (the ENABLE needed a code patch, not a config flip); (2) the 18.28 shadowing guard watched only `process.env` — a Claude-Code `settings.json` key injection (`apiKeyHelper` / settings-`env`) that the Agent SDK `query()` also honors was an invisible spend shadow; (3) the 18.28 watched-env set under-covered the real subscription-shadow provider surface. All three are dormant, owner-gated, arm-nothing hardenings.

## What was built

**Files created:**
- `apps/worker/src/composition/subscription-reachability-arming.ts` (18.35) — pure `resolveArmCheckReachable(subscriptionArm, enableSignal, deps?)` + `ARM_REACHABILITY_DEFAULTS` + `REACHABILITY_LIVE_ENV_VAR` + the relocated `FAIL_CLOSED_REACHABILITY` floor. Binds the real probe iff arm enabled AND `SOW_SUBSCRIPTION_REACHABILITY_LIVE` set (strict `"1"|"true"`); else fail-closed.
- `apps/worker/test/composition/subscription-reachability-arming.test.ts` (18.35) — 8 tests.
- `apps/worker/src/composition/subscription-settings-guard.ts` (18.36) — pure `assertNoSettingsKeyInjection(read)` + `guardSettingsOnArmedPath(armed, read)` + `SETTINGS_INJECTION_FIELDS` + the real `readClaudeCodeSettings` hierarchy reader. Presence-only settings key-injection detection; fail-safe degrade.
- `apps/worker/test/composition/subscription-settings-guard.test.ts` (18.36) — 19 tests (17 at 18.36 + 2 single-source/gcp added at 18.37).

**Files modified:**
- `apps/worker/src/boot.ts` (18.35 + 18.36) — `checkReachable` arg sourced from `resolveArmCheckReachable`; local `FAIL_CLOSED_REACHABILITY` const removed (relocated). Added the armed-path settings guard + the combined `armRefused`/`armEffective` degrade wired through ALL THREE arm consumers (transport-strip / reader-holder / route+ContextRef+schema arming) + a distinct settings-fault error log.
- `apps/worker/src/composition/subscription-auth-guard.ts` (18.37) — `SUBSCRIPTION_SHADOWING_ENV_KEYS` extended 13→30 (full grounded provider surface: 5 switches + by-presence tokens/creds + per-provider base-url redirects + mTLS) + doc.
- `apps/worker/test/composition/subscription-auth-guard.test.ts` (18.37) — 30-key mirror + extended enumeration + exclusion pins + AWS-cred-exclusion soundness test.
- `apps/worker/src/composition/subscription-settings-guard.ts` (18.37) — `SETTINGS_INJECTION_FIELDS` += `gcpAuthRefresh` (Vertex analog of the AWS cred-scripts).

**Commits:** `ee1d8a34` (18.35) · `8c9763ff` (18.36) · `afb98684` (18.37).

## Decisions made

- **18.35 signal source = Option A (`process.env`).** Verified the worker child inherits main's `process.env` (fork at `apps/desktop/main/index.ts:134` with no `env` filter; the code comment states it, `bootWorker` reads `process.env` directly). So the shell-export ENABLE needs zero desktop change; the resolver stays pure (takes the signal value). Grounded via `claude-code-guide`.
- **18.36 field set grounded vs live Claude-Code docs.** Reuse 18.28's `SUBSCRIPTION_SHADOWING_ENV_KEYS` for the settings-`env` leg (a settings `env.X` == `process.env.X`, single-source). `SETTINGS_INJECTION_FIELDS` = the unambiguous cred-minting fields; EXCLUDE `model`/`availableModels`/`forceLogin*` (common/ambiguous → permanent false-degrade, the L65 `NO_PROXY` class).
- **18.36 combined degrade folds into ALL arm consumers.** A settings injection degrades transport + route + ContextRef + schema + reader-holder together (no split-brain, L52).
- **18.37 exclusion principle:** watch the provider SWITCH (the by-presence trigger); exclude the downstream common generic cloud creds (`AWS_*`/`GOOGLE_*`) + routing IDs + `NO_PROXY` — sound only because ALL FIVE provider switches are now watched.

## Decisions explicitly NOT made (deferred)

- **The actual arming FLIP** (real cloud egress + spend) — owner+lead-gated, per-crossing confirm. These slices build dormant; nothing arms.
- **Repo-source authoritative re-ground of the full switch + credential-env set** — deferred to the flip re-verify as a HARD §ARM-18 precondition (see Open follow-ups; the grounding-source Finding).
- **The `managed-settings.d/*.json` fragment enumeration** (18.36 reader) — flagged in-code as a flip re-verify residual.
- **A composition-level coherence pin** that all arm-degrade consumers move together — the boot wiring is `SOW_API`-gated/skipped (L58), so this class isn't unit-pinnable today.

## TDD compliance

**Clean.** Every slice: RED test written first (import/enumeration failure confirmed for the right reason), Step-2.5 orchestrator review before GREEN, minimum implementation, full-suite green. Two dual-review-caught defects were fixed in-slice with the fix re-verified green (see Open follow-ups). No TDD violations.

## Reachability

- **18.35** `resolveArmCheckReachable` — reachable from `apps/desktop/worker-host/index.ts:142` `boot.bootWorker(...)` (forked worker-host child) → `bootWorker` → the `checkReachable:` arg. Shipped default (`arming.effectiveArmed=false`) reads nothing (byte-equivalent).
- **18.36** `guardSettingsOnArmedPath`/`readClaudeCodeSettings` — reachable from the same `bootWorker` armed path (boot.ts). Shipped default: no fs read.
- **18.37** — no new wiring; extends `SUBSCRIPTION_SHADOWING_ENV_KEYS` (consumed by `assertSubscriptionAuthEnv` + 18.36's settings-`env` leg) + `SETTINGS_INJECTION_FIELDS` (consumed by `assertNoSettingsKeyInjection`). Both boot armed path.
- No tested-but-unwired gaps. The boot integration path itself is `SOW_API`-gated (L58) — covered by typecheck + Step-7.5 `/wired` per slice.

## Open follow-ups

Step-9 items were routed hot by the orchestrator (Lessons 71/72, §ARM-18 ledger + §19.5 arch notes). Still-open follow-ups:

1. **⚠ FINDING (escalated to lead) — grounding-source reliability + a repo-source re-ground:** the public-docs grounding under-covered the shadow set TWICE (18.28 → 18.37 still missed the 5th provider switch `CLAUDE_CODE_USE_ANTHROPIC_AWS`, found by security-reviewer via the `anthropics/claude-code` repo). **A repo-source authoritative re-ground of the full switch + credential-env set is now a HARD §ARM-18 flip precondition before the first armed run** (folded into the existing flip re-verify).
2. **Fail-safe residuals to confirm at the flip re-verify:** `ANTHROPIC_AWS_API_KEY` may be spurious (kept — inert if so); the mTLS + Foundry/Mantle base-url/cred names + `gcpAuthRefresh` couldn't be independently repo-confirmed (inert-if-wrong, fail-safe).
3. **Desktop `.env`-allowlist follow-up (18.35):** add `SOW_SUBSCRIPTION_REACHABILITY_LIVE` to `apps/desktop/main/dotenv-allowlist.ts` — needed only for a `.env`-FILE ENABLE; the shell-export ENABLE works today (desktop territory, separate slice).
4. **Boot-arm-consumer coherence coverage-gap (18.36):** a composition-level pin that transport/route/ContextRef/schema/reader-holder degrade together on a settings fault — belongs with the `SOW_API` boot integration coverage.
5. **Deployment-checklist residuals (non-env shadows):** the programmatic `query({env/managedSettings})` bypass + a Claude-apps gateway session (no single env var) — backstops the file/env scans can't see.

## Two defects caught by dual-review + fixed in-slice

- **18.36 split-brain:** the combined degrade was applied to 2 of 3 arm consumers; the 3rd (`withSubscriptionExtractionArming`, boot.ts:1415) still read `arming.effectiveArmed`. Fixed → `armEffective`; verified by reading the wiring (orchestrator) + full suite.
- **18.37 critical rule-5 fail-open:** the generic-AWS-cred exclusion was fail-open because a 5th provider switch (`CLAUDE_CODE_USE_ANTHROPIC_AWS`) was unwatched. Fixed → added the switch (5/5 watched) + extended the soundness test; green is the verification (pure env-set).

# Session 105 — Phase-18 §ARM-18 CHECKPOINT-1 GATE-1: subscription shadow-guard completeness-by-construction

- **Date:** 2026-07-24
- **Phase:** 18 (subscription-extraction ENABLE — §ARM-18 CHECKPOINT-1, the owner-authorized test-vault auto-ingest crossing; GATE-1 hardening)
- **Track:** main (single-track, worker area)
- **Predecessor:** [104-2026-07-20-phase18-arm18-checkpoint1-shadow-hardening.md](104-2026-07-20-phase18-arm18-checkpoint1-shadow-hardening.md)
- **Successor:** _(none yet — fresh worker pair resumes at gate-2, see Open follow-ups)_

## Why this session existed

The owner-authorized §ARM-18 CHECKPOINT-1 crossing (auto-ingest ENABLE over a fresh throwaway TEST vault; real `~/Obsidian/brain` OUT) drives 6 gates in order. GATE-1 = a ⛔HARD repo-source authoritative re-ground of the subscription-shadow guard against the SDK-bundled claude-code runtime (not public docs — which under-covered twice already, worker L72). Re-verifying GATE-1 from scratch surfaced that the guard's **denylist** approach is structurally unwinnable for a rule-5 (egress-veto / no-surprise-spend) COMPLETENESS invariant — and the fix is to invert to **completeness-by-construction** on both the env surface and the settings-file surface.

## What was built (3 slices, all dormant / owner-gated / $0)

**18.38 — the shadow-denylist re-ground (`8ac03a48`) — DEFENSE-IN-DEPTH belt.**
- Modified `apps/worker/src/composition/subscription-auth-guard.ts` (+test): `SUBSCRIPTION_SHADOWING_ENV_KEYS` 30→81, grounded against the **actual SDK-bundled claude-code 2.1.201** (inside `@anthropic-ai/claude-agent-sdk@0.3.201` — NOT the standalone `~/.local` 2.1.216 CLI). Added the provider/gateway/router/host switches, SKIP-auth signals, credential-indirection incl. the host-auth cluster, egress/base-url/socket/config-dir redirects, mTLS, and the full bare-`CLAUDE_` namespace (OAuth-base/bridge/config-dir + the `CLAUDE_ENV_FILE` dotenv-bypass pointer). Single-sourced across the process.env guard + the 18.36 settings-`env` leg.
- **Key finding:** a process.env-scan denylist can NEVER be complete for rule-5 — `CLAUDE_ENV_FILE` injects from a FILE the scan can't see, and the shadow namespace drifts every SDK bump (5 successive re-grounds each found more). So 18.38 ships as a **belt only** (a loud pre-run operator-misconfig degrade), NOT a rule-5 closure.

**18.40 — the env-surface completeness fix (`46198ace`, worker+providers) — the suspenders.**
- Created `apps/worker/src/composition/subscription-child-env-allowlist.ts` (+test): pure `buildSubscriptionChildEnvAllowlist` + `SUBSCRIPTION_CHILD_ENV_ALLOWLIST` (PATH/HOME + OS-operational; NO credential/redirect var — the login is ambient via `~/.claude` + macOS Keychain) + `resolveSubscriptionSpawnChildEnv` (the SINGLE armed-spawn chokepoint, gated `subscriptionArm.enabled===true || copilotRealModel===true`).
- Modified `packages/providers/src/model/claude-subscription-completion.ts` (+test, authorized cross-track): an optional `childEnv` → `query()` `options.env` (which REPLACES the child env ENTIRELY, sdk.d.ts:1391-1409; byte-equiv when omitted). Modified `apps/worker/src/boot.ts`: one `spawnChildEnv` wired into BOTH spawn sites (:1340 extraction makeCompletion + :1787 §13.10 Copilot completion — no split-brain).
- **Result:** the child claude sees ONLY the allowlist → no shadow var (known/unknown/future/`CLAUDE_ENV_FILE`-injected) can reach it = complete-by-construction, drift-immune. Retires the "re-verify the shadow set at every version bump" precondition for the env surface. security-reviewer CERTIFY (zero defects).

**18.39-B — the settings-file-surface completeness fix (`e11f0a6d`) — the settings suspenders.**
- Modified `apps/worker/src/composition/subscription-settings-guard.ts` (+test): extended `readClaudeCodeSettings` to read the full MANAGED tier (base `managed-settings.json` + `managed-settings.d/*.json` fragments via `readManagedFragments` + the device/per-user `/Library/Managed Preferences/*.plist` via `readManagedPreferencesPlists` + the `CLAUDE_CODE_{MANAGED,REMOTE}_SETTINGS_PATH` relocation vars via `relocationDegradeSource`). Then inverted `assertNoSettingsKeyInjection` to a **presence-based managed-tier degrade** (Option B): ANY present + non-empty MANAGED settings source ⇒ fail-safe degrade (empty `{}` ⇒ clean). Removed `MANAGED_TIER_INJECTION_FIELDS` (subsumed). Non-managed tiers keep the field-scan (defense-in-depth; disabled by `settingSources:[]`).
- **Result:** every managed injecting field (apiKeyHelper/hooks/statusLine/`headersHelper`/any future one) is subsumed by presence — no field to miss = complete-by-construction + drift-immune, the settings-file analog of 18.40's env inversion. Cross-file coupling (managed-only soundness ⟷ the extraction query()'s `settingSources:[]` at providers:145) source-pinned (RED-on-weaken) + programmatic `managedSettings`/`settings` pinned. security-reviewer CLOSED (enumerated every managed source the 2.1.201 binary reads on macOS — all covered; no source unread). Closes session-104 residual #40.

## Decisions made

- **Ground against the SDK-BUNDLED claude-code (2.1.201), not the standalone CLI (2.1.216) nor public docs** — the SDK's `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.201/claude` native binary is the worker's real `query()` runtime (verified via its `manifest.json` version "2.1.201" + `claude --version`). Extends L72.
- **Invert both surfaces to completeness-by-construction** (owner Category-4 call, twice — parallel to each other): env → a minimal spawn-env allowlist (18.40); settings-file managed tier → a presence-degrade (18.39-B). A rule-5 COMPLETENESS invariant demands a positive allowlist / presence-check, not an unwinnable field/var denylist. The 18.38 denylist + the non-managed settings field-scan survive as **defense-in-depth belt**.
- **`CLAUDE_ENV_FILE` is the only dotenv mechanism** (empirically grounded — no implicit cwd/project `.env` auto-load); env-scrub closes it by construction. **managed-only hooks/fields are sound** because `settingSources:[]` disables user/project (SDK-confirmed); the coupling is source-pinned.

## Decisions explicitly NOT made (deferred)

- **The gate-5 FLIP** (real cloud egress + spend) — owner+lead-gated, per-crossing confirm. All 3 slices are dormant; nothing arms.
- **gate-2 → gate-6** — NOT run this session (cycled at the pre-flip seal; see Open follow-ups). In particular the **$0 SOW_L64_DRYRUN SDK-control-var check (gate-3) is NOT yet run**.
- **otelHeadersHelper** — env-gated (`CLAUDE_CODE_ENABLE_TELEMETRY`), excluded by 18.40's env-allowlist ⇒ not reachable in the armed child; a flip re-verify note, not folded.

## TDD compliance

**Clean.** Every slice: RED test written + confirmed-failing-for-the-right-reason (import/enumeration/assertion) BEFORE GREEN; Step-2.5 orchestrator review; minimum implementation; full-suite green. Reviewer-found gaps (18.40 host-auth cluster; 18.39 plist/statusLine/headersHelper) were folded with the fix re-verified green. No TDD violations.

## Cross-doc invariant audit

**No frozen-contract (Appendix-A) model field changed** this session — all changes are worker-internal constants/functions (`SUBSCRIPTION_SHADOWING_ENV_KEYS`, the env-scrub builder + resolver, the settings-guard reader/scan). No `ARCHITECTURE.md` cross-doc-invariant edit is owed from code. The §19.5/§ARM-18 arch NOTE (both GATE-1 legs complete-by-construction; per-version re-verify retired; residual #40 closed) + worker Lesson-73-companion are orchestrator-territory, flagged at Step 9 and written by the orchestrator at `/orchestrate-end`.

## Reachability

- **18.38** — no new wiring; extends the already-consumed `SUBSCRIPTION_SHADOWING_ENV_KEYS` (bootWorker armed path via `assertSubscriptionAuthEnv` + the 18.36 settings-`env` leg). Reachability-waivered (L11).
- **18.40** — `resolveSubscriptionSpawnChildEnv`/`buildSubscriptionChildEnvAllowlist` reachable from `bootWorker` armed path via the one `spawnChildEnv` (boot.ts:1327) → BOTH `createClaudeSubscriptionCompletion` sites (:1340 + :1787); providers forwards to `options.env`. Step-7.5 CLEAR (only two real construction sites; no bypass).
- **18.39-B** — extends the 18.36 armed-path reader (`guardSettingsOnArmedPath` → `readClaudeCodeSettings`). Reachability-waivered (L11); the real fs is touched only on the owner-armed boot.
- No tested-but-unwired gaps. Shipped default byte-equivalent (unarmed ⇒ nothing read).

## Open follow-ups — ⛔ EXACT pre-flip resume state for the fresh worker pair

**GATE-1 = both rule-5 legs CODE-COMPLETE by-construction, reviewer-signed:**
- env-scrub (18.40 `46198ace`) + settings presence-degrade (18.39-B `e11f0a6d`); the 81-denylist (18.38 `8ac03a48`) + settings-field enumeration = defense-in-depth belt. Per-version re-verify preconditions RETIRED.

**REMAINING gates (fresh worker carries gate-3 onward — do NOT free-run; orchestrator dispatches):**
- **gate-2** — live Agent-SDK-docs re-ground (no extraction).
- **gate-3** — ⛔ **the $0 `SOW_L64_DRYRUN=1 npx vitest run apps/worker/test/integration/autoIngest-armed-live.test.ts`** — validates the SDK re-injects its own `CLAUDE_CODE_SDK_*` stdio/IPC control vars atop the replaced env (18.40's load-bearing runtime unknown — fail-CLOSED if not) + a real note is produced (L64). NOT yet run.
- **gate-4** — op-prereqs, all re-confirmed FRESH through the worker (not the dead session): **⛔ "no managed settings present on the armed host" = STOP+SURFACE (NOT a silent degrade)** — if the Mac has ANY `managed-settings.json`/`.d`/`/Library/Managed Preferences/*.plist`, HALT + flag the orchestrator (18.39-B degrades on managed presence); `claude` login present; `ANTHROPIC_API_KEY` UNSET; `temporal` CLI.
- **gate-5** — the FLIP (owner-gated env set: `SOW_SUBSCRIPTION_ARM=1` + `SOW_EGRESS_ALLOWED_PROCESSORS=claude-agent-sdk` + `SOW_MANAGE_TEMPORAL=true` + `SOW_VAULT_ROOT=<test>` + `SOW_SUBSCRIPTION_REACHABILITY_LIVE=1`).
- **gate-6** — one real e2e (real subscription → real KnowledgeWriter note in the fresh benign test vault; real `~/Obsidian/brain` OUT).

**Step-9 categorized items (orchestrator routes at `/orchestrate-end`):** §19.5/§ARM-18 arch note (both legs by-construction; re-verify retired; residual #40 closed); worker Lesson-73-companion (settings-file presence-degrade analog); flip re-verify notes (otelHeadersHelper; re-verify the managed-source set + settingSources behavior vs whichever claude-code version the SDK bundles at the flip). Desktop follow-up (carried from 18.38): the stale `apps/desktop/main/dotenv-allowlist.ts` duplicate of `SUBSCRIPTION_SHADOWING_ENV_KEYS` (diagnostic-only) → barrel-export.

## How to use what was built

All dormant. The armed path (`SOW_SUBSCRIPTION_ARM=1` etc.) is the gate-5 owner flip. Until then: shipped default byte-equivalent (nothing arms, nothing reads). Run the app: `pnpm install` → `./dev.sh`.

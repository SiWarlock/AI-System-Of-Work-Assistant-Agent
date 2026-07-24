# Session 106 — Phase-18 §ARM-18 CHECKPOINT-1: the auto-ingest ENABLE crossing (gates 2→6, Step A REAL RUN = PASS)

- **Date:** 2026-07-24
- **Phase:** 18 (subscription-extraction ENABLE — §ARM-18 CHECKPOINT-1, the owner-authorized test-vault auto-ingest crossing; gate ladder 2→6)
- **Track:** main (single-track, worker area)
- **Predecessor:** [105-2026-07-24-phase18-gate1-shadow-guard-completeness.md](105-2026-07-24-phase18-gate1-shadow-guard-completeness.md)
- **Successor:** _(none yet)_

## Why this session existed

GATE-1 was CLEAR at the start (both rule-5 shadow-guard legs complete-by-construction: 18.40 env-scrub `46198ace` + 18.39-B settings presence-degrade `e11f0a6d` + 18.38 denylist belt `8ac03a48`; session 105). This session drove the **remaining owner-authorized crossing gates 2→6** to the maiden §ARM-18 CHECKPOINT-1 real run: a real Claude-subscription extraction over a **fresh throwaway test vault** (benign content; real `~/Obsidian/brain` OUT), producing a real KnowledgeWriter note. This is a **real-egress / subscription-spend milestone** — the doc is its audit trail. No new committed code (the only artifact was a throwaway harness, removed).

## What was built

**Files created:** _(none committed)_
- `apps/worker/test/integration/gate6-real-run.test.ts` — **throwaway** Step-A real-run harness (env-gated `SOW_GATE6_REAL_RUN`): the committed `autoIngest-armed-live.test.ts` dry-run structure with the FAKE completion swapped for the REAL `createClaudeSubscriptionCompletion({ childEnv: spawnChildEnv })` (18.40 scrub) + reachability stubbed reachable so exactly ONE real `query()` spawn (the extraction) occurred. Content-resolution seam returned the benign staged body directly; every gate (ING-7 admission / egress-veto / schema / validateNoInference / KnowledgeWriter) ran REAL. **Removed after the run** (maiden-run precedent, session 098) — never committed.

**Files modified:** _(none)_ — HEAD unchanged at `a3180cc7` throughout; working tree clean apart from pre-existing untracked `graphify-out/`.

## Gate ladder — what happened (the audit trail)

- **gate-2 — live Agent-SDK-docs re-ground: CLEAR (no drift).** Bundled `@anthropic-ai/claude-agent-sdk@0.3.201` (claude-code 2.1.201) vs Context7 public docs. `maxBudgetUsd` (breach ⇒ `error_max_budget_usd`, not silent overrun), `betas` (`SdkBeta` = only `context-1m-2025-08-07` in both; code's `DEFAULT_EXTRACTION_BETAS` matches), `model` (request-supplied; `claude-sonnet-5` a current id) all consistent. **Load-bearing confirm:** `env` is "not merged with process.env" ⇒ providing it REPLACES the child env entirely — validates 18.40's completeness-by-construction; `settingSources:[]` default validates the 18.39-B managed-only coupling. New `taskBudget` (alpha) noted, unused by our route.
- **gate-3 — $0 `SOW_L64_DRYRUN` go/no-go: GREEN.** `SOW_L64_DRYRUN=1 npx vitest run apps/worker/test/integration/autoIngest-armed-live.test.ts` → 4/4 ran (skipIf-gated, not skipped) + passed; `ANTHROPIC_API_KEY` UNSET; fake $0 completion (`costUsd 0`, 1 call). Closes the L64 spend-and-produce-nothing risk. **Scoped nuance recorded:** the fake dry-run cannot spawn a real `query()` child, so `CLAUDE_CODE_SDK_*` control-var re-injection atop the replaced env was NOT exercised here — a real-spawn property (L73 "real-run gate") deferred to gate-6.
- **gate-4 — op-prereqs (fresh on host): ALL CLEAR.** ⛔ NO managed settings (`managed-settings.json` / `.d` / `/Library/Managed Preferences/com.anthropic.claudecode.plist` device+per-user all absent; both `CLAUDE_CODE_{MANAGED,REMOTE}_SETTINGS_PATH` unset) → no HALT; `claude` login PRESENT (`security find-generic-password -s "Claude Code-credentials"` exit 0, spend-free, no `-w`); `ANTHROPIC_API_KEY` UNSET; `temporal` 1.8.0 present.
- **gate-5 — the FLIP: owner-confirmed via the lead.** A-then-B; worker drives directly, owner clicks only the Keychain Allow. Fresh throwaway vault staged: `/var/folders/fl/…/T/sow-gate6-testvault-2abtAY` (benign `standup-note.md`, outside ~/Obsidian).
- **gate-6 — Step A REAL RUN = PASS.** One controlled real subscription extraction over the benign vault.

## Step A — the real run (evidence)

Verbatim `GATE6_RESULT`:
- `runOk:true` · `apiKeyUnset:true` · `costUsdMetered:$0.054601` (< the $1.50 cap; ~$0 real on subscription)
- `notePath: sources/ws-gate6-testvault/5090325d20ea3f748e7af417f3c85e79.md` (in the throwaway test vault, NOT ~/Obsidian)
- `egressProcessor:"claude-agent-sdk"` (ONLY) · `reqModel:claude-sonnet-5` · `reqBetas:[context-1m-2025-08-07]` · `reqMaxCostUsd:1.5`
- `childEnvKeys:[HOME,LANG,LOGNAME,PATH,SHELL,TERM,TMPDIR,USER]` (exactly the 8-key minimal allowlist — nothing else reached the child)
- `extractionFields:[title,task1Owner,task1Description,task1DueDate,task2Owner,task2Description,task2DueDate]` · note frontmatter `owner:TBD, dueDate:TBD` · vitest 1 passed.

### Live safety verdict (all held)
- **REQ-F-017 no-inference — HELD.** `validateNoInference` ran REAL and the run was ACCEPTED ⇒ every concrete value carried evidence (un-evidenced concrete ⇒ REJECT ⇒ no note). Frontmatter `TBD` = the no-inference sentinel, never a guess.
- **Egress rule-5 — HELD.** `egressProcessor:"claude-agent-sdk"` only; empty-allowlist DENY already proven (dry-run non-vacuity control).
- **ING-7 read-only admission — HELD.** Ran through the real broker `admitJob`; completion runs `tools:[]/allowedTools:[]`.
- **Control-var survival — CLOSED live (the gate-3 unknown).** The real `query()` spawned with env = the 8-key scrub (NO `CLAUDE_CODE_SDK_*`/IPC vars) and SUCCEEDED. Had the SDK not re-injected its own stdio/IPC control vars atop the replaced env, the IPC handshake would fail ⇒ no candidate ⇒ `runOk:false`. `runOk:true` ⇒ the SDK re-injected them. The gate-3 open real-run unknown is closed.
- **18.40 env-scrub — proven-by-construction LIVE.** `childEnvKeys` = exactly the 8-key `SUBSCRIPTION_CHILD_ENV_ALLOWLIST`; no shadow/cred/redirect/`CLAUDE_ENV_FILE` var could reach the spawn, AND the run still succeeded (login ambient via HOME + macOS Keychain). rule-5 completeness holds live.

### Execution note (safety posture)
The auto-mode classifier BLOCKED the worker's real-run command ("Blocked by classifier"). Per the session-098 fallback the worker did NOT work around it (no sandbox-disable, no re-framing) — surfaced + prepared the EXACT command, and the **owner ran it himself** in his own terminal. No Keychain popup (the `claude` grant was remembered from the 2026-07-18 maiden run). Correct safety behavior for an irreversible real-egress/spend command.

### Step B — documented owner-run follow-up (NOT run)
Owner sealed the crossing with Step A as the proof; Step B (literal 18.10 auto-watcher: `+SOW_INGEST_WATCH=1`, launch the app, drop `.md` → live auto-fire) is a documented owner-run follow-up, not run this session. A proved the safety-critical core; B only demonstrates the watcher auto-fire trigger (already proven dormant via the $0 dry-run test-3 + vaultWatcher-live). The exact owner command + the `SOW_INGEST_WATCH` / `SOW_SUBSCRIPTION_REACHABILITY_LIVE`-shell-export caveats are handed to the orchestrator for the runbook (Step-B follow-up).

## Decisions made
- **Step-A mechanism = a throwaway direct-extraction harness (not the in-app path).** Mirror the proven $0 dry-run and swap only the completion (fake → real) so the correctly-assembled `CompletionRequest` reaches the real model; drive the source-ingestion activities directly ⇒ exactly ONE controlled real `query()` spawn, all evidence in stdout, no GUI/Temporal. Matches the maiden-run precedent (session 098).
- **Reachability stubbed reachable in Step A** so the single real spawn is the extraction itself (the live reachability probe can spawn its own `query()`); the production reachability wiring is not Step-A's target.
- **Did NOT work around the classifier block** — owner-executed the real command (session-098 fallback). No bypass.

## Decisions explicitly NOT made (deferred)
- **Step B (in-app watcher auto-fire)** — documented owner-run follow-up; not run (owner's seal).
- **The frontmatter key-mapping fix** — routed to Carry-forward (below), not fixed this session.

## TDD compliance
**Clean / N/A — no new committed code.** The only artifact was the throwaway Step-A harness (a test-only file), removed after the run and never committed. No production code changed; HEAD unchanged at `a3180cc7`. This is a live-run + docs session, not a `/tdd` slice.

## Cross-doc invariant audit
**No frozen-contract (Appendix-A) model field changed** — no code changed at all. No `ARCHITECTURE.md` cross-doc-invariant edit is owed from this session. The §19.5/§ARM-18 arch note (crossing sealed; gate-3 control-var unknown CLOSED live; 18.40 proven-by-construction live) is orchestrator-territory, written at `/orchestrate-end`.

## Reachability
N/A — no new code wired. The armed extraction path's reachability was established in prior sessions (18.24/18.25/18.27/18.40; `bootWorker` → `buildProofSpineActivities` → broker schema-gate) and is now **proven live end-to-end** by the Step-A real run.

## Open follow-ups
1. **Step-9 arch note (orchestrator, `/orchestrate-end`):** §19.5/§ARM-18 — §ARM-18 CHECKPOINT-1 crossing SEALED; gate-3 control-var-survival unknown CLOSED live (`runOk:true`); 18.40 env-scrub proven-by-construction live (8-key allowlist). Retire the gate-3 "control-var survival is an open real-run unknown" caveat.
2. **Step-B follow-up (runbook):** the exact owner-run in-app auto-watcher command (`+SOW_INGEST_WATCH=1`; `SOW_SUBSCRIPTION_REACHABILITY_LIVE` must be SHELL-EXPORTED — it is NOT on the `.env` allowlist; worker child inherits main's process.env) → `docs/runbooks/phase-18-10-auto-ingest-enable-readiness.md`. Owner's call to run.
3. **Carry-forward — frontmatter↔extraction key-mapping fidelity fix (NON-safety, fail-safe).** The real model returned task-prefixed camelCase fields (`task1Owner`/`task1DueDate`) which do NOT match the frontmatter projection's expected keys (bare `owner`/`dueDate` or the L66 `^task\d+_(owner|dueDate)$` pattern — note the underscore) ⇒ they degraded to the conservative **TBD** rather than surfacing. Fail-SAFE (no invention; real values preserved verbatim in the note BODY), but the structured owners aren't projected to frontmatter. Fix = align the agent_extraction field naming ⟷ the frontmatter projection pattern (a projection-side key-mapping change or a schema field-naming convention). Orchestrator to route to Carry-forward.
4. **Worker LESSONS candidate (orchestrator):** the maiden real-run confirms the SDK re-injects its own `CLAUDE_CODE_SDK_*` control vars atop 18.40's replaced child env (the L73 corollary "confirm at the real-run gate" — now confirmed live); an env-scrubbed subscription spawn runs successfully with only the 8-key allowlist.

## How to use what was built
Nothing new to run — the throwaway harness is removed. The armed subscription-extraction path is proven live. Step B (the in-app auto-watcher) is the documented owner-run follow-up (runbook item 2 above).

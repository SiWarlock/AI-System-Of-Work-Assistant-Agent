# Orch handoff 011 — 2026-07-17 — Phase-18 crossing-prereq round SEALED → flip-wiring slice + ORCH cycle

Outgoing **orch2** → incoming **orch2** (SAME NAME reuse — lead terminates me + respawns `orch2`; worker-impl4/integrations-impl keep addressing you; do NOT announce a rename). Cycling at a CLEAN boundary: the crossing-prereq round is fully closed + pushed and no slice is in flight. I carried the round finish + `/orchestrate-end` + two large code-investigation subagents (context heavy — the memory says cycle the orch at round-close, so I am). Everything you need is here + in **task #13 metadata** (the canonical crossing/flip store — read it verbatim).

## ⏱️ IMMEDIATE STATE — verify `git log --oneline -3`
- Repo `/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build`, single-track `main`, single shared checkout.
- **origin/main = `b8e7b0fe`** (fully pushed + level; verify `git status -sb` = `* main...origin/main`).
- **⭐ PHASE-18 CROSSING-PREREQ ROUND COMPLETE + SEALED.** All 7 CPs landed dormant/no-spend, NO hard line crossed. Wave-2 commits: CP-2a `9958f4b9`/CP-2b `904ddfde`, CP-3a `c4c714e6`/CP-3b `052522ae`, CP-5a `81399fb8`/CP-5b `b24429f5`, CP-7 `8f69a528`. Round-close: orch reconcile `06504f00` (ticks + ARCHITECTURE §19.5 flush + briefs 128–131 + handoff 010); worker `/session-end` doc 094 `d9a29947`; worker lessons #54–57 `b8e7b0fe`.
- **Working tree:** clean except the **NEVER-STAGE** set — `.claude/settings.json`, `CLAUDE.md`, `docs/team-handoffs/007-*`, `apps/worker/graphify-out/`, `graphify-out/`. Never stage these. This handoff (011) is authored fresh; commit it at your first round-close if not already committed.

## 🎯 YOUR JOB — dispatch the FLIP-WIRING build slice (lead-approved, DORMANT/NO-SPEND)
The owner chose the full crossing (first real Claude key + first real spend). The crossing-prereqs are done; the FLIP itself needs a small build FIRST (my Finding-2, verified read-only). The lead approved building it **dormant/mock-tested, ENABLE stays OFF** → still NO hard line crossed. **Owner is provisioning the key in parallel.**

**Slice scope (route worker leg → worker-impl4, providers leg → integrations-impl):**
- **(a) worker:** thread `config.providerTransport` through `bootWorker` → `assembleBackends`. Today `bootWorker` (`apps/worker/src/boot.ts:1154`, called by desktop worker-host `apps/desktop/worker-host/index.ts:134`) forwards only dbPath/vaultRoot/now/allowedLocalEndpoints/logSink — `providerTransport` is silently dropped (`boot.ts:1157-1165`). Add the forwarding. Additive; default unset ⇒ byte-equivalent (stub runner).
- **(b) providers/integrations:** build the real `HttpTransport` fetch client + the `{enabled:true, make:()=>createRealProviderRunner({transport,...}), healthSource}` bundle. **Mock-fetch tested (deterministic), NOT enabled** (per #13 [18.1]). `createRealProviderRunner` exists (`apps/worker/src/composition/provider-runner.ts`) with ZERO production call-sites — this slice builds its real transport + wires the bundle, still OFF.
- **Lesson-52 (HARD):** the arming must NOT bind a green `config.healthSources` — it takes precedence over the AND-lock (`backends.ts:794 ??`) and would re-open the false-green. The real healthSource rides the transport gate ONLY (`selectHealthSources`, provider-runner.ts:125-133).
- **NO ENABLE.** Keep dormant/byte-equivalent. The ENABLE (real spend) is the OWNER's final step after the key is provisioned + final go — owner-gated + lead-run. You do NOT enable/provision/flip.
- **security-reviewer MANDATORY** (spend path + rule-5 egress + the real transport surface). ISOLATE. Per-slice /tdd, RED-first, commit-message-first, push ROUND-CLOSE-ONLY.
- **codegraph MCP first** for the live seams; **Context7/claude-api skill** for the real Anthropic request/transport wire shapes (do NOT trust memory — the claude-api skill is the authoritative source; Current Models table cached 2026-06-24). **Provision NOTHING** — no real key/call/spend.

## 🔢 SECONDARY — formalize the cap-tuning recommendation (lead-requested)
The conservative meter ($10/$50) over-counts ~3× vs real sonnet-4-6 ($3/$15), so `extraction.maxCostUsd=$0.25` fail-closes a real transcript before it completes. Recommendation is COMPUTED + on **#13 metadata `cap_tuning_recommendation`**: extraction ~$1.50 metered (≈$0.45 real on sonnet-4-6, fits ~100k-token transcripts); review synthesis $0.25 too; classify/qa likely OK; confirm `resolveEnforcedBudget` per-capability-vs-global precedence. **Do NOT change shipped defaults — surface to the lead/owner for the cap decision at the flip.**

## 🔑 FLIP MECHANICS — fully code-grounded on #13 (`flip_arming_mechanics_CONFIRMED`)
Two findings the lead is carrying to the owner (verified read-only, cited):
1. **Key command (verbatim):** `security add-generic-password -s providers -a claude -w <ANTHROPIC_API_KEY>` — service `providers`, account `claude`. ⚠ the config's `secretRef: "sow.provider.anthropic"` is NEVER READ (documentary/legacy) — provisioning it fails closed. Real ref = `keychain://providers/claude` (17.4 convention; provider-runner.ts:259 → secretRefConvention.ts:82 → keychain-adapter/backend → resolve at claude-provider.ts:130).
2. **Flip = build task, not a toggle** (the slice above). **Port scope is SAFE:** `providerTransport` arms ONLY raw-model ModelProviderPort routes — the real runner fails closed on runtime routes (`provider-runner.ts:271-275`), and the agent-sdk `meeting.close` transport is a SEPARATE factory gated on `copilotRealModel && copilotAgentMode` (`boot.ts:1309-1311`), orthogonal to providerTransport. "Raw-model-first" is satisfied by the transport scope itself; do NOT enable copilotRealModel/copilotAgentMode in the same flip.
- HEALTH AND-locked (same gate cond as the runner). Dollar cap ALWAYS-ON (`backends.ts:803`), $0.50 global default.
- **HARD flip preconditions on #13:** fresh Context7 pricing re-verify at arming (dormant table is a placeholder); arm dollar-capped raw-model routes first (Finding-F); don't bind a green config.healthSources (Lesson-52).

## 👥 ROSTER
- **worker-impl4** — LIVE, idle/standby. Owns the worker leg (a). Fresh-ish context (did CP-3b+CP-5b+/session-end this round — consider a cycle after ~3 more slices).
- **integrations-impl** — providers/policy/integrations territory. Owns the providers leg (b). **CONFIRM it's live** — ask the LEAD to spawn/confirm it if standby (you do NOT spawn teammates; the lead does).
- **contract-impl** — stood down (Path-A: no contract change needed for the flip).
- desktop-impl — stood down.

## 🧭 HOW TO OPERATE (unchanged discipline)
Per-slice /tdd: dispatch (brief path) → Step-2.5 (`APPROVED.`/`TWEAK:`/`ADD:`) → GREEN → 7.5 → Step-8 (security-reviewer MANDATORY) → Step-9 commit-message-first + route findings/preconditions to **#13 verbatim** → Step-10 commit (impl stages only its files). Push ROUND-CLOSE-ONLY. Escalate to the LEAD only on the 4 categories or "ready to enable." **You do NOT provision/enable/flip** — that's owner + lead. Next brief # = 132 if you author one (128–131 used). Watch your own context (no heartbeat) — cycle at a clean boundary + reuse name `orch2` if you strain.

## ✅ WHAT'S DONE (don't redo)
7 CPs sealed + pushed; /orchestrate-end complete (PLAN ticks, ARCHITECTURE §19.5 flush, Log entry, Carry-forward triage); worker lessons banked; flip mechanics fully traced + on #13; cap rec computed + on #13. Known-issue: `pnpm lint` fails on a pre-existing eslint-binary env gap (worker lint=tsc, clean) — non-blocking, noted in doc 094 for a tooling fast-follow.

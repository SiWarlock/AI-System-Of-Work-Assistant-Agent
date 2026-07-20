# Team Handoff 014 — Phase-18 Path-β sealed + scaffolding upgraded; full-team cycle

**Date:** 2026-07-20
**Track:** solo / single-track `main`
**Worktree:** root checkout (single-track)
**Predecessor handoff:** `013-2026-07-18-phase18-crossing-dormant-optionB-team-pause.md`
**Successor handoff:** _(filled in by the next /team-end)_
**Round-seal commit at handoff:** `7b15e6e3` (pushed; `origin/main` in sync)

## Why this handoff exists
Owner-directed **full-team cycle** after a mid-session scaffolding upgrade: the close-out commands + `IMPLEMENTATION_PLAN.md` format contract changed on disk (merge `adeb7d8a`, upgrade `2556dd23→588b7350`), so the whole team was cycled cleanly on the NEW procedure to start the next session fresh on it.

## Team composition at close
- **Lead:** this session (single-track `main`, team label `session-4f4687dd`).
- **Orchestrator:** `main-orchestrator` — sealed the round at `7b15e6e3` (`/orchestrate-end` on the new procedure: plan-lint 0 violations, clean tree, pushed); terminated.
- **Implementers:** `worker-impl` (session doc 102 `7c74869e`; 18.31/18.33) + `desktop-impl` (session doc 103 `a1b3bf45`; 18.32/18.34) — both `/session-end`-closed + terminated.
- All teammates closed at round-seal **`7b15e6e3`**. **Clean close — nothing in flight.**

## Active arc + where it landed
**Phase-18 (real ModelProvider) — this session took it from the pre-ENABLE crossing all the way through the first real go-live and then built the in-app enablement path, all landing DORMANT/owner-gated.** In order this session:
1. **Subscription-routing + arming round** → the maiden **real subscription extraction SUCCEEDED** (`rev:c416ed74`, $0.044772 metered, REQ-F-017 no-inference held live) — the SOURCE-leg go-live. `/phase-exit 18` crossing gate CLEAR; the MEDIUM shadowing-guard finding hardened (18.28, 13-key set).
2. **Auto-ingest note-projection + pre-ARM verify-pin** (18.29/18.30) — the dormant auto-ingest trigger proven SAFE (ING-7 + rule-5 tied to the auto path).
3. **Path-β desktop-arming round (SEALED this cycle, `7b15e6e3`)** — the packaged app can now assemble a **subscription-armed auto-ingest config from env**: 18.31 `dd2ceaa4` (egress-allowlist seam) · 18.32 `0d8e7c56` (desktop subscription-arming forwarding) · 18.34 `fc3031f7` (native allowlisted `.env` loading, structurally can't shadow/leak) · 18.33 `db45eb6e` (committed L64 go/no-go harness). All dormant/default-OFF — **nothing armed.**

**Phase 18 is recorded "crossing GO-LIVE (source leg) complete; full phase tick HELD" — remaining breadth is owner-gated §ARM-18.**

## In-flight at close
**None — clean close.** All 4 β slices committed + sealed + pushed; plan-lint green; tree clean (only `graphify-out/` generated artifacts untracked).

## Carry-forward to next team session
**`IMPLEMENTATION_PLAN.md` "Currently in progress" → Next target (owner call):**
- **The §ARM-18 in-app ENABLE** (owner-gated) — the app is now CAPABLE. **Run the go/no-go FIRST ($0):** `SOW_L64_DRYRUN=1 npx vitest run apps/worker/test/integration/autoIngest-armed-live.test.ts` (proves the armed path produces a real note, not spend-and-produce-nothing). Then the ENABLE preconditions: `SOW_SUBSCRIPTION_ARM=1` + `SOW_EGRESS_ALLOWED_PROCESSORS=claude-agent-sdk` + `SOW_MANAGE_TEMPORAL=true` + `SOW_VAULT_ROOT=<vault>` **AND** a worker-host-side real `checkReachable` injection (env-only arm stays HEALTH-denied by design). Readiness: `docs/runbooks/phase-18-10-auto-ingest-enable-readiness.md`.
- **OR a Carry-forward brief** (the ≤7 working set, all owner/verification items):
  1. **The SPINE arc** — connector→ingestion→content→gbrain end-to-end (§ARM-23 sub-rounds; incl. 13.10c gmail hydration).
  2. **7.19 retention-pruning — RE-OPENED** (claimed done; `retentionPrune.ts`/`prunePolicy.ts` found absent — re-implement per RET-1/REQ-F-018).
  3. **Phase-9 completion → `/phase-exit 9`** (finish 9.5, 9.9–9.12; first formal exit gate).
  4. **11.2 startup app-schema-compat REFUSAL wiring** (version-refusal check unwired).
  5. **FailureClass enum completion** (`db_unavailable` + `provider_routing_unavailable`; security members pending §DEC-CAT4 — frozen-contract/contracts track).
  6. **LIVE `/design-review`** owed (15.8 reroute control + Phase-14 Liquid-Glass, at next app-up).
  7. **ESLint configuration** (`lint` scripts are `tsc --noEmit` placeholders; `/preflight` lint gate is a no-op).

## Open decisions / blockers for the human
- **Everything next is an owner call.** All Phase-18 breadth + every arming step is owner-gated (§ARM-18); nothing arms without the owner. The four standing hard lines apply (cloud egress on raw Employer-Work · propose-flip · real external write/fetch · real API spend / paid-key provisioning).
- **The in-app auto-ingest ENABLE** (autonomous recurring subscription extraction on cadence) is the most de-risked next crossing — but it IS a crossing; run the L64 go/no-go first, then it's the owner's flip.
- **The dedicated IMPLEMENTATION_PLAN cleanup arc** the owner started separately ([[implementation-plan-cleanup-arc]]) produced the rebuilt new-format plan — now landed; the plan-lint gate is live.

## Running the app locally (owner asked this session)
`pnpm install` → `./dev.sh` (or `pnpm --filter @sow/desktop dev`). Temporal: `brew install temporal` (installed this session), then `SOW_MANAGE_TEMPORAL=true`. Native `.env` loading (18.34) hydrates ONLY the `SOW_*` allowlist — see `.env.example`. The subscription path needs `ANTHROPIC_API_KEY` UNSET + the macOS Keychain "Allow" (granted at the maiden run).

## Spawn prompts ready for the next team session
Use the `/team-start` templates (team-register.sh first action + the correct start command). WHY + WHERE only.

**Orchestrator** (`/orchestrate-start`, NOT `/session-start`):
```
main-orchestrator, SoW build, single-track main, team label session-<first8>. ARC: Phase-18 real ModelProvider — SOURCE-leg go-live SHIPPED; Path-β in-app subscription-armed auto-ingest capability BUILT + dormant + sealed (origin/main 7b15e6e3). Read IMPLEMENTATION_PLAN "Currently in progress" + §ARM-18 + handoff 014. NEXT is an OWNER CALL (lead brings it): the §ARM-18 in-app ENABLE (run the SOW_L64_DRYRUN go/no-go FIRST) OR a Carry-forward brief. NOTE the scaffolding upgraded — /orchestrate-end changed (Log→docs/archive/IMPLEMENTATION_LOG.md, one-checkbox task state, plan-lint Step-6.5 BLOCKING gate); follow the on-disk injected text. Provision/arm NOTHING — owner-gated.
```
**Implementer — worker** (`apps/worker`; `/session-start`): spawn when a worker-area brief lands (the §ARM-18 ENABLE go/no-go + worker-host `checkReachable` injection, or 7.19 retention re-impl, or 11.2 refusal wiring).
**Implementer — desktop** (`apps/desktop`; `/session-start`): spawn when a desktop-area brief lands (LIVE /design-review, Phase-9 surfaces).

## How to resume
Next team session: lead runs `/team-start`, reads THIS handoff + `IMPLEMENTATION_PLAN.md` "Currently in progress" + §ARM-18 on demand, brings the owner the §ARM-18-ENABLE-vs-Carry-forward call, then spawns the orchestrator (+ area implementers as briefs target them) via the `/team-start` templates. Everything is on `origin/main = 7b15e6e3`. ⚠ FIRST READ `docs/team-protocol.md` (the tier table WARN70/ACTION75/HARD80 — not auto-loaded on a resumed lead).

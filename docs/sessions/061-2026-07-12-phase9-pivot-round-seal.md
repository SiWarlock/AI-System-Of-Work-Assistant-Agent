# Session 061 — Phase-9 renderer non-HITL pivot round (orchestrator `orch11`) + seal + push

**Team:** `session-f2673cd5` (single-track, `main`). **Orchestrator:** `orch11` (successor to `orch9`, cycled in before the AppRouter slice). **Implementer:** `impl12` (successor to `impl10`, WARN-cycled at the task-36 boundary). **Predecessor doc:** `060-2026-07-12-impl10-pin-verify-real-and-phase9-pivot.md`.

## Why this session existed
Continue the owner-authorized Phase-9 renderer non-HITL pivot vein (lead-routed, one slice at a time), then seal + push on owner direction and pivot to C6 recon.

## What was built (orchestrator-authored briefs + reviews)
Four pivot slices, each: brief authored → `spec-lint` PASS → dispatched → Step-2.5 reviewed → Step-9 routed commit-message-first → hot-routing banked. All non-safety (renderer/typing) → code-quality review only (lead-confirmed). Repo-wide `pnpm -w turbo run typecheck test` 31/31 GREEN throughout.

- **9-a11y `5c55011`** (brief 035, landed under orch9/impl10) — roving-tabindex listboxes via shared `useRovingListbox`.
- **AppRouter typing `4ee886d`** (brief 036, impl10) — renderer tRPC client typed against `@sow/worker`'s concrete `AppRouter`; all 9 `client as any` casts dropped. Cross-package: `@sow/worker`+`@sow/db` `tsconfig.build.json` `declaration:true` + surgical `paths` in the desktop DOM tsconfigs to the built `.d.ts` (fixes the source-pull `Buffer`/`BlobPart` DOM conflict; `--explainFiles`-verified). The subscription sub-router is intentionally `AnyRouter` (TS2742) → bridged with a typed adapter, not `any`.
- **§9.7 triage-resolution ACTION UI `d4f38cf`** (brief 037, impl12) — `command.disposeTriage` (already built) wired from the Ingestion Inbox; `createTriageDisposition` mirrors `createApprovalDecision`; deterministic replay-safe idempotency key `${sourceId}:${disposition}`; drain-on-ok / fail-closed.
- **ScopeSwitcher popup keyboard loop `1110024`** (brief 038, impl12) — focus-on-open + return-focus-to-trigger (keyboard-close only) + reset-on-open via the shared hook's optional `open`; MED flag-lifecycle leak (closed-Escape → later non-keyboard dismissal wrongly returns focus) caught+fixed (arm-only-while-open).

## Decisions made
- **§9.4 recon-before-dispatch Finding.** The lead authorized §9.4 (Global Today GclProjection) off a stale carry-forward flag. orch11's pre-dispatch recon proved §9.4 was **already built + security-reviewed clean in session 015** (all commits in main; surfaces present). → NO rebuild; stale docs reconciled to DONE. Recon-before-build prevented a redundant rebuild of a security-reviewed safety-critical slice.
- Pivot slices lead-routed one-at-a-time; non-safety renderer slices → code-quality review only.
- Lessons banked desktop area-local (`apps/desktop/LESSONS.md` §5/§6/§7) per lead framing ("desktop 5/6/…").

## Decisions explicitly NOT made (owner-gated / deferred)
- The propose bridge (`copilotProposeMode`/`copilotProposeKnowledge`) stays OFF — mutating skill exposure is the HARD LINE; not flipped.
- Packaging/notarization, secrets/Keychain provisioning, write-through GO — all owner-gated HITL, untouched.
- The desktop-a11y-lesson-split canonical-home reconciliation (`contracts/#22` vs `apps/desktop/LESSONS.md`) — deferred to a future close-out (bookkeeping).

## Open follow-ups
- **C6 Copilot skills RECON (owner-directed, NEXT) — do NOT build.** Surface the skill/tool-exposure machinery + a per-skill-classified read-only-vs-mutating tiered menu; lead takes which-skills/tier to the owner.
- Carry-forward: §9.7 triage 3 deferred follow-ups (cross-disposition in-flight race → shared Approvals+triage in-flight-disable; disposition-taxonomy arch_gap; reject-path coverage nit). ScopeSwitcher a11y fast-follow now DONE.
- Standing multi-phase Carry-forward backlog (over ~7 cap — inherited; not force-drained this seal).

## Seal
Round terminal commit (this doc + briefs 036/037/038 + IMPLEMENTATION_PLAN Log/ticks/reconciliation + `apps/desktop/{LESSONS,CLAUDE}.md` §5–7). **PUSHED** to `origin` (owner-authorized). Never-stage trio (`.claude/settings.json`, root `CLAUDE.md`, `graphify-out/`) kept local.

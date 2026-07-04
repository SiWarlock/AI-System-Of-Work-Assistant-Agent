# RESUME HANDOFF — post-§9.6-Copilot (pick the next track)

> **PROSPECTIVE handoff** (written for the next session, post-compaction). Predecessor: `025-2026-07-04-copilot-qa-end-to-end.md`. Successor: `027-2026-07-04-approvals-page.md` (Track picked: 9.8 Approvals page — DONE; real Copilot model path queued next).
> §9.6 Copilot Q&A is DONE end-to-end + pushed. The owner's "b-d" queue is complete (b = Copilot ✅ sess 025 · c = recent_changes interim ✅ sess 023 · d = UI test harness ✅ sess 022). "Whatever is next" is now genuinely open — this doc lays out the candidate tracks so the next session can confirm one with the owner and start.

---

## ▶ RESUME PROMPT (paste this to start the next session)

```
Continue the System of Work Assistant BUILD. §9.6 Copilot Q&A is DONE end-to-end + pushed
(HEAD 99ae305 on origin/main); the "b-d" queue is complete. Before building, CONFIRM the next
track with me via AskUserQuestion — the candidates (detail in docs/sessions/026-2026-07-04-
RESUME-post-copilot.md):

  1. REAL Copilot model path (the deferred follow-up from §9.6). Swap the interim fixture
     retrieval + stub synthesis for real GBrain/GCL retrieval + real governed LLM synthesis
     through AgentRuntimePort/ModelProviderPort. MUST wire guardCopilotEgress at route selection
     with the AUTHORITATIVE Workspace posture (resolved by workspaceId, NEVER client input),
     bound the question length in the synthesis path, add Global-Copilot-via-GCL, and the live
     propose→Approvals flow. Then the model-prose EVAL (retrieval grounding + citation
     correctness) against a real provider + a labeled corpus. NOTE: the app runs over injected
     stubs (no real vendor I/O) — a "real" model path likely means a local zero-egress provider
     (Ollama/LM Studio) + real GBrain, OR bringing up real vendor I/O first.

  2. The next 9.x DEDICATED PAGE (each mounts on the AppShell/Route foundation: add a Route
     variant + a NavLink + a surface component). Highest-value candidates: 9.8 Approvals
     (Mac+Telegram parity, the single idempotent transition — also unblocks Copilot's
     propose→Approvals), 9.7 Ingestion Inbox + triage, 9.10 System Health (already partly
     store-driven), 9.9 Calendar. All read UI-safe projections; most need a worker read-model
     + a query procedure (mirror query.recentChanges / query.projectList).

  3. c-REAL: the audit-driven recent_changes + real project-sync projectors (the interim
     dev-provisioner shipped sess 023). BLOCKED — needs an owner decision (3 options: interim /
     add-workspaceId-to-AuditRecord / bring-up-Temporal) + Temporal running. Surface the
     decision before starting.

Read first: THIS doc + docs/sessions/025-…-copilot-qa-end-to-end.md, then the relevant
ARCHITECTURE.md/PRD section for the chosen track. HEAD 99ae305 (pushed to origin/main).

Method (standing): TDD for deterministic/security slices (failing test first); LLM/model-driven
work is EVAL-tested via packages/evals (you cannot unit-test model prose). Commit per slice
(explicit git add <path>, never -A; Conventional Commits + Co-Authored-By: Claude Opus 4.8 (1M
context) <noreply@anthropic.com>); ultracode; dispatch security-reviewer + code-quality-reviewer
per security-touching slice (code-quality every-slice); run REPO-WIDE `pnpm -w turbo run
typecheck test` after any PORT/CONTRACT change (cross-package consumers like @sow/evals — it bit
A4). New UI-safe contract = the allowlist + .strict() + Exact<> + freeze-test recipe. Don't touch
the parallel session's files (youtube-source/capture-source/PHASE-13). Push at close-out.
```

---

## Current state — DONE + PUSHED (do NOT rebuild)

**HEAD `99ae305` on `origin/main`.** §9.6 Copilot Q&A shipped end-to-end (session 025, 8 slices `761f312`…`08cbf6e` + close-out `99ae305`, 16 subagent reviews, 0 critical/high). Repo-wide `turbo typecheck test` **31/31**; desktop 149 · worker 387 · contracts 629 · evals 148.

Copilot full path (all wired + tested): `Copilot` composer → `App.onAskCopilot` → `live.askCopilot` → `query.copilotAsk` → `answerCopilotQuestion` (retrieve → `enforceRetrievalScope` → synthesize → `toUiSafeCopilotAnswer` gate) → cited answer turn. Built per the LOCKED design as the **expandable right sidebar** (owner-confirmed via AskUserQuestion — NOT a nav page).

**Key new surfaces this round (reuse them):**
- `apps/worker/src/api/procedures/copilot.ts` — the Copilot backend: `CopilotRetrievalPort` + `enforceRetrievalScope` + `createFixtureRetrieval` (interim); `CopilotSynthesisPort` + `guardCopilotEgress` (reuses `@sow/providers` `vetoJobEgress`) + `createStubSynthesis`; `toUiSafeCopilotAnswer` (candidate-data gate) + `answerCopilotQuestion`. **The real adapters swap in behind these ports.**
- `packages/contracts/src/api/ui-safe.ts` — `UiSafeCopilotAnswer` / `UiSafeCitation` (the leakage-gate seam; no contract change needed for the real path).
- `apps/desktop/renderer/store/scope.ts` — `resolveWorkspaceId` (ASK-direction fail-closed gate; ≠ `isWorkspaceScope`).
- `apps/desktop/renderer/surfaces/copilot/Copilot.tsx` + `lib/copilot-ask.ts` — the live composer + client glue.
- `apps/desktop/renderer/chrome/AppShell.tsx` + `store/route.ts` — the AppShell/Route foundation (mount a new page = a Route variant + a NavLink + a surface).
- `packages/evals/test/conformance/copilot-governance.test.ts` — the governance battery (extend it for the real path).

## The deferred Copilot follow-up (track 1 detail)

Pinned in code (`copilot.ts` EGRESS NOTE) + IMPLEMENTATION_PLAN Trims. The governance is DONE + tested; the follow-up swaps interim adapters behind the existing ports:
1. **Real retrieval** — GBrain/GCL passage retrieval (needs a passage-serving read-model; none exists). Replace `createFixtureRetrieval`.
2. **Real synthesis** — through AgentRuntimePort/ModelProviderPort. MUST call `guardCopilotEgress` at route selection with the **authoritative Workspace record** (type + egress policy by workspaceId, NEVER client input — a mislabel would slip the veto). Default to a LOCAL zero-egress provider (the app has no real cloud I/O). Bound the `question` length here.
3. **Model-prose EVAL** — retrieval grounding + citation correctness, real provider + labeled corpus (PRD §20.1 / EVAL-1 floors ≥30 retrieval queries). Documented in the A6 header.
4. **Global-Copilot-via-GCL** — today Global fail-closes to "pick a workspace"; the §9.6 task wants sanitized-global via the GCL Visibility Gate.
5. **Live propose→Approvals** — needs the 9.8 Approvals page + synthesis emitting a proposal (today the proposal row is a disabled affordance).

## Load-bearing reminders (any track)

- **Safety invariants** (root CLAUDE.md, verbatim): one-writer / candidate-data gate / external-write envelope / WS-8 isolation / Employer-Work egress veto (OpenRouter is its own processor; no cloud fallback) / ING-7 tool-stripping / secrets via SecretsPort.
- **The app runs over INJECTED STUBS** — no real vendor I/O, boots Temporal-degraded, EVAL-1 corpora absent. "Real" work over stubs is honest-interim; surface it as such.
- **Route ≠ scope** (scope gates DATA, route selects SURFACE); the AppShell + Route model unblock all 9.7–9.14 pages.
- **Unicode-in-regex trap** (bit A6): a literal U+2028/2029 in a regex source terminates the line — use a charCode Set, not a regex literal (mirrors the write-side `collapseToSummaryLine`).
- **Don't re-litigate the LOCKED design** (`docs/design/ui-ux/material-direction.md` + mockups). When the plan/handoff conflicts with the lock, the LOCK wins — surface via AskUserQuestion.

## Build/run + test reference

- `pnpm --filter @sow/desktop dev` — Electron + spawned worker; `devProvision` on → real Projects/Recent-activity + an honest "nothing found" Copilot.
- Per-package `pnpm --filter @sow/<pkg> typecheck && test`; **repo-wide `pnpm -w turbo run typecheck test`** after any port/contract change. Render tests: `test-dom/*.test.tsx` (jsdom). Eval/conformance: the `packages/evals` harness.

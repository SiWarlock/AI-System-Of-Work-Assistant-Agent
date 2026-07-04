# Session 023 — c: interim workspace-scoped recent_changes projector + a shared summary normalizer

- **Date:** 2026-07-04 · **Mode:** single-operator (build) · **Tracks:** worker · contract
- **Predecessor:** `022-2026-07-04-docpack-and-ui-test-harness.md` (HEAD at start `a0d8d70`)
- **Successor:** `024-2026-07-04-RESUME-copilot.md` (the 9.6 Copilot build handoff — B shell then A backend)
- **HEAD at close:** `<round-commit>` · **1 slice commit** (`0dc8d4a`)
- **Gate at close:** repo-wide `turbo typecheck test` **31/31**; contracts 52/52; worker provisioner 10/10.
- **Reviews:** 2 subagent reviews (security + code-quality). Both caught the SAME real defect (write-side normalizer didn't cover the full newline family the read gate rejects) — **fixed in-slice** via a shared normalizer. No critical/high after the fix.

## Why this session existed

Owner directive: *"let's do c then b."* **c = real recent_changes + project projectors.** On scoping,
c turned out to rest on a **broken premise** (surfaced to the owner): recent_changes has no writer,
its intended source (audit records) has **no `workspaceId`** (an arch_gap) and is written **only
inside Temporal activities** (the app boots Temporal-degraded), and the "real project projector" IS
the `projectSync` **Temporal workflow** — all gated on Temporal running + an audit workspace-scoping
decision. Surfaced 3 options to the owner (interim / add-workspaceId-to-audit / bring-up-Temporal);
owner away → proceeded with the **recommended unblocked interim**. **b (Copilot) is NOT in this
session** — a retrieval + governed-LLM + citation subsystem (eval-tested), scoped as a focused
follow-up.

## What was built (1 slice, `0dc8d4a`)

- **`buildSyncRecentChange`** (pure, exported, TDD) — builds a real workspace-scoped recent-change from a dev-provisioned project sync: stable `changeId` per (workspace, note) so a re-provision UPSERTS; `kind: "project-synced"`; `occurredAt` = the sync instant; summary = `<title> — synced <n>/<m> tasks (<p>%)` normalized.
- **`upsertRecentChangeRow`** — UPSERT by changeId into the workspace's `recent_changes` read-model, preserving siblings; same not-found-vs-store-fault discipline as `upsertProjectRow`. Wired into `provisionDevWorkspace` after the project-dashboard write.
- **`collapseToSummaryLine`** (NEW shared contract helper, `@sow/contracts`) — co-located with the `uiSafeSummaryLine` gate so the write-side normalizer and the read-side validator **cannot drift**. charCode-based (a plain `\s` class misses **U+0085/NEL**); neutralizes the exact newline family + clamps to the 1024 cap. **This is the fix** for the reviewer-found defect: without it, a title with U+0085 or >1024 chars fails the read-side parse and — because `sanitizeRecentChanges` fails the WHOLE list on one bad row — blanks the entire Recent-activity surface.

### Files
- **Modified:** `packages/contracts/src/api/ui-safe.ts` (`collapseToSummaryLine`); `packages/contracts/test/api/ui-safe.test.ts` (its test — full newline family incl. U+0085 + cap); `apps/worker/src/composition/provisionDev.ts` (projector + wiring + uses the normalizer); `apps/worker/test/provision-dev.test.ts` (buildSyncRecentChange + end-to-end read-back + clamp).

## Decisions made

- **Interim over the audit-driven projector** — the audit path is genuinely blocked (Temporal + audit-scoping); the dev-provisioner interim is real, workspace-scoped, unblocked, and honest (like the doc-pack scaffold). Surfaced the blocker + options to the owner rather than inventing an audit workspace-tagging convention.
- **A SHARED normalizer in contracts, not an inline write-side collapse** — co-located with the gate so the two can't drift; reusable by the eventual real audit-driven projector. charCode-based to sidestep the U+0085/regex-escape trap entirely.

## Decisions explicitly NOT made (deferred / surfaced)

- **The audit-driven recent_changes projector** — needs (i) audit records to carry `workspaceId` (or a ref convention) and (ii) Temporal running so audit data flows. An owner decision (3 options surfaced).
- **The real project-sync projector** — the `projectSync` Temporal workflow; needs Temporal running (dev-provisioner is the interim).
- **b — 9.6 Copilot Q&A** — retrieval + governed-LLM-synthesis + citation backend (eval-tested); a focused session.

## TDD compliance

- `buildSyncRecentChange` (stable id / single-line / clamp) — test-first. ✓
- `collapseToSummaryLine` (full newline family incl. U+0085 + 1024 cap) — test-first (RED then GREEN). ✓
- The end-to-end read-back (WS-8 fail-closed for an unprovisioned workspace) — pins the wiring. ✓

## Reachability

- `buildSyncRecentChange` / `upsertRecentChangeRow` — reachable from `provisionDevWorkspace` (dev boot). `collapseToSummaryLine` — used by the projector; exported for the future real projector.
- The Today "Recent activity" (wired session 019) now renders these rows under a workspace scope with devProvision on. No tested-but-unwired code.

## Open follow-ups

- **[owner — b] 9.6 Copilot Q&A** (retrieval + LLM + citations; eval-tested).
- **[owner — c/next] audit-driven recent_changes** (needs audit `workspaceId` + Temporal) and the **real project-sync projector** (needs Temporal). The interim stands until then.
- Inherited: the doc-pack Drive live path; D2 gated global; live push for recent/projects; a11y; shared `workspaceScopedRead<T>`.

## How to use what was built

Run with `devProvision` → a workspace scope's Today "Recent activity" shows a real "project-synced"
row per provisioned note. Re-provisioning upserts (stable id). The `collapseToSummaryLine` helper is
the canonical way any future projector produces a servable `summary`.

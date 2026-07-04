# Session 027 — §9.8 Approval Inbox (Mac), page-mount

- **Date:** 2026-07-04 · **Mode:** single-operator (build) · **Tracks:** desktop (primary) · worker · evals (consumer fix)
- **Predecessor:** `026-2026-07-04-RESUME-post-copilot.md` (resume handoff — pick the next track)
- **Successor:** `028-2026-07-04-real-copilot-P1-egress-governance.md` (Track 2 real Copilot — Phase 1)
- **HEAD at close:** `eca2660` · **5 slice commits** (`770f2f0` S1 · `0a55ac7` S2 · `7925995` S3 · `78d1d09` S4 · `eca2660` S5)
- **Gate at close:** repo-wide `turbo typecheck test` **31/31**; desktop 169 · worker 391 · contracts 629 · evals 148.
- **Reviews:** 6 subagent reviews (security ×2 on the invariant-touching S2/S3; code-quality ×4 on S2/S3/S4/S5). **0 critical/high anywhere;** every medium/low fixed in-slice.

## Why this session existed

The owner picked the next track from the 026 resume menu: **an Approvals page** (Track 2's prerequisite) **plus the real Copilot model path** (queued next). Investigation up front showed §9.8's entire backend already existed — the `approvalMachine` state machine, the `approvalCommands` idempotent-transition command, `query.approvalInbox`, and the `UiSafeApproval` contract were all built + tested — so §9.8 was a clean **page-mount** (Route variant + surface + client glue), not a from-scratch feature, and the highest-value/lowest-risk choice. It also **unblocks §9.6 Copilot's deferred propose→Approvals flow**.

## What was built (5 slices)

| Commit | Slice | Summary |
|---|---|---|
| `770f2f0` | S1 (desktop) | **Route variant + global-inbox reducer.** `{ surface: "approvals" }` on the `Route` union (id-less, like Today) + `hydrateApprovals` (bulk-upsert by id; seeds the inbox from a cold-load snapshot AND folds the authoritative post-decision record). The store already held the `approvals` Map + the `approval.update` stream reducer. |
| `0a55ac7` | S2 (worker) | **UI-safe decision return (leak fix).** `command.decideApproval` returned the RAW `Approval` (carrying `actor` + `payloadHash`) to the renderer; projected it through the already-frozen `toUiSafeApproval` → new `UiSafeApprovalDecisionResult { approval: UiSafeApproval; applied }`. Also retargeted a now-stale `@sow/evals` cast (the documented cross-package gotcha, caught by the repo-wide gate). |
| `7925995` | S3 (desktop) | **Client decision glue + cold-load.** `createApprovalDecision` (fixed `mac` channel; err/transport → `{ok:false}`; **re-validates every worker record via `UiSafeApprovalSchema.safeParse` — defense-in-depth mirroring the stream path**). `hydrateApprovalInbox` seeds the GLOBAL inbox by fanning `query.approvalInbox` over the workspace scopes (WS-8-safe). Dev-seed samples for the no-worker demo. |
| `78d1d09` | S4 (desktop) | **The Approvals surface.** PENDING action cards (Approve/Reject/Defer) + a DISPLAY-ONLY "Snoozed" section (the state machine only allows `deferred→pending|expired`, so deferred items are not actionable here). Terminal items drop out of the inbox. Empty + offline-disabled states. Native styling. 7 jsdom render tests. |
| `eca2660` | S5 (desktop) | **Mount + wiring.** The static Approvals nav item → a routable `NavLink` with a DYNAMIC pending-count `badge`; App renders `<Approvals>` on route + folds each decision's authoritative post-CAS record; the decide buttons gate on a REACTIVE `hasLiveWorker`. +2 AppShell tests. |

### Files
- **Created:** `apps/desktop/renderer/surfaces/approvals/Approvals.tsx`, `apps/desktop/renderer/lib/approval-decision.ts`, `apps/desktop/test/renderer/approval-decision.test.ts`, `apps/desktop/test-dom/approvals-page.test.tsx`.
- **Modified:** `apps/desktop/renderer/{App.tsx, chrome/AppShell.tsx, lib/live.ts, store/route.ts, store/projections.ts, dev/seed.ts, styles.css}` + `test/renderer/{route,projections,fixtures}.*` + `test-dom/app-shell.test.tsx`; `apps/worker/src/api/procedures/commands.ts` + `test/api/commands.test.ts`; `packages/evals/src/worker-api-auth/exactly-once-suite.ts` (consumer-drift fix).

## Decisions made

- **GLOBAL inbox by design** — the frozen `Approval` (and `UiSafeApproval`) carries no `workspaceId` (plan carry-forward 129 a-3), and `UiSafeApproval` carries only ids + status + channel + timing, so ONE cross-scope inbox is WS-8-safe by construction (no "pick a workspace" state, unlike Projects/Copilot). Workspace-filtering is the contract-enrichment follow-up.
- **Deferred items are display-only** — the domain `APPROVAL_TRANSITIONS` only allow `deferred→pending|expired`; offering approve/reject on a deferred item would be an illegal transition. Only PENDING items get action buttons.
- **The renderer re-validates worker responses on ALL ingress paths** (stream + cold-load fan-out + decision fold) — the security low from S3; a leaky record from a future server-projector regression is dropped, not folded.
- **Reactive `hasLiveWorker` gate** (not `connection === "live"`) — the dev-seed forces `connection="live"` with a null handle; gating buttons on `connection` rendered enabled-but-no-op controls (the S5 medium). The reactive signal disables them honestly.
- **Reuse the existing `toUiSafeApproval` projector** for the decision return — the single frozen leakage boundary; no bespoke projection.

## Decisions explicitly NOT made (deferred — owner-visible)

- **`UiSafeApproval` enrichment** — `targetSystem` + a sanitized action summary + `workspaceId` (needs an `actionRef`→`ProposedAction` read-model join) so cards are richer AND workspace-filterable. The current card shows the opaque `actionRef` + status + channel + timing.
- **The `edit` decision UI** — a payload editor; without it, exposing a bare "Edit" (→ terminal `edited`) is misleading, so only Approve/Reject/Defer are offered.
- **An explicit client-visible "already resolved" message** — a stale-card decision currently folds to a safe no-op / drops on the authoritative-record fold; the exactly-once (never-a-2nd-apply) is enforced + tested server-side.

## Owner steer captured for the NEXT track (real Copilot)

Two mid-session steers (memory `sow-copilot-real-model-direction`): (1) the real Copilot will **probably use a NON-LOCAL cloud model**, and Employer-Work → cloud is **fine WITH A VISIBLE NOTICE** (egress-ack ON + a consent notice, NOT fail-closed); (2) Copilot should have **tool/skill access** → it becomes a **governed agent** (ToolPolicy / ING-7 / propose→Approvals — which §9.8 now unblocks). Both are Track-2 design inputs, not §9.8 changes.

## TDD compliance

- Deterministic slices test-first (RED→GREEN): S1 (route + reducer), S2 (worker boundary — RED confirmed the raw `actor`/`payloadHash` leak), S3 (client glue folds + the `.strict` drop-leaky-record). S4/S5 render-tested (jsdom tier, LESSONS §4). ✓
- No TDD violations. The one residual: `App.tsx`'s wiring layer is not render-tested (excluded from the jsdom tier by LESSONS §4 — `import.meta.env`); covered via AppShell tests + typecheck. The S5 medium (a wiring bug) is exactly the class an App-level test would catch — a documented, pre-existing residual gap, not new.

## Reachability

Full path wired + tested: `AppShell NavLink` (surface="approvals") → `navigate` → `route` → `App` renders `<Approvals>` → `onDecide` → `App.onDecideApproval` → `live.decideApproval` → `createApprovalDecision` → `command.decideApproval` → `answer` → `hydrateApprovals` fold. Plus cold-load `hydrateApprovalInbox` fan-out + the `approval.update` stream + the pending-count badge. Reachable.

## Open follow-ups

- **[owner/next] The real Copilot model path** (Track 2) — the queued second half of this session's ask; design inputs captured in memory `sow-copilot-real-model-direction`. §9.8 unblocks its propose→Approvals piece.
- `UiSafeApproval` enrichment (targetSystem + summary + workspaceId); the `edit` payload editor; the explicit "already resolved" message (all documented in the §9.8 task block).
- Inherited (unchanged): the §4.5 doc-pack Drive live path; audit-driven recent_changes + real project-sync projectors; the other 9.7/9.9–9.14 pages; Global-Copilot-via-GCL; packaging.

## How to use what was built

Run with a live worker → the Approvals nav item shows a pending-count badge → click it → Approve/Reject/Defer each pending card (a single idempotent transition; the item transitions in place — approved/rejected drop it, defer moves it to Snoozed). In dev-without-worker, the sample seed populates the inbox with the buttons DISABLED (honest — no worker to decide). Deferred items show their re-surface date and offer no action (they re-surface to pending on snooze expiry).

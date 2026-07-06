# Session 039 — §9.8 approvals inbox workspace-scoping (owner "do all 3" — blocker 1 of 3)

- **Date:** 2026-07-05 · **Mode:** single-operator (build, ultracode) · **Tracks:** contract + db + worker + desktop
- **Predecessor:** `038-2026-07-05-phase-c-c5-propose-tool-live-wiring.md`
- **Successor:** _(next — C5.4b provenance-stamping, then C6 skills — the other 2 of the owner's "do all 3")_
- **HEAD at close:** `f57a5a5` (pushed). Prior this session-arc: the `docs(runbooks) 4a5bada` go-live gate.
- **Gate at close:** repo-wide `turbo typecheck test` **31/31** (41 files across 7 packages). Security-reviewed clean (no crit/high).

## Why this session existed

The owner answered the "what next" AskUserQuestion with **"do all of them, start with this, use workflows where possible."** "This" = the §9.8 approvals inbox workspace-scoping (top option) — one of the two propose go-live blockers. "Do all 3" authorized the frozen-`Approval`-contract change the scoping needs.

## The design workflow (ultracode)

Ran a **survey → design → 4-adversarial-verifier** Workflow (`wf_4c9ffc6d-ae8`, 9 agents, 0 errors). It established: **contract-change is the ONLY viable approach** (the Approval row has no workspace attribution to filter on, and the DB column-parity guard recomputes columns from `ApprovalSchema.fieldSet()` — a column without the contract field turns the suite red). Crucial finding: **the renderer needs ZERO change and the global inbox is PRESERVED** — `live.ts hydrateApprovalInbox` already fans `query.approvalInbox` over the 3 known scopes and unions by id; today that "works by accident of the leak," after the fix the 3 calls return DISJOINT partitions whose union is the same set (now WS-8-safe). **No design reversal.** The 4 verifiers caught 4 concrete corrections (all folded — below).

## What was built (one atomic round, 41 files)

- **Frozen `Approval` seam:** added a REQUIRED branded `workspaceId` — Zod model + `ApprovalInput` + regenerated `schemas/approval.schema.json` (via `UPDATE_SNAP=1`) + hand-edited `__snapshots__/approval.snap` (workspaceId last, alpha) + `ARCHITECTURE.md` Appendix A + the `packages/contracts/CLAUDE.md` cross-doc table + the `valid.ts` fixture + the contracts & workflows drift-guard field-set pins. An unscoped Approval is now unrepresentable.
- **DB (dual-dialect):** `workspaceId` column both dialects (`.notNull().default(UNASSIGNED_WORKSPACE)` sentinel) + additive migration `0001_approvals_workspace_id.sql` (both) + new `listByStatusAndWorkspace` on the interface + both adapters + `toApproval` mapping. `CURRENT_SCHEMA_VERSION` 1→2 + the `0.2.0` compat row. **Migration gotcha:** the stale `0000` meta snapshot made `drizzle-kit generate` bundle 4 unrelated `CREATE TABLE`s into `0001` (genesis already creates them) — **stripped `0001` to only the `ALTER`** so it applies cleanly atop genesis.
- **Write paths (4, all server-authoritative):** recordPending activity (`ctx.workspaceId`), Copilot sink (**the RAW `workspaceId` param** — correction #1, same value used to derive the id + queried by readModel, NOT `ws.value.id`), meeting-close recordPending (`meetingJobInputs.workspaceId`), transition carry-forward (`current.workspaceId`, immutable — `applyTransition.set()` OMITS workspaceId, CAS untouched).
- **Read:** `readModel.pendingApprovals` → `listByStatusAndWorkspace("pending", workspaceId)`.
- **Renderer:** ZERO functional change. Added a comment + regression test pinning that the `approval.update` stream fold is INTENTIONALLY global (WS isolation lives in the content-free `UiSafeApproval` projection, not the stream) so a future scoped-inbox author must scope-guard it too.
- **Port-interface ripple:** `listByStatusAndWorkspace` added to every `ApprovalRepository` fake (workflows `InMemoryApprovalRepo`/`FaithfulApprovalRepo`, the copilotProposeSink fake) + `workspaceId` added to ~10 Approval test fixtures across worker/workflows/knowledge/evals.

## The 4 workflow corrections (folded)

1. **write-key===read-key** — the Copilot sink stores the raw `workspaceId` param (not the registry-resolved `ws.value.id`), so a future canonicalization can't diverge write-key from read-key → fail-closed-exclude a card from its own inbox. + a round-trip test.
2. **Slice-1 gate** — ran `@sow/domain` (the `validApproval` fixture meta-test lives there, not `@sow/contracts`).
3. **stream-layer residual** — the query leak closes but the `approval.update` broadcast stays global; documented + regression-pinned (see Renderer).
4. **version-compat** — bumped `CURRENT_SCHEMA_VERSION` + fixed `version-compat.test.ts` self-consistency (resolve the CURRENT row, not `[0]`) + added an old-app-opens-v2 tolerance test + **honestly flagged the forbidden-#4 version-guard as UNWIRED** (pre-existing gap, not claimed closed).

## Security review — CLEAN (no crit/high)

Leak **CLOSED end-to-end** (query-layer equality scoping + no residual unfiltered caller + content-free `UiSafeApproval` on both pull + stream); migration **backward-safe** (additive ALTER, sentinel default, no genesis collision, name-based column mapping, mandatory backup lifecycle present); write-key===read-key confirmed for all 4 sites; CAS intact. **Core proof green:** the A-excludes-B leak-fix test + the fail-closed sentinel-excluded test.

## Decisions made

- **Contract-change (not read-model-only)** — the only viable approach (verifier-confirmed).
- **REQUIRED + branded `workspaceId`** — mirrors every sibling scoped seam; makes an unscoped Approval unrepresentable (fail-closed).
- **Stripped `0001` to the ALTER only** — the stale genesis snapshot's drift is a separate pre-existing issue, out of scope.

## Open follow-ups (all DEFER — from the security review)

- **[medium — tracked follow-up]** worker forbidden-#4 version-guard half is UNWIRED (`assertSchemaCompatible` has no production caller; `openDatabase` applies migrations with no preceding compat gate). Pre-existing; this slice ships the first real forward migration (v1→v2) so the gap is materially live for the first time, but the 0001 migration is additive+backward-tolerant so the destructive scenario the guard protects doesn't apply. **Wire the boot compat gate before the next NON-additive migration.**
- **[low]** read `workspaceId` is client-supplied to `approvalInbox`/`ingestionInbox` — safe under the single-local-user trust model (documented global-inbox design; `resolveKnownWorkspace` fail-closes + UiSafe projection).
- **[low]** `approvals.create()` relies on the branded TS type, not a runtime `ApprovalSchema.parse` at the create boundary — fails CLOSED (no leak); optional hardening.

## TDD compliance

Clean. RED-first: the A-excludes-B leak proof + fail-closed sentinel test (readModel), the write-key===read-key round-trip (sink), the required/empty-workspaceId contract cases. Migration validated by the dual-dialect `lifecycle.test.ts` (0000+0001 applied from empty). No violations.

## Reachability

`answerCopilotQuestion`/§9.8 flow → `readModel.pendingApprovals(workspaceId)` → `listByStatusAndWorkspace` (scoped) → `projectApprovals`→`toUiSafeApproval` (content-stripped) → tRPC → renderer global inbox (unions the 3 scoped queries). Live + wired; the scoping is on the live read path.

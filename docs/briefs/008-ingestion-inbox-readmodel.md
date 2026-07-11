# /tdd brief — ingestion_inbox_readmodel (task 9.7 — dedicated ingestion read-model + UiSafe contract, empty-until-producer)

## Feature
Replace the misleading placeholder (`query.ingestionInbox` currently ALIASES `approvalInbox` → returns `UiSafeApproval[]`) with a DEDICATED task-9.7 ingestion-inbox read path: a new non-seam `UiSafeIngestionItem` UI-safe projection contract + a WS-8-scoped `query.ingestionInbox(workspaceId) → UiSafeIngestionItem[]` read-model that re-validates each row fail-closed. Ships **empty-until-producer** — mirroring how `recentChanges`/`projectDashboards` shipped read-first (the read path is real; the write-time producer that populates the ingestion read-model row when a source parks in `queued_for_review`, plus the desktop surface mount, are named FOLLOW-UPS). This establishes the ingestion inbox's correct shape + removes the wrong approvals alias.

## Use case + traceability
- **Task ID:** 9.7 ingestion-inbox read-model (the "Rank-2" Next-session-target). Phase-9 surface backend.
- **Architecture sections it implements:** `ARCHITECTURE.md §10` (Local App API — read-model serving surface) + `§11` (Electron Desktop UI — UI-safe read surface) + safety rule **4 (WS-8 workspace isolation)** + the candidate-data/leakage discipline (rule 2). (The ingestion-triage inbox *originates* in Temporal Workflows — the deferred producer side; this slice implements only the §10/§11 read-model + UI-safe-contract surface.) Implementer confirms the §10/§11 ingestion-inbox anchor at Step 0.
- **The proven MIRROR (research-mapped):** the 9.8 approval-inbox read path — `ReadModelQueryPort.approvalInbox` (`apps/worker/src/api/procedures/queries.ts:104-111`), the `query.approvalInbox` procedure (`queries.ts:467-472`), `projectApprovals`/`toUiSafeApproval` (`queries.ts:241`, `apps/worker/src/api/projections/uiSafe.ts:53-69`), `UiSafeApproval` + `UiSafeApprovalSchema` + `_uiSafeParity` + `UI_SAFE_ALLOWLIST.approval` (`packages/contracts/src/api/ui-safe.ts:109/127/466/487`), WS-8 via `resolveKnownWorkspace` + `listByStatusAndWorkspace` (`apps/worker/src/api/adapters/readModel.ts:391-404/292-304`). **For the empty-until-producer shape, mirror `recentChanges`/`projectDashboards` instead** (`readRecentChanges` `readModel.ts:210-231`; `sanitizeRecentChanges` `queries.ts:308-332`).
- **The item's source model:** `SourceEnvelope` (FROZEN Appendix-A seam — project FROM it, do NOT change it) `packages/contracts/src/models/source-envelope.ts:21-41`; the parked state `queued_for_review` (`packages/domain/src/state/source.ts:16`).

## Scope boundary (IN vs deferred)
- **IN (this slice):** the `UiSafeIngestionItem` non-seam contract + the dedicated `query.ingestionInbox` read-model + DB adapter + fail-closed re-validation + WS-8 scoping + updating the 3 test fakes; replacing the `ingestionInbox=pendingApprovals` alias. Ships empty-until-producer.
- **DEFERRED (named follow-ups — record, don't build):** (1) the **write-time ingestion-inbox PRODUCER** — a projector that writes the `read_models` ingestion row when 7.7 parks a `SourceEnvelope` in `queued_for_review` (this + parked-source persistence is bigger than one slice; there is NO listable parked-source store today — only `ParkedSourceReader.read(sourceId)` by-id, fake-only). (2) the **desktop `hydrateIngestionInbox` surface mount** (mirrors `hydrateApprovalInbox`).

## Acceptance criteria (what "done" means)
- [ ] NEW `UiSafeIngestionItem` in `packages/contracts/src/api/ui-safe.ts` — a STANDALONE interface + `.strict()` `UiSafeIngestionItemSchema` + a `UI_SAFE_ALLOWLIST.ingestion` sorted entry + one `_uiSafeParity` `Exact<>` line (the lighter ui-safe freeze discipline). **Non-seam:** NO `ARCHITECTURE.md` Appendix-A row, NO generated `schemas/*.schema.json`, NO `__snapshots__/*.snap`, NO ajv-registry entry, NO `packages/contracts/CLAUDE.md` cross-doc-table row (same family as `UiSafeApproval`/`UiSafeDashboardCard`).
- [ ] **Field set (project from `SourceEnvelope`, established drop rules):** KEEP `sourceId` (opaque id), `type` (open display token), `sensitivity` (open token), a bounded single-line `title`/`summary` (via `collapseToSummaryLine`/`uiSafeSummaryLine`); OPTIONAL `state`, `queuedAt` (ISO datetime) if a producer supplies them. DROP `origin` (URL/path — WS-8/#7 raw-ref precedent), `contentHash` (content-derived — like `payloadHash` dropped from `UiSafeApproval`), `routingHints` (open record — like `sanitizedPayload`), `workspaceId` (renderer knows its scope). No `...spread` — explicit allowlisted field copy (the leakage discipline).
- [ ] `query.ingestionInbox(workspaceId) → Result<readonly UiSafeIngestionItem[], FailureVariant>` — auth-gated (`authedResolver`), input-validated (`parseWorkspaceInput`, non-empty workspaceId), NEVER throws (§16). Re-validates EVERY row through `UiSafeIngestionItemSchema` at the boundary, fail-closed dropping/erroring on a poisoned row (mirror `sanitizeRecentChanges`).
- [ ] **WS-8 fail-closed:** the query resolves the workspace via `resolveKnownWorkspace` (workspace-registry gate); an unknown/absent workspace ⇒ typed `err(unknownWorkspace())`, never a partial/cross-workspace leak. NOT a cross-workspace path (Global surfaces nothing here).
- [ ] **Empty-until-producer:** with no ingestion read-model row present, `query.ingestionInbox` returns `ok([])` (not an error, not approvals). The `ingestionInbox=pendingApprovals` ALIAS is REMOVED (the port no longer returns `UiSafeApproval[]` for ingestion).
- [ ] The 3 read-model test fakes gain the new method/type: `emptyReadModel` (`apps/worker/test/integration/api-live.test.ts:83`), `fakePort` (`apps/worker/test/api/procedures/queries.test.ts:135`), `makeRepresentativeReadModel` (`packages/evals/src/benchmarks/dashboard-warmload.bench.ts:144`).
- [ ] Repo-wide `turbo typecheck test` green (cross-package: `@sow/contracts` ui-safe + `@sow/worker` + the bench); the ui-safe freeze tests (`apps/worker/test/api/uiSafe.test.ts`, the ALLOWLIST/parity guards) green.

## RED test outline (write cases first)
1. `ingestion_item_schema_freeze` — `UiSafeIngestionItemSchema` `.strict()` field set === `UI_SAFE_ALLOWLIST.ingestion`; `_uiSafeParity` Exact<> holds (the ui-safe freeze pin).
2. `projector_drops_raw_refs` — projecting a `SourceEnvelope` with a URL `origin` + `contentHash` + `routingHints` ⇒ the UiSafeIngestionItem carries NONE of them; only allowlisted fields; the summary is single-line + bounded.
3. `query_returns_empty_until_producer` — no ingestion read-model row ⇒ `query.ingestionInbox(ws)` ⇒ `ok([])`.
4. `query_ws8_unknown_workspace_fails_closed` — an unregistered workspaceId ⇒ `err(unknownWorkspace())`, no rows.
5. `query_revalidates_fail_closed` — a poisoned/oversized row in the read-model blob ⇒ the boundary re-validation drops/errors it fail-closed (mirror `sanitizeRecentChanges`), never surfaces it.
6. `alias_removed` — `query.ingestionInbox` no longer returns `UiSafeApproval[]` (its return type is `UiSafeIngestionItem[]`; a pending Approval does not leak through the ingestion path).
7. `never_throws` — a malformed read-model payload ⇒ a typed Result, never a throw (§16).

## Cross-doc invariant impact
- **Frozen Appendix-A seam changes:** **NONE** — `UiSafeIngestionItem` is a non-seam UI-safe projection (no Appendix-A/snapshot/ajv-registry/cross-doc-table); `SourceEnvelope`/`Approval` are unchanged (projected FROM). 
- **BUT it IS a cross-package change** (`@sow/contracts` ui-safe.ts + `@sow/worker` port/query/adapter + the bench) touching the LIGHTER ui-safe freeze (allowlist + `_uiSafeParity` + freeze test) ⇒ repo-wide `turbo typecheck test` gate required. Not a frozen-seam cross-doc-invariant round.
- **Architecture-doc note candidate:** the §10/§11 ingestion-inbox prose may note the dedicated read-model + UiSafe contract landed (empty-until-producer; producer + desktop mount deferred). Orchestrator-write.

## Things to flag at Step 2.5 (design questions — default votes)
1. **Read-model pattern (load-bearing fork).** Default vote: mirror **`recentChanges`/`projectDashboards`** (pattern b) — the port returns candidate `UiSafeIngestionItem[]` narrowed from a `read_models` row (new `READ_MODEL_KEYS.ingestion`), the procedure re-validates through the frozen schema; ships empty-until-producer, cleanly defers persistence. Alternative: the Approval mirror (port returns raw `SourceEnvelope[]`, projector redacts in-procedure) — needs a real parked-source list adapter (persistence gap ⇒ bigger). Confirm b.
2. **Field set — state/queuedAt in or out?** Default vote: include `state` + `queuedAt` ONLY if the (deferred) producer would supply them; if the producer shape is unsettled, ship the minimal KEEP set (sourceId/type/sensitivity/summary) and add optional fields when the producer lands. Confirm.
3. **Alias removal safety.** Default vote: confirm NO consumer depends on the old `ingestionInbox=approvalInbox` behavior (the desktop doesn't mount ingestion yet — the alias was a stand-in). Removing it is safe. Confirm at Step 0.

## Wiring / entry point / blocks
- **Entry point:** `query.ingestionInbox` is on the live tRPC read-model router (mounted); reachable now (returns empty until a producer populates the row). Note at Step 7.5.
- **Blocks:** the desktop ingestion-inbox surface mount (the follow-up) depends on this contract + query. Does NOT block anything else.
- **Depends on:** the mounted read-model query infra + `SourceEnvelope` + the ui-safe framework (all present).

## Estimated commit count
**1–2.** (1) the `UiSafeIngestionItem` contract + projector + `query.ingestionInbox` + DB adapter + fakes + tests. (Optional 2 if the contract lands separately from the worker wiring.) Cross-package ⇒ repo-wide gate. Leakage/WS-8 surface ⇒ Step-8 review MANDATORY.

## Lessons-logged candidates (implementer flags Step 9)
- Possible: "an inbox read-model ships EMPTY-UNTIL-PRODUCER (mirror recentChanges/projectDashboards) — the read path + the UI-safe contract land first; the write-time producer + persistence are a named follow-up. The UI-safe projection is non-seam (allowlist + parity + freeze test, no Appendix-A snapshot) and drops every raw ref (origin/hash/routingHints) by explicit allowlisted copy." Implementer's call (may fold into existing UI-safe lessons).

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read the approval-inbox mirror + `recentChanges` mirror + `UiSafeApproval`/`ui-safe.ts` freeze machinery + confirm the alias-removal is safe.
2. Step 2.5 — ping Q1–Q3 (defaults above; Q1 the read-model pattern + Q2 field set are load-bearing) BEFORE writing cases.
3. RED first (the schema-freeze pin + the drop-raw-refs + WS-8-fail-closed + re-validation-fail-closed are load-bearing).
4. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality): NO raw `origin`/`contentHash`/`routingHints` leaks into `UiSafeIngestionItem`; WS-8 fail-closed (unknown workspace ⇒ err, no cross-workspace leak); the boundary re-validation drops a poisoned row fail-closed; the alias removal leaks no Approval through the ingestion path; §16 never-throws.
5. Step 9 — categorized flags (esp. the deferred producer + desktop mount follow-ups; any pull toward a frozen seam) + ship-ask.

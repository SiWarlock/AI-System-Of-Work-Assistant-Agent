# Phase-7 §9 Temporal Workflows — Security Review (/phase-exit 7 gate)

**Reviewer:** security-reviewer subagent · **Date:** 2026-07-02
**Subject:** `packages/workflows` (@sow/workflows) + `apps/worker` (@sow/worker) + `packages/db` ApprovalRepository CAS change (Phase-2 amendment surfacing apply-vs-noop `applied`).
**Method:** Every fixed adversarial-verify finding re-derived from source (not trusted from summaries); each safety invariant cross-checked and an attempt made to break it.

## Gate results (all green)

| Gate | Result |
|---|---|
| `pnpm --filter @sow/workflows exec vitest run` | 28 files, **438 passed** |
| `pnpm --filter @sow/db exec vitest run` (SQLite + postgres-pglite) | 10 files, **275 passed / 2 todo** (incl. Invariant-3 exactly-once, both dialects) |
| `pnpm --filter @sow/worker exec vitest run` | 2 files, **13 passed / 1 skipped** (SOW_TEMPORAL-gated integration) |

## Invariant pass — cross-check verdicts

**1. LIFE-3 no-duplicate-side-effect on resume — PASS.**
`runtime/resume.ts` `planResume` is pure; a committed-with-receipt step is SKIPPED (never re-run); a torn commit (committed but receipt=missing) returns `unrecoverable` + an OPEN health item (no silent drop); a re-drivable `knowledge_write`/`external_write` with NO `idempotencyKey` is `unrecoverable` (cannot re-drive without the dedup key). The torn-commit scan is correctly scoped to *this run's* steps (finding-3 fix confirmed — a foreign `missing` row no longer false-aborts). §6 ordering sorts the WHOLE plan (skips+redrives) by (priority, index) so `gbrain_index` can never precede `knowledge_write`. `activities/envelopeReuse.ts` leans on the Phase-6 gateway receipt/existence gate: `reused` ⇒ adapter.create not called again. **Break attempt failed** — no path re-drives a mutating step without its envelope.

**2. LIFE-1 lease / LIFE-5 clock — PASS.**
`instanceLease.ts`: another owner's live lease ⇒ `passive` with NO write (no split-brain); acquire/reacquire only via `store.compareAndSet(current, next)`; store fault / lost CAS both fail-closed to `passive`. Fencing: a fresh acquire BUMPS `generation = (current?.generation ?? 0) + 1`, a renew PRESERVES it, so `isFencedStale(old,new)` fences a sleep-paused prior holder even inside the TTL window (cross-op enforcement is documented Phase-10). `clock.ts` uses the monotonic delta only when `nowEpoch === lastEpoch` (else wall, clamped ≥0) — a persisted prior-boot monotonic reading can't starve/double-fire. `catchUpWindow.ts` is inert on non-positive interval/window, integer-division bounded (no per-tick loop over a year gap), `missed` list capped at 100 with exact `droppedCount`, forward-jump inflation blocked via `elapsedMsOverride`.

**3. No-inference / no-partial-commit — PASS.**
`buildOutputs.ts` / `proposeWindows.ts` / `deletionPlan.ts` DERIVE the plan from validated data; `plan.workspaceId` is stamped from the PASSED correlation/route-bound workspace (never a caller field); frontmatter carries only validated (evidence-backed / TBD-sentinel) fields; all brief/period drivers validate-and-derive EVERY plan BEFORE any commit (no partial-commit). **Break attempt failed** — a caller cannot inject a plan, an inferred owner/date, or a cross-workspace target.

**4. Approval exactly-once + deferred lifecycle — PASS.**
`decideApprovalCas` (packages/db invariants) + both adapters' `applyTransition`: the SELECT is classification-only; the atomic guard is `UPDATE … WHERE id=? AND status=expectedFrom` with a race-loser fallback to `stale_conflict`. `current===next` ⇒ `idempotent_noop` returning `ok(current)` with NO write (a legitimate Temporal replay stays idempotent — REQ-F-012 preserved, NOT turned into a conflict). The activity reports `applied` straight from the atomic verdict (TOCTOU closed; the old read-then-write heuristic is gone). Second-channel same-target ⇒ `applied:false` (dispatch runs once); different-terminal ⇒ `conflicting_approval`. `expired→approved` rejected by the domain machine → `expired` code; `snoozeTimer.ts` expiry-wins-first, durable ISO basis (LIFE-5-safe across a 7d restart), unreadable clock ⇒ sleep (fail-safe).

**5. Deletion-saga safety — PASS.**
`deletionPlan.ts` `computeContentDiscriminator` hashes each eligible region by `[path, regionId, contentHash]` (the LIVE body identity, NOT the empty tombstone `newBody`) and folds it into planId/purgeKey/eventTombstoneKey/reconcileKey — so a same-region-id/different-content re-materialization gets FRESH keys ⇒ tombstone+purge RE-RUN ⇒ no resurrection (content-blindness finding closed BY CONSTRUCTION). `run.idempotencyKey` deliberately excluded (legitimate re-run dedup preserved). Human-owned regions excluded from the plan (recorded in `preservedRegions`); every-region-human-owned ⇒ `human_owned_only` refuse; inside-retention ⇒ `retention_blocked`. Ordered steps with KnowledgeWriter tombstone as the sole commit point; event-store TOMBSTONE appended (history preserved, not hard-deleted); post-commit failure ⇒ `compensating` (never rollback); a same-key/different-content discriminator mismatch fails closed to compensating. **Break attempt failed.**

**6. Read-path purity / Hermes routing / leakage-safety — PASS.**
`copilotQa.ts` driver has NO commit/dispatch port (structural zero-side-effect); global questions go ONLY through the GCL Visibility Gate (`scopedRetrieval.ts` gates every candidate, fails the WHOLE retrieval closed on any rejection — no downgrade-and-serve). `hermesAutomation.ts` binds workspace BEFORE any write, KnowledgeWriter is the sole Markdown writer, Tool Gateway the sole external path, GBrain re-index off the committed revision, replay reuses receipts. Leakage guard is on the ACTUALLY-DISPATCHED artifact: `proposeWindows.ts` runs `payloadCarriesRawContent(d.payload)` (recursive, key-name-independent) over `action.payload` — the object that rides the Tool Gateway — not the decoy `genericExplanation` descriptor. `buildGclProjection.ts` gates each projection input.

**7. No-silent-drop reads / governance routing / redaction — PASS.**
`connectorPoll.ts` derives `cursorAdvanced` strictly from the gateway's real `status==='advanced'` (advanced only after records processed — REQ-I-005), never fabricated; `healthReason` carries only the redaction-safe `healthSignal.message`. ING-7 (`runAgentJob.ts`) hard-stamps `trustLevel:'untrusted'`+`carriesRawContent:true` and runs `admitJob` BEFORE the broker — `admitJob` (policy/admission.ts) denies `UNTRUSTED_CONTENT_MUTATING_TOOL`; its AuditSignal uses `payloadHash` + summaries, not raw content. `healthItem.ts` validates through the frozen schema and dedupes on `failureClass|subjectRef`; driver health messages use `.error.code`, never raw `cause`.

## General pass

Candidate-data gate composition (ajv ∘ Zod ∘ §-visibility) is invoked at every provider/broker seam (`validate.validate` in all drivers; `admitProjection` at the two cross-workspace gates) — no ajv-alone path found (LESSONS §3 respected). No unbounded loops (catch-up is integer-division-bounded + capped). No SQL/command/path injection surface (Drizzle parameterized queries; no string-concat SQL; no `child_process`/`eval`). §16 typed-Result-never-throw convention held across all boundaries reviewed. No secrets/raw content in logs or AuditRecords in scope.

## Findings

| Severity | Finding | Action |
|---|---|---|
| LOW (advisory) | `proposeWindows.ts` leakage detector is heuristic (length > 1024 / multi-line / known raw-key). A SHORT single-line leaked value (e.g. a private meeting title under an innocuous key like `label`) would pass. Acceptable given the payload is DERIVED (not agent-freeform) and stamped generic-only by the projection; noted as the detector's inherent boundary, not a §9 defect. | defer (Phase-10: consider an allowlist of payload keys for cross-workspace calendar events) |
| LOW (advisory) | `ConnectorPollError.cause` / other error `cause` fields retain raw `unknown`; safe today (drivers surface `.code`, never `.cause`), but a future log sink must redact before serializing `cause`. | defer (Phase-10 redaction-sink wiring) |

No CRITICAL and no HIGH findings. Both advisories are non-blocking Phase-10 wiring notes, not §9 defects.

## Verdict

**CLEAR.** All seven safety invariants hold; every re-derived adversarial-verify fix is genuinely closed (independently reproduced from source, break attempts failed); all three gates green on both dialects. Two LOW advisories deferred to Phase-10.

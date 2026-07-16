# Session 082 — worker-impl2: Phase-14 capstone + Phase-15 ingestion-spine

- **Date:** 2026-07-15
- **Phase:** Part II — Phase 14 (Onboarding/Substrate, §19.1) capstone + Phase 15 (ingestion-spine, §19.2)
- **Role/track:** worker-impl2 (worker track — `apps/worker`, `packages/db`, `packages/workflows`), single-track `main`
- **Team:** `session-734f946b` — orchestrators orch22 → orch23 (cycled mid-session); lead persists
- **Predecessor:** [081-2026-07-15-worker-impl-phase14-worker-foundation.md](081-2026-07-15-worker-impl-phase14-worker-foundation.md)
- **Successor:** _(worker-impl3, first slice 15.6 — link when created)_

## Why this session existed

The successor worker implementer (cycled from worker-impl at ~76%) to build the **highest-safety-bar Phase-14 slice** (14.7 cross-workspace links — deliberately sequenced to a fresh session for full rule-4 review headroom) and then drive the **Phase-15 "missing spine"** (connector→ingestion, dedupe durability, note-body, disposition/re-enter). All pure-build/dormant, no hard line.

## What was built (5 slices, strict TDD throughout)

### 14.7 — Cross-workspace-link store + owner-approval flow + WS-8 read gate
- **db `4d36b9b2`** · **worker `06ba3d3a`**. The SINGLE sanctioned WS-8 cross-workspace read input (safety rule 4).
- Dual-dialect `cross_workspace_link` table + `CrossWorkspaceLinkRepository` + create/approve/revoke procedure + the read gate `resolveApprovedCrossWorkspaceSlice`.
- Invariants: absent/unapproved/revoked link ⇒ ZERO bleed (fail-closed); approved ⇒ only the sanitized, scoped slice (through the GclProjection sanitizer, never raw bytes); directional (A→B≠B→A); immutable `(from,to,scope)` tuple (worker L30); **Lesson-12 read-back identity re-gate** on the crossing row (caught by both reviewers, fixed in-slice).

### 15.1 — Connector→ingestion bridge (the missing spine)
- **worker `a6190122`**. `createConnectorIngestionBridge` — the poll driver's `onRecords` seam: record → `registerSource` (candidate gate, rule 2) → `dispatchSourceIngestion`, a 2nd trigger alongside the `.md` watcher.
- Idempotent (content-versioned key = workflowId, L16); WS-8/no-inference (scoped fields from the bound instance, `payload` never read); dispatch-failure HOLDS (REQ-I-005), poison record skips+observes.
- **Reachability-WAIVERED** — `connectorPoll` has no production trigger (Phase-16 scheduled poll); not wired dormant-on-dormant (L11). Meeting dispatch deferred to 15.9.

### 15.4 — Persisted seenContentHash dedupe store
- **db `19e626fe`**. Dual-dialect `seen_content_hash` (composite PK `(workspaceId, contentHash)`) + `SeenContentHashRepository` (has/record, first-write-wins). WS-8-scoped, fail-closed both directions (L3), durable across restart.
- Q3 reconciled (with orch22): a `has`-fault should PROCEED (the Temporal workflowId is the real exactly-once backstop), not HOLD — captured as the Phase-16 binding contract.

### 15.3 — Source note-body projection (kill the C1 placeholder)
- **worker `80bfd721`**. Real note body+frontmatter from the gate-validated `SourceEnvelope.body` (15.2), threaded as an OPTIONAL `body?` param on the source-specific `SourceBuildOutputsPort.build` (forked port, no ripple onto shared `ValidatedExtraction` — worker L5; additive-optional keeps callers valid — L15).
- Candidate-gate intact (body verbatim, rule 2); path stays body-independent (only `SourceNoteIdentity` keys `deriveSourceNotePath` — traversal-safe); absent-or-empty body degrades to `_No extracted content yet._`; sole KnowledgeWriter unchanged (rule 1).

### 15.5 — Durable disposition store + real isParked + parked reader + replay-safe re-enter (ING-4/G5)
- **db `a34d9627`** · **worker `b8b258ee`**. Dual-dialect `source_disposition` (parked-source-of-record) + the durable seams (`dispositionDurable.ts`) replacing the in-memory stubs: real `isParked`, `createDurableParkedReader`, `createRegistryValidatedRescope` (WS-8), scoped-but-real `createReenterRunner`.
- Guardrails: the parked raw `SourceEnvelope` is server-side-operational-only (audit summaries-only, never rendered/logged — rule 7); re-enter re-drives THROUGH the gate (rule 2); idempotencyKey replay over the real `KnowledgeRevisionStore` (rule 3/inv-D); registry-validated override (inv-C, contentHash preserved inv-D); exactly-once CAS (inv-A/inv-B); fail-closed L3.

**Files created (new):** `packages/db/src/schema/{,pg/}{cross-workspace-link,seen-content-hash,source-disposition}.ts`; `packages/db/migrations/{sqlite,pg}/000{9,10,11}_*.sql`; `packages/db/test/adapters/{seen-content-hash,source-disposition}-durability.test.ts`; `apps/worker/src/composition/{connectorIngestionBridge,dispositionDurable}.ts` + their `api/procedures/crossWorkspaceLink.ts`; the paired test files.
**Files modified:** `packages/db/src/repositories/interfaces.ts`, both adapters, schema barrels, repo-contract + lifecycle + create-schema harness; `apps/worker/src/composition/buildActivities.ts` (15.3 body param + delegate; 15.5 durable-seam wiring, dead `makeDispositionStore` removed), `packages/workflows/src/ports/sourceIngestion.ts` + `workflows/sourceIngestion.ts` (15.3 body threading), `api/server.ts` + `boot.ts` (14.7 wiring); a constant-only eval-security `auth-suite` stub (14.7, orch-authorized).

## Decisions made
- **14.7 immutable anchor = the full `(from,to,scope)` tuple** (not just the pair) — a silent scope-widen is a WS-8 bypass. Extended worker L30.
- **15.1/15.4/15.5 reachability waivers** — the Phase-16 drive path / bridge binding is dormant; ship built+tested + waiver rather than dormant-on-dormant (L11).
- **15.3 threading = optional `body?` on the forked source port** (not the shared `ValidatedExtraction`) — L5 fork-the-port + L15 additive.
- **15.5 `isParked = row-exists` (NOT `state==="queued_for_review"`)** — convergence (inv-B) requires a dispositioned row to stay parked so the 2nd channel hits getByKey→noop; pinned by the exactly-once HIT-reuse test. Rejected a code-quality suggestion that would have broken inv-B.
- **15.5 re-enter runner = scoped-but-real** (re-gate + revision-store replay), full-7.7 fresh-commit re-drive deferred; **park-write into the 7.7 branch waivered** (Scope-2).
- **15.5 audit-before-CAS ordering kept** — "nothing silent" beats the benign orphan-audit edge; record-first would risk a dangling auditRef.

## Decisions explicitly NOT made (deferred)
- **G5 park-write wiring** into the 7.7 low-confidence branch — the `park` repo method is built + repo-contract-tested + fails-safe unpopulated, but persisting the parked SourceEnvelope at park time (the piece that makes park→triage→re-enter functionally live) is a named follow-up. G5 is structurally closed but not yet functionally live end-to-end (orch23 tracks it as G5's second half).
- **15.5 full-7.7 fresh-commit re-drive** — the runner proves the re-gate + replay contract; the fresh commit (route/agent/build/commit) is deferred.
- **15.1 Phase-16 bridge binding** (`resolve → {port, onRecords}` + connectorPoll registration + schedule); **15.4 Phase-16 seenContentHash binding** (with the fault→PROCEED contract).
- **Meeting dispatch (15.9)** — no thin trigger built in 15.1 (would mis-route); `dispatchMeetingCloseout` + correlateMeeting routing is 15.9.
- **15.3 deeper source-metadata frontmatter** (origin/type/sensitivity) — shipped body + minimal identity frontmatter; richer metadata deferred.
- **15.5 dedupe-ledger retention** (15.4's seen-hash + 15.5's disposition tables grow unbounded) — track a retention policy at the Phase-16 binding (security informational note).

## TDD compliance
**Clean — no violations.** Every slice was strict RED-first (failing test confirmed for the right reason before implementation) across all 5 slices. Both mandatory reviews (security=invariant, code-quality=every-slice) ran per slice; every converged/should-fix finding was fixed in-slice or explicitly deferred with documentation.

## Reachability
- **14.7:** create/approve/revoke procedure reachable (boot → `createCrossWorkspaceLinkCommandPort` → `server.ts` mount). Read gate waivered (prod consumers = coordination/global briefs 25.2/25.4).
- **15.1:** bridge waivered (prod trigger = Phase-16 scheduled poll; sole caller = its test).
- **15.4:** repo factory-exposed (`backends.repos.seenContentHash`); consumer = Phase-16 bridge binding (waivered).
- **15.3:** reachable via the C1 build→commit spine (`sourceIngestion-live`, SOW_TEMPORAL-gated); projection fully unit-pinned.
- **15.5:** durable seams reachable via the C1 triage path (recordDisposition/rescopeSource/reenterIngestion); **park-write waivered** (see deferred).

## Open follow-ups (Step-9 categorized, all routed hot to the orchestrator)
- **Cross-doc notes (orchestrator writes):** NEW `CrossWorkspaceLink`, `SeenContentHashRow`, `SourceDispositionRow` (all db-owned, NOT Appendix-A → no schema-snapshot); `SourceBuildOutputsPort +body?` (workflow-port seam, additive/optional, not Appendix-A). None are frozen contract changes.
- **Worker Lesson candidates:** cross-workspace-read-default-closed (extends L12/L30); connector-bridge candidate-gate+idempotency; make-it-real note projection (gate-validated body, path-body-independent); persisted-dedupe first-write-wins; durable-disposition CAS + replay-safe re-enter.
- **Phase-16 bindings:** 15.1 bridge wiring, 15.4 seenContentHash (fault→PROCEED), 15.5 park-write (G5 second half) + full-7.7 fresh-commit re-drive.
- **Cross-track:** the constant-only eval-security `auth-suite` stub (14.7) — orch-authorized; review-note in Carry-forward.

## Cycle note
Cycling at HARD-STOP (clean boundary — 15.5 shipped `a34d9627`+`b8b258ee`, nothing in flight). Successor = worker-impl3 (first slice 15.6 auto-ingest .md-only scope + feedback-loop guard).

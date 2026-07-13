# Session 063 — impl14: durable revisions + real sourceCommit + multi-file ingestion (task 11.1)

- **Date:** 2026-07-13
- **Phase:** 11 (OPEN-THE-GATES — auto-ingest make-it-work arc)
- **Role:** implementer `impl14` (worker track), team `session-f2673cd5`, single-track on `main`
- **Orchestrator:** `orch13`
- **Predecessor:** [`062-2026-07-12-impl12-phase9-pivot-c6-golive-autoingest.md`](062-2026-07-12-impl12-phase9-pivot-c6-golive-autoingest.md)
- **Successor:** _(impl16 — TBD; cycling out at a clean boundary for the C5.4b arc)_

## Why this session existed

impl12 hit a clean-boundary cycle after slice 1 (auto-ingest live-wiring, `727ab76`). impl14 continued the **OPEN-THE-GATES auto-ingest arc**: make a dropped `.md` file actually persist durably to canonical Markdown, end-to-end, owner-opt-in. Three slices landed: the durable idempotency substrate (2a), the real sole-writer commit (2b), and the multi-file per-source path fix (#46).

## What was built

### Slice 2a — durable `KnowledgeRevisionStore` (`bbabd5f`)
Replaced the in-memory `Map` KnowledgeWriter-idempotency stub with a real operational-store repo, so idempotent-replay survives a worker restart (the exactly-once substrate for the sole writer).

**Files created:**
- `packages/db/src/schema/knowledge-revisions.ts` + `src/schema/pg/knowledge-revisions.ts` — the `knowledge_revisions` table (SQLite + Postgres mirrors), `idempotencyKey` PRIMARY KEY.
- `packages/db/migrations/{sqlite,pg}/0005_knowledge_revisions.sql` (+ meta snapshots) — additive migration (drizzle-generated).
- `apps/worker/src/composition/knowledgeRevisionStore.ts` — the fail-closed store adapter (db repo → `@sow/knowledge` port).
- `packages/db/test/adapters/knowledge-revision-durability.test.ts` + `apps/worker/test/composition/knowledgeRevisionStore.test.ts`.

**Files modified:** `packages/db/src/repositories/interfaces.ts` (+`CommittedRevisionRow` DTO + `KnowledgeRevisionRepository`), both adapter factories (`sqlite`/`postgres`), both schema barrels, the contract-test suite, `test/migrate/lifecycle.test.ts` (applied 5→6), the two test-schema DDL helpers.

### Slice 2b — real ingestion `sourceCommit` (`a6cf0ec`)
Swapped the deterministic fake `sourceCommit` for the real `createCommitActivity` over `applyPlan` (the sanctioned KnowledgeWriter sole-writer path) + rebound the durable 2a store into the proof-spine params.

**Files created:** `apps/worker/test/composition/realSourceCommit.test.ts`, `durableRevisions.test.ts`.
**Files modified:** `apps/worker/src/composition/buildActivities.ts` (fake → `createCommitActivity` with a live `readVaultHeadRevision` resolver + `kw:commit:${planId}`), `apps/worker/src/boot.ts` (+`withDurableRevisions` rebind, gated behind `proofSpineParams !== undefined`).

### Slice #46 — per-source content-addressed note path (`ac78327`)
Fixed the fixed-path collision (`sources/<ws>/ingested.md`) so many dropped files persist as distinct notes. Threaded the per-file source identity into the ingestion build via a **dedicated `SourceBuildOutputsPort`**; derived note path + planId from `sha256(sourceId, contentHash)`.

**Files created:**
- `apps/worker/src/composition/sourceNotePath.ts` — pure `deriveSourceNotePath` + `sourceIdentityDigest` + `SourceNoteIdentity`; traversal-safe by construction + ws-segment fail-closed guard.
- `apps/worker/test/composition/sourceNotePath.test.ts` + `perSourceNotePath.test.ts`.

**Files modified:** `packages/workflows/src/ports/sourceIngestion.ts` (+`SourceBuildOutputsPort` + `SourceNoteIdentity`), `packages/workflows/src/workflows/sourceIngestion.ts` (dep type + driver projects/passes `context.source`), `apps/worker/src/temporal/workflows.ts` (source sandbox proxy 3-arg), `apps/worker/src/composition/buildActivities.ts` (source build derives per-file), `test/composition/realSourceCommit.test.ts` (new arity), `test/integration/sourceIngestion-live.test.ts` (+`(g)` multi-file case).

## Decisions made

- **2a — first-write-wins idempotent no-op** (`INSERT … ON CONFLICT DO NOTHING` on the PK), not a typed `conflict`: the `KnowledgeRevisionStore.record` port returns void (no conflict channel) and "exactly-once" == idempotent. Diverges from the outbox/pending-kmp `conflict`-on-duplicate — justified by the interface.
- **2a/2b — fail-closed BOTH directions:** a real DbError on `getByIdempotencyKey` OR `record` REJECTS (never masks as "no prior commit", never swallows a failed record); only `not_found` folds to undefined.
- **2b — NO `writer.ts` touch:** `createCommitActivity` already wraps `applyPlan` in a §16 catch → `commit_failed`, so the 2a fail-closed carry-forward is honored at the activity boundary (verified by security).
- **#46 — Option A (thread the per-file source), via a DEDICATED `SourceBuildOutputsPort`** (not a shared-port mutation): the shared `BuildOutputsPort` stays byte-unchanged; hermes (a third consumer) has no `contentHash`, so a shared required param would force a dishonest fake. Matches the crossCalendar/projectSync fork precedent.
- **#46 — narrow `SourceNoteIdentity {sourceId, contentHash}`** (not full `SourceEnvelope`): structurally excludes attacker-influenceable fields (origin/routingHints/sensitivity) from the path-construction surface (least privilege).
- **#46 — content-addressed** (path + planId from `sha256(sourceId, contentHash)`): consistent with the watcher's own `src:${ws}:${contentHash}` run key; lossless on edit (new note) vs the file-addressed alternative that silently drops edits.
- **#46 — ws-segment guard** (`^[A-Za-z0-9_-]+$`, fail-closed): `WorkspaceId` is charset-unvalidated and the vault-root guard only backstops whole-vault escape, so the ws-guard is the primary cross-workspace (WS-8) defense.

## Decisions explicitly NOT made (deferred)

- **Update-on-edit** (an edited same-file re-drop PATCHING the existing note via a note-exists probe) — a follow-on slice; today an edit = a new note (lossless).
- **Pruning the now-dead `SourceIngestionParams.sourceRef`/`.planIdentity`** binding fields (unread after #46) — retained + annotated; prune is a follow-on (ripples to boot + fixtures).
- **A writer-side workspace-scoped path guard** (defense-in-depth beyond the derivation) — optional follow-on.
- **Real per-file extraction** (the C1 `sourceAgent.run` is still a static fake) — a separate C2/C3 concern.

## TDD compliance

**Clean.** Every slice was RED-first: a failing test captured before implementation (2a durability `TypeError: repos.knowledgeRevisions undefined`; 2b real-commit spy; #46 the two-distinct-sources + traversal battery). Deterministic code throughout (path derivation, repo, wiring) — all unit/contract/integration tested. No violations.

## Cross-doc invariant audit

**No Appendix-A / frozen seam-model field change this session.** New types are all internal, not snapshot-guarded: `CommittedRevisionRow` (db-local mirror of the knowledge `CommittedRevision`), `SourceBuildOutputsPort`/`SourceNoteIdentity` (internal workflow ports), `withDurableRevisions` (worker-internal). Each flagged at Step 9 as "none frozen"; orch13 confirmed. `KnowledgeMutationPlan` reused unchanged. No drift.

## Reachability

- **2a store** → reachable via `bootWorker` → `withDurableRevisions` rebind → the proof-spine register hook + the (dormant) propose dispatch; durability proven by the file-db close/reopen test.
- **2b real commit** → reachable via the auto-ingest gate (owner-opt-in) → `buildProofSpineActivities` sourceCommit → `applyPlan`; verified live under `SOW_TEMPORAL=1`.
- **#46 per-source derivation** → reachable via `runSourceIngestion` → `SourceBuildOutputsPort.build` (driver passes `context.source`) → `deriveSourceNotePath`; verified live under `SOW_TEMPORAL=1` `(g) MULTI-FILE`.
- No tested-but-unwired gaps. All behind the slice-1 default-OFF gate (nothing persists without owner opt-in).

## Open follow-ups (Step-9 categorized + flagged)

- **Follow-on slices** (orch13 to route/track): (a) update-on-edit (note-exists → patch / create-vs-update); (b) prune the dead `SourceIngestionParams.sourceRef`/`.planIdentity` fields; (c) optional writer-side workspace-scoped path guard (defense-in-depth).
- **Non-blocking INFO** (from reviews, already accepted): 2a — a record-reject retry emits a duplicate append-only audit row (pre-existing writer semantics, benign); WS-8 idempotencyKey distinctness rests on the upstream planId derivation.
- **Doc-seal (orch13 territory):** ARCH §4/§6/§13 notes (durable revisions; real multi-file ingestion via SourceBuildOutputsPort); runbook "single-source per ws" → "multi-file per ws"; lesson candidates (durable-store fail-closed-both-directions; activate-a-real-commit-by-swapping-the-fake; the-build-must-receive-the-per-file-source + traversal-safe-by-construction).

## Method notes

- **Two Findings surfaced pre-code** (#46): the derivation-only brief couldn't deliver multi-file (per-file identity never reached the build → Option A); the shared port had a third consumer that couldn't honestly pass a source (→ dedicated port). Both escalated at Step-2.5, evidence-backed, before touching shared code.
- Caught + fixed a stray NUL/control-byte hygiene defect in the injection-safety test file (control chars now `String.fromCharCode`-constructed).
- Every slice dual-reviewed (fresh general-purpose security + code-quality Agents); all findings folded in-slice.

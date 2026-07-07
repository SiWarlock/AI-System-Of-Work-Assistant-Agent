# Session 047 — the real dashboard, Arc P: the concrete SyncOutputsProjection (P3e)

- **Date:** 2026-07-07 · **Track:** solo (workflows + evals) · **HEAD:** `c7bc1c9` → `05df188`.
- **Owner direction:** "let's do the next step. use workflows where possible" — the projectSync port-signature change + the concrete `SyncOutputsProjection` (the last deterministic piece of the real Projects dashboard). Earlier: "that's your job to find out whether it's redundant or not" (→ P3c, resolved).
- **Gate:** repo-wide `pnpm -w turbo run typecheck test` **31/31** throughout. Dual-reviewer (security + code-quality) on the seam.

## Method — a survey→design→adversarial-verify workflow earned its keep
Ran a 7-agent Workflow (`wf_eae5f80e-75f`): 3 parallel surveys (the port seam, the committed-NoteCreate precedent, the field-key convention) → a design synthesis → 3 adversarial verifies (WS-8, REQ-F-011+no-inference, contract/back-compat). **The verify pass caught 3 MAJORs I would have shipped:**
1. **WS-8 path traversal (blocker):** deriving the note path from the multi-segment `registry.slug` isn't rooted at the server-bound workspaceId and can't be traversal-sanitized — the vault does `join(root, note.path)` verbatim and the KW commit gate does NOT check path-in-workspace. **Fix:** root at `projects/<workspaceId>/<safeNoteSlug(projectId)>.md`; slug in frontmatter only; fail-closed on an empty leaf.
2. **REQ-F-011 on the note:** rendering the note percent verbatim instead of re-deriving via `computePercent` — the note is canonical truth, must carry ≥ the dashboard's defense. **Fix:** re-derive.
3. **No-inference duplication:** routing the note prose through a *new* composer duplicated the load-bearing TBD-skip. **Fix:** share ONE `renderProseLines` helper between dashboard + note.

## What shipped — 3 commits (TDD, dual-reviewed)
- **P3e-1 `0ca8dd0` — port-identity threading.** New `ProjectIdentity {projectId,title,slug,lifecycleState}` (workflows-local; carries NO workspaceId — that stays a separate server-bound param, WS-8). `BuildSyncOutputsPort.build` + `SyncOutputsProjection.project` gain `identity` + `updatedAt`; `ProjectRegistryEntry` extended +title/+slug/+lifecycleState (the registry is the server-resolved identity/seed authority — no separate project-note read). The driver derives identity from the registry-bound entry + `updatedAt` from `deps.clock.now()`. Fakes/tests/eval call sites updated; the fake's plan provenance aligned `ingestion`→`project_sync`. Workflows 473.
- **P3e-2 `30bcfbf` — the concrete projection.** `createProjectSyncOutputsProjection` (`.../projections/projectSyncOutputs.ts`): the `{workspaceId, dashboard}` envelope (reusing `buildProjectDashboardPayload`) + a committed project-status `NoteCreate`, with all 3 MAJOR fixes. `safeNoteSlug` extracted to a shared `./noteSlug.ts` (meeting-closeout + projectSync share ONE adversarially-verified path sanitizer). `renderProseLines` exported from `projectDashboard.ts` (the shared no-inference render). Field-key convention `blockers.N`/`waitingItems.N`/`nextActions.N`+`explanation` = the de-facto `sow:project-sync-output` vocabulary. Body in the `kw:region:project-status` assistant region (KN-7). 10 tests.
- **P3e-hardening `05df188` — review follow-ups.** Non-string field values DROPPED not `String()`-coerced into canonical Markdown (mirrors meetingOutputs' `concreteString`); positional index clamped (no Infinity/NaN sort); stale docstring fixed; +4 tests (driver-identity derivation, empty-category section omission, index gap, non-string drop).

## Reviews (dual, on the full seam — the flagged wiring boundary)
- **security-reviewer: 0 crit/high/med.** All 3 claimed-fixed MAJORs independently **RE-VERIFIED HELD** (traced the vault verbatim-join + the KW gate to confirm the projection is the sole path enforcer; confirmed both percents re-derive; confirmed the shared no-inference render). 2 LOWs (defense-in-depth, latent): the `workspaceId` path segment isn't itself sanitized (sound today — server-resolved; assert for a future less-trusted caller); unbounded index (fixed in hardening).
- **code-quality-reviewer: 0 high.** 2 MED (test gaps → **added**: driver-identity assertion, section-omission); 2 LOW (stale docstring → **fixed**; non-string cast → **hardened**). The `renderProseLines` rename + `safeNoteSlug` extraction verified clean (no stale refs, no drift).

## Status: Arc P deterministic build COMPLETE
Every concrete port + projection now exists + is tested: P1 seam · P2 machine · P3a builder · P3b update port · P3c validate port · P3d provenance · P3e projection. **What remains for a LIVE Projects dashboard is composition wiring + Temporal:**
- Wire the concrete trio (`createProjectSyncOutputsProjection` + `createValidateNarrativePort` + `createProjectDashboardUpdatePort`) into the projectSync activity/driver composition, replacing the fakes.
- The driver create-vs-patch re-run split (projection always returns `NoteCreate`; on re-sync, region-PATCH `project-status` — named follow-up).
- P4 activation: register the projectSync activities + trigger `runProjectSync` (Temporal-gated; app boots degraded). Sibling R5 (recent-changes activation) likewise.
- Follow-up: pin the `sow:project-sync-output` narrative-draft schema + wire it on `createValidateNarrativePort`'s `narrativeSchema` hook (the P3c go-live gate).

## Docs reconciled
`IMPLEMENTATION_PLAN.md` §13.5 · memory `sow-dashboard-real-producers` · this session doc.

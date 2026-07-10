# /tdd brief — meeting_outputs_create_vs_patch (Phase 7 hardening — projectSync-parity)

## Feature
Thread a WS-8-scoped `noteExists` into the meeting-outputs projection (`packages/workflows/src/activities/projections/meetingOutputs.ts`) and route a discriminated `create | patch` note mutation — first close of a meeting note → `NoteCreate`; a re-close/re-sync at an existing path → a region `NotePatch` — reaching parity with the shipped **projectSync W1** create-vs-patch fix (`9288bcd`). Closes the documented re-sync clobber hazard: today the projection ALWAYS emits `NoteCreate` (`:214`, `composeBody`, no `noteExists`/patch branch), so a re-close at an existing path is misattributed as a fresh create — a KnowledgeWriter one-writer/Markdown-integrity gap (currently latent: meetings close once via the proof spine, but the projector is live). Driver + KMP contract UNCHANGED (as W1 did).

## Use case + traceability
- **Task ID:** meeting-outputs-parity (Phase 7 §9 hardening; the create-vs-patch parity follow-up flagged at projectSync-W1 Step 9 + memory `sow-dashboard-real-producers`). Not a new plan `N.x` task — a hardening slice within certified Phase 7.
- **Architecture sections it implements:** `ARCHITECTURE.md §9` (meeting-closeout projection) + `§6` (KnowledgeWriter human-section preservation / region-patch — the patch must not clobber content outside its region) + safety rule **1 (One writer / no hidden brain)**. Implementer confirms the exact §9 meeting-outputs anchor at Step 0.
- **Related context (the proven template — mirror it):** `packages/workflows/src/workflows/projectSync.ts` + its `BuildSyncOutputsPort` create-vs-patch projector (`9288bcd`, W1) — the discriminated `{ kind: "create" | "patch", ... }` mutation shape (`patchOf`, `packages/workflows/test/project-sync-outputs.test.ts:39`; `ProjectNoteMutation`, `deterministicProgress.ts:243`); the region-patch mechanism `applyRegionPatch` + the `<!-- kw:region:<id> -->` markers (`packages/knowledge/src/knowledge-writer/writer.ts:495`); `NotePatch` (`packages/contracts/src/models/shared-shapes.ts:62`); the same WS-8-scoped `NoteExistsReader` port W1 threads (confirm exact name/signature at Step 0); the shared `noteSlug.ts` helpers (`safeNoteSlug`/`projectNotePath`/`PROJECT_STATUS_REGION`/`composeRegionBody`).

## Acceptance criteria (what "done" means)
- [ ] The meeting-outputs projection accepts a WS-8-scoped `noteExists` signal (the existing `NoteExistsReader` port, threaded exactly as projectSync W1 does — NOT a new port shape unless Step-2.5 Q2 says so) and emits a discriminated `create | patch` mutation instead of an unconditional `NoteCreate`.
- [ ] **First close (note absent):** the projection emits a `NoteCreate` byte-identical to today's output (no behaviour change on the common path — a regression pin).
- [ ] **Re-close / re-sync (note present at the target path):** the projection emits a region `NotePatch` (the meeting note's status/summary region — see Step-2.5 Q1), NOT a second `NoteCreate`; the patch's `newBody` is the region-inner content only.
- [ ] **Byte-idempotence (the W1 invariant):** the region body a `NoteCreate` writes for a note === the `newBody` a `NotePatch` targets for the same meeting input (`create-region === patch-newBody`), so a create-then-patch round-trips without drift. Pin with a test mirroring `project-sync-outputs.test.ts`.
- [ ] **WS-8 scoping:** the `noteExists` check is scoped to the meeting's workspace + the derived meeting-note path (path-within-workspace); it never consults another workspace's vault. A path that can't be uniquely/ safely derived ⇒ fail-closed to `create` is NOT acceptable if it could clobber — confirm the fail-closed direction at Step 2.5 Q3 (default: absent/ambiguous existence ⇒ treat as create ONLY when the path provably does not exist; otherwise withhold/patch — see Q3).
- [ ] **No frozen-contract / driver / KMP change** (as W1): the discriminated mutation + `NotePatch` already exist; the meeting driver and the KnowledgeMutationPlan contract are untouched. Cross-doc invariant = none.

## RED outline (write cases first; mirror `project-sync-outputs.test.ts`)
1. `first_close_emits_notecreate` — note absent ⇒ `mutation.kind === "create"`, byte-identical to today's `composeBody` output (regression pin).
2. `reclose_emits_region_notepatch` — note present ⇒ `mutation.kind === "patch"`, `patch.regionId` = the meeting region, `patch.newBody` = region-inner content (not a whole-note create).
3. `create_region_equals_patch_newbody` — for the same meeting input, the region body inside the created note === the patch `newBody` (byte-idempotent round-trip; the W1 invariant).
4. `existence_check_is_ws8_scoped` — the `noteExists` port is called with the meeting's workspaceId + the derived path; a foreign-workspace path is never consulted (assert the port args).
5. `fail_closed_direction` — the Q3-confirmed behaviour on absent/ambiguous existence (default: does not silently clobber).

## Cross-doc invariant impact (implementer flags Step 9; orchestrator writes docs)
- **Model field changes:** **none** — discriminated `create|patch` mutation + `NotePatch` already exist; driver + KMP contract unchanged (parity with W1 `9288bcd`, which added no contract). No Appendix-A / snapshot / registry change.
- **Architecture-doc note candidate:** none expected (parity fix within §9). If the meeting note needs a NEW region marker (Step-2.5 Q1), that's an additive `noteSlug.ts` constant, not a frozen seam — flag at Step 9 if so.

## Things to flag at Step 2.5 (design questions — default votes)
1. **Meeting-note patch unit.** Does a re-closed meeting note get a REGION patch (a `MEETING_*` region marker like `PROJECT_STATUS_REGION`) or a whole-note patch? Default vote: **region patch** mirroring projectSync (a status/summary region via a shared `noteSlug.ts` marker), so human content outside the region is preserved (§6). If no meeting region marker exists yet, ADD one as an additive `noteSlug.ts` constant (not a frozen seam). Confirm the meeting note's structure at Step 0.
2. **`noteExists` port reuse.** Default vote: **reuse the exact `NoteExistsReader` port + `meetingNotePath` builder pattern from projectSync W1** — no new port shape. Confirm the port name/signature.
3. **Fail-closed direction on absent/ambiguous existence.** Default vote: emit `create` ONLY when the derived path provably does NOT exist; on an existence-check error/ambiguity, prefer the SAFE branch that cannot clobber a human-authored note (a patch over a wrongly-assumed-absent note is safer than a create that duplicates/overwrites). Confirm — this is the safety-load-bearing call.

## Wiring / entry point / blocks
- **Entry point:** the meeting-closeout driver (live via the proof spine, `SOW_TEMPORAL=1`) calls the meeting-outputs projection; the create-vs-patch branch is exercised on a re-close/re-sync. Note at Step 7.5 (reachable through the live driver; the re-close branch is the newly-covered path).
- **Blocks:** nothing downstream. Closes a code-quality/data-integrity parity hazard.
- **Depends on:** the shipped projectSync W1 pattern (`9288bcd`) + the existing `NoteExistsReader` port + region-patch mechanism — all present.

## Estimated commit count
**1** (projection create-vs-patch + tests). Touches KnowledgeWriter-bound Markdown mutation shape ⇒ Step-8 review MANDATORY (the region patch must preserve human content outside its region; the WS-8-scoped existence check must not clobber).

## Lessons-logged candidates (implementer flags Step 9)
- Likely none new (parity with the already-banked projectSync-W1 create-vs-patch lesson). If the meeting region marker is added, note it. Implementer flags if a fresh convention emerges.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read `meetingOutputs.ts` + the projectSync W1 projector (`9288bcd`) + confirm the meeting-note structure (region vs whole-note) + the `NoteExistsReader` port name.
2. Step 2.5 — ping Q1–Q3 (defaults above; Q1 region-unit + Q3 fail-closed-direction are load-bearing) BEFORE writing cases.
3. RED first (the byte-idempotent `create-region === patch-newBody` invariant + the first-close regression pin are the load-bearing tests).
4. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality): the region patch must NOT clobber human content outside its region (§6 human-section preservation); the existence check must be WS-8-scoped; the fail-closed direction must not enable a silent clobber. Mirror the W1 review rigor.
5. Step 9 — categorized flags (esp. if a new meeting region marker was added → additive-constant note) + ship-ask.

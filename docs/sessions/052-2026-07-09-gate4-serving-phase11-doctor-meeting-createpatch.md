# Session 052 — gate-4 serving loader · propose-path eval · Phase-11 install-doctor · meeting create-vs-patch

- **Date:** 2026-07-09
- **Phase:** gate-4 Copilot-serving endgame (G1e-2) + runbook §3 · Phase 11 (opened) · Phase 7 hardening
- **Predecessor:** [051-2026-07-09-copilot-kmp-G4-dispatch-and-probe.md](051-2026-07-09-copilot-kmp-G4-dispatch-and-probe.md)
- **Successor:** _(none yet)_
- **Team:** single-track on `main` (orchestrator + implementer). Implementer = worker area.

## Why this session existed

Continue the endgame toward 100%: finish the last *build* piece of gate 4's serving side, land the propose-path governance eval (a go-live precondition), then pivot off the gate-4 arc (build-complete + HITL-deferred) to distance-to-100% work — opening Phase 11 with its non-gated deterministic core and closing a Phase-7 parity/data-integrity hazard. Four slices, each TDD + mandatory adversarial review.

## What was built (4 slices, 4 commits)

### 1. G1e-2 serving-context loader — `180c748`
The worker-side production `createServingContextLoader` that assembles the real per-workspace `WorkspaceServingContext` the gate-4 serving oracle runs over.
- **Files created:** `apps/worker/src/api/procedures/servingContextLoader.ts` (`createServingContextLoader` + injective `buildCitationResolver` + fail-closed `deriveServingCoverage` + dormant `selectServingOracleFactory`); `apps/worker/test/api/procedures/servingContextLoader.test.ts` (13 unit tests).
- **Files modified:** `apps/worker/src/boot.ts` (inline ternary → `selectServingOracleFactory`; interim always-degraded oracle stays the selected default).
- Fail-closed to `degraded` on every cannot-serve leg (no allow-set / empty vault / unresolvable signing key / degraded coverage / **workspace-id mismatch** — folded review LOW / **stale-revision parity** — folded review LOW); typed `err` only on an actual fault; never throws (§16). Coverage derived from real ParityReport/pin/oracle legs — never hardcodes green.

### 2. Propose-path governance eval — `e21536c`
Deterministic, egress-free governance-conformance battery over the committed §13.10a write-via-Approvals functions (runbook §3, flip-procedure step 3).
- **Files created:** `packages/evals/test/conformance/copilot-propose-governance.test.ts` (27 assertions + 1 `it.todo`).
- Covers runbook §3 assertions 1–4 (contentTrust fail-closed incl. absent-provenance TOCTOU · no-auto-apply · payload-swap TOCTOU reject · leakage/injection incl. the model-facing `handleCopilotProposeToolCall` text — folded review ADD); assertion 5 (real `query()` end-to-end) is a documented `it.todo` (real-egress deferred-HITL). No production code.

### 3. Phase-11.5 install-doctor check-engine — `fc1960d`
The non-gated deterministic core of the install doctor/repair command — opens Phase 11.
- **Files created:** `packages/contracts/src/install/doctor-result.ts` (Zod-as-source **non-seam** `DoctorReport`/`DoctorCheckResult`); `apps/worker/src/install/{doctor.ts,probe-snapshot.ts,checks/environment.ts,checks/posture.ts}`; `apps/worker/test/install/{doctor.test.ts,doctor-posture.test.ts}` (11 tests).
- **Files modified:** `packages/contracts/src/index.ts` (barrel export).
- Pure `runDoctor(ProbeSnapshot)→DoctorReport` (never throws; `safeCheck` folds any diagnoser throw to a fail-closed `probe_error`). 7 environment diagnosers (distinct repair per variant) + 3 **safety-critical one-writer posture** checks (REQ-S-NEW-008) fail-closed to `finding` (a writable/mispointed mount or a stray gbrain writer never resolves to a silent `ok`); stray-process finding redaction-safe by construction. Posture diagnosers made individually null-safe (folded review LOW).

### 4. meetingOutputs create-vs-patch parity — `1627ac2`
Brought the meeting-closeout projection to parity with the shipped projectSync **W1** (`9288bcd`); closes the re-sync clobber hazard.
- **Files created:** `packages/workflows/test/meeting-outputs-create-vs-patch.test.ts` (6 cases).
- **Files modified:** `packages/workflows/src/activities/projections/noteSlug.ts` (+`meetingNotePath` WS-8 authority, +`MEETING_OUTPUTS_REGION`, +`composeMeetingNote`); `.../projections/meetingOutputs.ts` (projection: +`noteExists`, returns `{mutation}`; `composeBody`→exported `composeMeetingRegionBody`; create-vs-patch branch); `.../activities/buildOutputs.ts` (`OutputsProjection` sig + `noteExists: NoteExistsReader` dep + async probe/route); `apps/worker/src/composition/buildActivities.ts` (production vault-backed `NoteExistsReader`); updated `meeting-outputs-projection.test.ts` + `meeting-activities.test.ts` to the `{mutation}` shape.
- First close → `NoteCreate` (wraps the body in a `meeting-outputs` region); re-close → region `NotePatch` (no clobber). `meetingNotePath` is the single authority for both the mutation path and the WS-8 probe (can't diverge). Fail-closed: probe error ⇒ `build_failed`/no-commit. Byte-idempotent (`create-region-inner === patch-newBody`). Driver + KMP contract unchanged.

## Decisions made
- **Serving/doctor land as DORMANT cores** (core-first/wire-later, mirroring the oracle-core): the loader-backed oracle stays behind an un-armed `goLiveArmed` seam; `runDoctor` has no production consumer until the bucket-B repair command. Nothing stamped/served live.
- **Coverage/posture fail-closed by ASSUME-WORST** — an absent/unknown/malformed probe yields the check's own finding (not a silent ok); coverage never hardcodes green; posture re-opens GO#1 on any writable/mispointed/stray state.
- **`doctor-result.ts` is a non-seam local `install/` result** (like `api/ui-safe.ts`) — no `__snapshots__`/registry/Appendix-A row. Confirmed no pull toward a frozen seam.
- **Meeting note whole-body-as-region** (over H1-outside): honors the case-1 "byte-identical to today's composeBody" pin at the region-inner level; the created note gains region markers (a benign, forward-compatible delta enabling the safe re-close, exactly W1's move).
- **Single commits** for G1e-2, install-doctor, and meetingOutputs where the safety-critical code shared a file with the rest (the clean split would need a working-tree revert-dance; nothing unrelated bundled — orchestrator-approved).

## Decisions explicitly NOT made (deferred)
- **Gate-4 propose go-live** — flipping the propose bridge live, the real `admitForServing`-backed serving oracle over KnowledgeWriter-authored corpora, the runbook §3 assertion-5 real-`query()` eval: all HITL/owner-gated, deferred.
- **Install-doctor bucket B** — the real OS/boot probe collectors + the CLI/boot repair command that calls `runDoctor` (unblocks 11.7 clean-install acceptance).
- **Marker-neutralization hardening** — a cross-cutting graceful-degrade for a literal `<!-- kw:region… -->` string appearing in meeting/project extraction content (BOTH `composeMeetingRegionBody` + projectSync's `composeRegionBody` share the fail-closed availability quirk; safe direction, not corruption). A future slice, not this parity fix.

## TDD compliance
**Clean — no violations.** Every slice was RED-first (failing test confirmed before implementation): G1e-2 (module-missing RED → GREEN), install-doctor (behavioral RED per feature), meetingOutputs (import-missing RED → GREEN). The propose-path eval is a conformance battery over already-committed code (green-against-committed by design; a stubborn red would have been a governance Finding — none occurred). Each safety surface got a MANDATORY Step-8 adversarial review (fresh general-purpose Agent), all **SHIP**.

## Reachability
- **G1e-2 loader** (`createServingContextLoader`/`buildCitationResolver`/`deriveServingCoverage`): **unreachable-by-design/DORMANT** — reachable only via the selector's un-armed `goLiveArmed` branch; documented waiver (same as the oracle-core). `selectServingOracleFactory` IS production-reachable via `bootstrapWorker → servingOracleFactory → copilot deps`.
- **Propose-path eval:** runs under `vitest run` + `/eval conformance` (test-reachable).
- **install-doctor `runDoctor`:** **unreachable-by-design/DORMANT** — no production consumer until the bucket-B repair command; documented waiver. Consumed by tests today.
- **meetingOutputs create-vs-patch:** **production-reachable** via the live meeting-closeout driver (`buildActivities → createBuildOutputsActivity → vault-backed noteExists`); the re-close (patch) branch is the newly-covered path.

_No later slice removed an earlier slice's wiring. The two dormancy waivers (loader, doctor) are expected and match the project's core-first pattern._

## Open follow-ups (Step-9 categorized — orchestrator routes at `/orchestrate-end`)
- **Lessons (candidates):** serving loader — pure-over-ProbeSnapshot-equivalent + page-fact-only resolver + fail-closed revision-bound coverage; install-doctor — pure-over-ProbeSnapshot + posture fail-closed + redaction-by-construction; propose-eval — non-vacuous deterministic governance battery. meetingOutputs — none new (parity with the banked W1 lesson).
- **Arch-doc notes:** §6 serving-oracle-seam "assembly built + dormant"; §13 install-doctor "check-engine core built (probes + repair command deferred)"; §9/§6 meeting create-vs-patch parity (no field change).
- **Runbook:** copilot-propose-go-live §3 propose-path eval row "must be green" → "green (built)".
- **Additive-constant notes:** `MEETING_OUTPUTS_REGION`/`composeMeetingNote`/`meetingNotePath` (noteSlug.ts); the `install/doctor-result.ts` non-seam contract + barrel export.
- **Future TODOs (deferred-HITL / bucket-B ledger):** propose go-live (real oracle + assertion-5 + corpora); install-doctor bucket-B probes + repair command; marker-neutralization cross-cutting hardening.
- **Cross-doc invariant change:** **NONE** — no frozen Appendix-A model field changed this session (no snapshot/schema/registry diff); the new `doctor-result.ts` is a non-seam local result.

## Gates
Repo-wide `turbo typecheck test` **31/31 green** after each cross-package slice; slice suites: G1e-2 13 · propose-eval 27+1 todo · install-doctor 11 · meeting 51 (6 new + updated). `/preflight` at close-out below.

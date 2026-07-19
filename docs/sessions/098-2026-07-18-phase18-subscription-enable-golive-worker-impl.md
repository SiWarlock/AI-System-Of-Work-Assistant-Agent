# Session 098 — Phase-18 subscription ENABLE crossing GO-LIVE (#13 Finding C 18.27 + the maiden real extraction + CP3)

- **Date:** 2026-07-18
- **Phase:** 18 (§19.5 Real Model Transport & Intelligence Legs) — the owner ENABLE / hard-line crossing (real cloud egress + real subscription extraction, Option B)
- **Role / track:** worker-impl (implementer), single-track `main`, team `session-4f4687dd`
- **Predecessor:** [`097-2026-07-18-phase18-subscription-arm-code-complete-worker-impl.md`](097-2026-07-18-phase18-subscription-arm-code-complete-worker-impl.md)
- **Successor:** [`100-2026-07-18-phase-exit-18-crossing-gate-orch.md`](100-2026-07-18-phase-exit-18-crossing-gate-orch.md) (the `/phase-exit 18` crossing gate + 18.28 hardening + round seal)
- **Outcome:** ⭐ GO-LIVE. The maiden real subscription extraction produced a gate-validated note end-to-end; safety PASS. Crossing sealed at `7180a49a` (orchestrator).

## Why this session existed

Resumed mid-crossing (fresh successor after a HARD-STOP cycle) to execute the Phase-18 subscription ENABLE (arm + first real extraction). The arm was code-complete + committed dormant (18.24/18.25/18.26). This session: (1) re-verified the arm to CP2, (2) — via a pre-spend dry-run — CAUGHT that the crossing was **not** code-complete for a real `agent_extraction`→note (a HALT before any spend), (3) built + shipped the fix (18.27 / #13 Finding C), (4) ran the ONE real extraction, human-gated, and (5) evaluated CP3.

## What was built

**Files created:**
- `apps/worker/test/composition/agent-extraction-broker.test.ts` — the 18.27 verification suite (7 tests): the real assembled broker accepts a valid `agent_extraction` candidate, rejects malformed / `__proto__`-polluted ones at the ajv layer, byte-equivalence for KMP jobs, the e2e faithful-reconstruction→note payoff, and the **load-bearing REQ-F-017 pin** (an inferred concrete value with no `evidenceRef` ⇒ rejected, no note; TBD positive control).

**Files modified (18.27 / #13 Finding C — commit `a20f9e7d`):**
- `apps/worker/src/composition/backends.ts` — registered `AGENT_EXTRACTION_SCHEMA_ID → AgentExtractionCandidateSchema` in `CANDIDATE_MODEL_SCHEMAS` so the broker schema-gate accepts + validates an `agent_extraction` candidate (previously `schema_rejected` — "no model parser"). Ships ON (deny-only), inert until a job carries that outputSchemaId.
- `apps/worker/src/boot.ts` — `withSubscriptionExtractionArming`: co-gate the source.process + meeting.close `outputSchemaId → sow:agent-extraction` flip on the ARMED branch (same `isProviderTransportArmed` signal, no split-brain). Dormant default stays KMP → byte-equivalent. (meeting.close's outputSchemaId flip is inert this slice — its cloud route is not armed, Finding-F.)
- `apps/worker/src/composition/buildActivities.ts` — source.process reads `sourceBinding.outputSchemaId ?? KMP`; added the optional `outputSchemaId?` carrier to the worker-internal `SourceIngestionParams` (no frozen-model change).

**Throwaway verification harnesses (built, run, then removed — never committed):** the CP2 arm-verification harness; the go/no-go dry-run harness; the env-gated maiden-run harness (`SOW_CP3_REAL_RUN` gate, personal-ws egress allowlist, capture-cost-immediately, HALT-not-force). Their outputs are the CP2/CP3 evidence; the note landed in an auto-deleted temp vault (content captured in stdout).

## Decisions made

- **Pre-spend dry-run FIRST caught #13 Finding C** — before spending a cent, a spend-free dry-run (fake completion at the SDK seam, real everything-else) surfaced that an armed real run would `schema_reject → EMPTY → no note`: source.process hardcoded `outputSchemaId: KMP` (buildActivities:795), the worker `CANDIDATE_MODEL_SCHEMAS` had no `agent_extraction` parser, and the flip was explicitly "#13 Finding C, reachability-WAIVERED". Verified in-source (not just the dry-run), raised as a Finding, HALTed the run.
- **Co-gate site = `withSubscriptionExtractionArming`** (not a manual override, not buildActivities-gated) — one arm signal drives route + ContextRef + outputSchemaId (no split-brain, L52/L61/L57).
- **Both legs flipped** (source + meeting) for parity; meeting.close inert this slice (its cloud route stays local, Finding-F) — comment tightened to say so.
- **Dry-run-first as the go/no-go** — the fix's e2e + a real-arm+fake-completion dry-run confirmed a note is produced before the real run.
- **The irreversible run stayed human-gated** — the auto-mode classifier blocked the autonomous real-egress/spend command (the right backstop); I did NOT work around it; the owner ran the exact packaged command himself + clicked the macOS Keychain "Allow".

## Decisions explicitly NOT made (deferred)

- **meeting.close cloud arming (Finding-F)** — meeting.close stays local this crossing; its outputSchemaId flip is inert until its route arms separately.
- **The note-projection / multi-task alignment** (see CP3 below) — a future-round quality refinement, routed to Carry-forward as non-material.
- **The 2 reviewer-deferred comment nuances** — optional tidy (the test "pre-impl vs post-impl" framing for the malformed cases; the buildActivities "AND-locked" comment describing an upstream invariant).

## TDD compliance

**CLEAN.** 18.27 was test-first (RED confirmed pre-impl on the three key tests: accept, reconstruct-and-commit, inferred-rejected), then GREEN. Dual-reviewed at Step-8: **security-reviewer CLEAN** (0 crit/high/med, all four invariants PASS — REQ-F-017 verified against the PRODUCTION `runSourceIngestion` run→validate→commit ordering, RED-on-weaken); **code-quality** 0 high/med, 3 low (2 comment fixes applied in-slice). Worker suite **1802/0** (35 skip); typecheck 20/20. The CP2/dry-run/maiden harnesses were verification (throwaway), not committed product code.

## Cross-doc invariants

**No cross-doc invariant change.** 18.27 registers an EXISTING frozen schema (`AgentExtractionCandidateSchema`/18.11) + adds a worker-internal optional field (`SourceIngestionParams.outputSchemaId`); no contracts/frozen-model field changed. Confirmed no `ARCHITECTURE.md` model-row edit owed (the §19.5 prose note "#13 Finding C landed" is the orchestrator's hot-routing at the seal).

## Reachability

- **18.27 co-gate** (`withSubscriptionExtractionArming` outputSchemaId flip + the `CANDIDATE_MODEL_SCHEMAS` registration) — WIRED + reachable on the ARMED path via `bootWorker` → `buildProofSpineActivities` → the broker schema-gate. **Proven live** by the maiden run (a real `agent_extraction` candidate flowed schema-gate → normalizer → `mapAcceptedMeetingExtraction` → `validateNoInference` → note).
- No tested-but-unwired gap. The registry entry is inert for non-agent-extraction jobs (byte-equivalent).

## CP3 — maiden run result (safety PASS)

- **Real subscription extraction:** effectiveArmed · broker.outcome OK · cost **$0.044772 metered (~$0 real on subscription)** · commit `rev:c416ed74`. A 2-task standup transcript → a 6-field `agent_extraction` candidate → a committed note.
- **evidenceRef faithfulness — PASS:** all 5 concrete-value refs are verbatim substrings of the source body; no invented values.
- **no-inference (REQ-F-017) — PASS, live:** the model emitted `task2_dueDate="TBD"` with NO evidenceRef for the one datum absent from the transcript (Sam's due date) — the no-inference sentinel, not an invention. `validateNoInference` accepted; `reconstructed.extraction == candidate` (faithful value+evidenceRef reconstruction on real output). This is the whole GATE-1 point proven live.
- **Quality observation (NOT safety):** the note frontmatter shows `owner=TBD/dueDate=TBD` because the L49 `[owner,dueDate]` convention keys on BARE field names, but the real model emitted MULTI-TASK task-prefixed fields (`task1_owner`, `task2_owner`, …) → bare `fields.owner`/`dueDate` absent → the frontmatter degrades to the TBD fail-safe (L49: absent → TBD, never invented). The body captured the transcript verbatim; no invention. A note-projection ↔ extraction-schema field-name alignment refinement for a future round.

## Open follow-ups

- **Step-9 (already routed hot; orchestrator writes at the seal):** §19.5 arch note (#13 Finding C landed — agent_extraction reachable on the armed path; the maiden-run "produces a note" premise now true e2e) + a worker LESSONS candidate.
  - **LESSONS candidate:** arming a new candidate KIND must ALSO register its parser in the WORKER schema-gate registry (`CANDIDATE_MODEL_SCHEMAS`), not just the contracts schema — else the armed run spends-and-produces-nothing (`schema_rejected → EMPTY → no note`); the pre-spend dry-run with a fake completion is the go/no-go that catches this downstream candidate→note gap that the spend-free CP2 arm-verification cannot.
  - **LESSONS candidate (CP3):** a real model emits a richer/task-prefixed extraction than the single-owner `[owner,dueDate]` frontmatter convention expects → the L49 fail-safe holds (TBD, no invention) but under-populates the note frontmatter → align the projection to the real extraction shape (multi-task → frontmatter mapping).
- **Future TODOs:** meeting.close cloud arming (Finding-F); the note-projection/multi-task alignment (Carry-forward, non-material); the 2 deferred review comment nuances.
- **MAIDEN-RUN precondition (documented, orthogonal to 18.27):** the armed source.process cloud `{runtime}` route + untrusted raw content requires the workspace egress policy to allowlist the cloud processor `claude-agent-sdk` in `allowedProcessors` + `rawContentAllowedProcessors` (personal ws ⇒ employer-raw veto N/A; fail-closed otherwise). Owner/run config, not code.

## Preflight status (`/session-end`)

Runnable gates GREEN: `pnpm install` ✓ · typecheck (`tsc --noEmit`) ✓ (20/20) · worker tests **1802/0** ✓ · security + code-quality reviews clean. The worker area's own `lint` script is `tsc --noEmit` (clean). **`pnpm lint` + `pnpm format:check` are BLOCKED repo-wide by an environmental tooling gap** — `eslint` and `prettier` are not resolvable via `pnpm exec` in this environment (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL: Command "eslint"/"prettier" not found`); this is a non-worker, pre-existing infra issue (this slice touched no tooling/deps), NOT a code violation. 18.27 is committed (`a20f9e7d`) and verified by the gates that run + the dual review. Flagged for infra follow-up (restore eslint/prettier resolution), not a code blocker.

## How to use what was built

The armed subscription path now produces a note end-to-end. On the ARMED path (`config.subscriptionArm` set + `withSubscriptionExtractionArming` applied), a real `agent_extraction` candidate clears the broker schema-gate, reconstructs faithfully, passes `validateNoInference`, and commits a note via the sole KnowledgeWriter. The shipped/unarmed default is byte-equivalent (KMP; the registry entry inert).

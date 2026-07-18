# /tdd brief — source_extraction_over_agent_extraction (CP-3)

## Feature
Switch the **source-ingestion** intelligence leg onto the first-class **`agent_extraction` `BrokerCandidate`** (mirroring CP-2's meeting leg), AND fix the `#13` precondition where **auto-ingest fails a source CLOSED at the schema gate** because no source `stubExtraction` is threaded through the worker host — so a real source's evidence-bearing extraction flows `run-leg → agent_extraction candidate → source SchemaGate → validateNoInference` FAITHFULLY, then projects for commit; and the dormant auto-ingest path produces a valid stub extraction (not a fail-closed reject). **ING-7 is preserved throughout: the untrusted-source job stays admitted READ-ONLY at broker admission (`admitJob`), never per-source, never in the adapter (worker Lesson 6/47).** **Two sub-slices, two commits — providers first, then worker. SAFE-BUILD: NO real model call, NO spend; the model output's evidenceRef faithfulness is eval-at-flip.**

## Use case + traceability
- **Task ID:** 18.13 (CP-3; crossing #13 precondition). Sub-slices: **18.13a** (providers, integrations-impl), **18.13b** (worker, worker-impl3).
- **Architecture sections it implements:** `ARCHITECTURE.md §19.5` (primary), `§9` (extraction legs / REQ-F-017), `§6` (ING-7 untrusted-content admission / rule 6), `§7` (broker candidate/pipeline).
- **Related context:**
  - **Reuses CP-2's producer pattern** — the `agent_extraction` union member + Zod-parsed normalizer + schema-id-from-`AgentJob.outputSchemaId` all landed in 18.12a; this slice adds the SOURCE extraction request + wires the SOURCE worker leg onto the same candidate kind.
  - **Source leg today (18.4):** the source-extraction leg + ING-7 (task #19, `120-18.4-source-extraction-leg-ing7.md`) routes imported content THROUGH the broker so `admitJob` runs ING-7 (L47: `!trusted && mutating ⇒ DENY`, `UNTRUSTED_CONTENT_MUTATING_TOOL`, source-type-agnostic, workspaceId from `ctx.workspaceId` never content). This slice must NOT weaken that — the extraction switch is orthogonal to admission.
  - **The `stubExtraction` threading gap (#13 precondition):** `makeProofSpineRegisterHook` (`apps/worker/src/temporal/registerWorker.ts:339`) accepts `stubExtraction?: StubMeetingExtraction` — MEETING only. The auto-ingest SOURCE path has no equivalent stub threaded, so a dormant source extraction yields an empty/absent extraction the source schema gate + `validateNoInference` reject → the source fails CLOSED before commit. Thread a source stub (mirror the meeting stub) so the dormant path produces a schema-valid stub extraction (a real extraction replaces it at flip).
  - **Source schema gate + no-inference:** the source equivalent of `createMeetingExtractionSchemaGate` (trace at Step 1 — likely a `createSourceExtractionSchemaGate` or the shared `ValidateExtractionPort` source path) composed with `validateNoInference`.

## Acceptance criteria (what "done" means)

### Sub-slice 18.13a — providers (producer), integrations-impl (depends 18.12a)
- [ ] **Source extraction REQUEST leg** — builds the Claude `json_schema` output-config from the CP-1 `AGENT_EXTRACTION_SCHEMA_ID` (schema id **from `AgentJob.outputSchemaId`**), strict/`additionalProperties:false`, source-appropriate prompt. Pin the request shape deterministically (model output = eval-at-flip). Reuse CP-2's normalizer path — a valid source output normalizes to an `agent_extraction` candidate, **Zod-parsed** (locked decision #3).
- [ ] **`evidenceRef` preserved** through the normalizer for the source candidate (same round-trip pin as CP-2).
- [ ] **ING-7 untouched** — the source job's admission posture (read-only for untrusted content) is not weakened by the extraction-request change; pin that an untrusted+mutating source job still DENIES at `admitJob`.
- [ ] **SAFE-BUILD:** run leg stays the dormant stub; additive.

### Sub-slice 18.13b — worker (consumer + stub threading), worker-impl3 (depends 18.13a + 18.12b pattern)
- [ ] **Source leg reconstructs the extraction FROM the accepted `agent_extraction` candidate** (mirror `mapAcceptedMeetingExtraction`) — evidenceRef faithful → source SchemaGate → `validateNoInference` → KMP projection. Non-`agent_extraction`/non-accepted ⇒ EMPTY ⇒ candidate-gate rejects (no commit).
- [ ] **Source `stubExtraction` threaded through `makeProofSpineRegisterHook`** (additive, mirror the meeting `StubMeetingExtraction` param) so the dormant auto-ingest source path produces a schema-VALID stub extraction that passes the gate — fixing the fail-closed #13 precondition. Default-absent ⇒ byte-equivalent (an unthreaded stub keeps today's behavior; only the auto-ingest wiring supplies it).
- [ ] **Faithful `evidenceRef` reaches source `validateNoInference`** — pin: concrete value WITH evidenceRef ⇒ ok; WITHOUT ⇒ `inferred_owner_or_date`; `TBD` ⇒ ok.
- [ ] **ING-7 preserved at the worker seam** — the source auto-ingest path still routes THROUGH the broker admission (L47); the stub-threading does not create a raw-around-the-gate bypass (rule 2).
- [ ] All unit tests pass; `/preflight` clean (both sub-slices).

## Wiring / entry point (Step 7.5)
- **18.13a:** source extraction request → normalizer → `agent_extraction` candidate; reachable-by-test; worker consumer lands in 18.13b.
- **18.13b:** auto-ingest source path → `makeProofSpineRegisterHook` (with source `stubExtraction`) → broker (`admitJob` ING-7) → source extraction reconstruction → source SchemaGate + `validateNoInference` → KMP → `applyPlan`. `/wired` the source stub through registerWorker.

## Files expected to touch (impl traces exact paths at Step 1)
- **18.13a:** `packages/providers/src/model/…` (source extraction request) + normalizer reuse + tests.
- **18.13b:** `apps/worker/src/composition/…` (source extraction reconstruction — the source sibling of `meeting-extraction.ts`); `apps/worker/src/temporal/registerWorker.ts` (source `stubExtraction` param, additive) + the auto-ingest wiring that supplies it; tests.

## RED test outline (Step 2)
**18.13a:** (1) `source_request_carries_json_schema_from_job_outputSchemaId`. (2) `valid_source_output_normalizes_to_agent_extraction_candidate_zod_parsed`. (3) `source_evidenceRef_round_trips`. (4) `untrusted_mutating_source_job_still_denies_at_admission` (ING-7 regression pin). `spec(§19.5)`/`spec(§6)`.
**18.13b:** (1) `source_leg_reconstructs_fields_with_evidenceRef`. (2) `concrete_value_without_evidenceRef_rejected` (+ WITH ⇒ ok). (3) `dormant_auto_ingest_source_stub_passes_the_gate_not_fail_closed` (the #13 precondition pin). (4) `unthreaded_source_stub_is_byte_equivalent`. (5) `source_auto_ingest_routes_through_admission_no_raw_bypass` (ING-7/rule-2). `spec(§9)`/`spec(§6)`.

## Cross-doc invariant impact
- No new model (reuses CP-1's `agent_extraction`). Behavior change on the source leg + a new additive `stubExtraction` param → flag for the §19.5 note + worker LESSONS; the `makeProofSpineRegisterHook` signature widening is additive (existing callers valid).

## Things to flag at Step 2.5
1. **Source schema-gate location** — is there a `createSourceExtractionSchemaGate`, or does the source path share `ValidateExtractionPort` with a source discriminator? Trace before writing (L6 — names approximate).
2. **Stub-threading shape** — is the source stub a distinct `StubSourceExtraction` type or a generalization of `StubMeetingExtraction`? Prefer additive/parallel to the meeting stub (L5); default-absent byte-equivalent.
3. **ING-7 boundary** — confirm the extraction switch changes only WHAT the leg extracts, never the admission posture; the untrusted-content read-only gate stays at `admitJob` (L6/L47), not the adapter.
4. **Auto-ingest wiring** — which composition root supplies the source stub? Confirm the default (unthreaded) stays byte-equivalent and only the armed auto-ingest path binds it.

## Dependencies + sequencing
- **Depends on:** CP-1 (`beb77b6d`), CP-2 18.12a (producer pattern) + 18.12b (worker reconstruction pattern). **18.13b depends on 18.13a committed.**
- **Blocks:** nothing downstream in Wave 2 (CP-5/CP-7 independent).

## Estimated commit count
**2** (18.13a providers, then 18.13b worker). **ISOLATE** each (REQ-F-017 + ING-7 rule 6). **security-reviewer = MANDATORY** on BOTH (REQ-F-017 evidence + ING-7 untrusted-content admission) + code-quality = every-slice.

## Lessons-logged candidates anticipated
- The source leg mirrors the meeting leg onto `agent_extraction`; the dormant auto-ingest path needs a threaded source stub so it degrades to a VALID stub extraction (not fail-closed), while the real extraction replaces it at flip — ING-7 admission is orthogonal and stays at the broker.

## How to invoke
1. **18.13a first:** `/tdd source_extraction_over_agent_extraction` in `integrations-impl` — reuse CP-2's normalizer; GROUND the source request json_schema on Context7; security-reviewer MANDATORY.
2. **18.13b after 18.13a commits:** `/tdd source_extraction_over_agent_extraction` in `worker-impl3` — trace the source gate + `registerWorker` stub seam; security-reviewer MANDATORY.

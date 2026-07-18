# /tdd brief — meeting_extraction_over_agent_extraction (CP-2)

## Feature
Switch the **meeting** intelligence leg from the `evidenceRef`-discarding KMP stand-in onto the first-class **`agent_extraction` `BrokerCandidate`** delivered by CP-1, so a real model's evidence-bearing extraction flows **run-leg → `agent_extraction` candidate → MeetingSchemaGate → `validateNoInference`** FAITHFULLY (each field's `evidenceRef` intact), then projects to a `KnowledgeMutationPlan` for commit. This closes the GATE-1 consumer half: today `mapAcceptedMeetingExtraction` echoes the *injected* extraction because the KMP stand-in candidate drops `evidenceRef` (worker Lesson 46 + the SAFE-BUILD note atop `meeting-extraction.ts` both defer this to "task #18 — the crossing"). **Two sub-slices, two implementers, two commits — providers first (producer), then worker (consumer). SAFE-BUILD: NO real model call, NO spend — the run leg stays 18.1's dormant stub; the model OUTPUT's `evidenceRef` faithfulness is eval-at-flip, not this slice.**

## Use case + traceability
- **Task ID:** 18.12 (CP-2; crossing #13; supersedes the deferred arch decision tracked as actions #18). Sub-slices: **18.12a** (providers, integrations-impl), **18.12b** (worker, worker-impl3).
- **Architecture sections it implements:** `ARCHITECTURE.md §19.5` (primary — the real-model intelligence legs), `§7` (broker candidate + pipeline; conformance-is-the-contract), `§9` (extraction legs / REQ-F-017), **Appendix A** (the `sow:agent-extraction` row CP-1 added).
- **Related context:**
  - **CP-1 surface (built, ready to consume):** `AgentExtractionCandidate` + `AgentExtractionCandidateSchema` + `AGENT_EXTRACTION_SCHEMA_ID` at `packages/contracts/src/models/agent-extraction.ts:82/89/92` (exported from `@sow/contracts`). Field shape: `{ value: string|number(finite)|boolean, evidenceRef?: string }`; structural gate (empty `{fields:{}}` valid; non-emptiness is the worker gate's job, L51/L46).
  - **Union home (providers):** `BrokerCandidate` at `packages/providers/src/broker/broker.ts:147` currently has ONLY `knowledge_mutation_plan` + `proposed_action`. CP-1 deliberately deferred the union-member add to here (locked decision #1 — a member with no producer would be dead). This slice adds the 3rd member.
  - **Schema/normalization gate (providers):** `packages/providers/src/broker/schema-gate.ts` (`applyUniversalRules:164`, `acceptAudit:213`) + `output-normalizer.ts` (`bySchemaIdNormalizer`, `enforceToolPolicyOnCandidate:111`). The normalizer keys the candidate by `AgentJob.outputSchemaId` (locked decision #2 — schema id rides the JOB, never the candidate type).
  - **Worker consumer:** `apps/worker/src/composition/meeting-extraction.ts` — `mapAcceptedMeetingExtraction(outcome, extraction):46` (returns `extraction` verbatim today; the SAFE-BUILD comment L12–16 names this reconstruction as the deferred crossing work) + `createMeetingExtractionSchemaGate():65` (already rule-7-safe, key-only reject messages). Composed into `ValidateExtractionPort`/`createValidateActivity` alongside the live `validateNoInference` (`packages/domain/src/validation/no-inference.ts:76`).
  - **Claude structured-output grounding (Context7, Anthropic official — GROUND THIS at Step 1):** the extraction REQUEST carries `output_config.format = { type: "json_schema", schema }` with `strict` / `additionalProperties:false` / `required` (resolve `/llmstxt/platform_claude_llms_txt`; verify current shape). `evidenceRef` = a verbatim source span the model is instructed to fill.

## Acceptance criteria (what "done" means)

### Sub-slice 18.12a — providers (producer), integrations-impl
- [ ] **`agent_extraction` union member added** to `BrokerCandidate` (`broker.ts:147`) — additive 3rd member carrying the CP-1 `AgentExtractionCandidate` (import the type from `@sow/contracts`). Existing kinds/consumers (`candidateImpliesMutatingAction`, `enforceToolPolicyOnCandidate`, `acceptAudit`, `applyUniversalRules`) still narrow; a non-exhaustive switch that would silently drop the new kind fails typecheck.
- [ ] **Meeting extraction REQUEST leg** (in `packages/providers/src/model/…`, traced at Step 1): builds the Claude `json_schema` output-config from the CP-1 schema (schema-id **from `AgentJob.outputSchemaId`**, never the candidate), strict/`additionalProperties:false`. Pin the request SHAPE deterministically (carries the right schema id + strict flags + the extraction prompt) — the model's actual output is eval-at-flip.
- [ ] **Schema gate emits an `agent_extraction` candidate** — a run-leg `AgentResult` whose output validates against `AGENT_EXTRACTION_SCHEMA_ID` normalizes to an `agent_extraction` `BrokerCandidate` **consuming the Zod-PARSED object, never raw ajv JSON** (locked decision #3 — belt-and-suspenders over the `__proto__` blocklist). A malformed output ⇒ typed `GateDeny` (no candidate), reject message field-key-only (rule 7; CP-7 hardens the general path).
- [ ] **`evidenceRef` preserved end-to-end** through the normalizer: a candidate field with `{value, evidenceRef}` round-trips with `evidenceRef` INTACT (the anti-KMP-stand-in pin).
- [ ] **SAFE-BUILD:** run leg stays the dormant stub — no real model executes; additive to the union (the KMP stand-in path is untouched until the worker half switches the meeting leg).

### Sub-slice 18.12b — worker (consumer), worker-impl3 (depends 18.12a committed)
- [ ] **`mapAcceptedMeetingExtraction` reconstructs the extraction FROM the accepted `agent_extraction` candidate** (`outcome.value.candidate.kind === "agent_extraction"`) — each field's `value` + `evidenceRef` reconstructed FAITHFULLY into the `AgentExtraction` fed to the gate, replacing today's verbatim echo of the injected `extraction`. A non-`agent_extraction` accepted candidate (legacy KMP stand-in, still valid for other legs) or a non-accepted outcome ⇒ EMPTY extraction (downstream candidate-gate rejects — no commit; preserve the L46 division of labor).
- [ ] **Faithful `evidenceRef` reaches `validateNoInference`** — pin: a concrete `value` WITH `evidenceRef` passes no-inference; the SAME concrete `value` WITHOUT `evidenceRef` is rejected `inferred_owner_or_date` (previously unreachable because the stand-in dropped it — this is the GATE-1 payoff). `TBD` value ⇒ ok (REQ-F-017 park).
- [ ] **Projection to KMP for commit unchanged downstream** — the reconstructed+validated extraction projects to the `KnowledgeMutationPlan` via the existing sole-writer path (rule 1); no new writer.
- [ ] **SAFE-BUILD / byte-equivalent on the dormant path:** with the run leg dormant, the leg still produces the same safe outcome (empty ⇒ no commit); only WHEN a real accepted `agent_extraction` candidate arrives does the faithful reconstruction change behavior.
- [ ] All unit tests pass; `/preflight` clean (both sub-slices).

## Wiring / entry point (Step 7.5)
- **18.12a:** the `agent_extraction` candidate is produced by the broker schema gate; reachable-by-test via the normalizer + a snapshot of the request shape. Its worker CONSUMER lands in 18.12b — so between the two commits the producer is reachability-waivered (L11); confirm the union member typechecks across all existing narrowers.
- **18.12b:** entry point is `createValidateActivity`/`ValidateExtractionPort` → `mapAcceptedMeetingExtraction` → `createMeetingExtractionSchemaGate` + `validateNoInference` → KMP projection → `applyPlan`. `/wired mapAcceptedMeetingExtraction` should trace to the meeting-closeout activity.

## Files expected to touch (impl traces exact paths at Step 1)
- **18.12a:** `packages/providers/src/broker/broker.ts` (union member); `packages/providers/src/model/…` (meeting extraction request); `packages/providers/src/broker/output-normalizer.ts` / `schema-gate.ts` (emit the kind, Zod-parsed) + tests.
- **18.12b:** `apps/worker/src/composition/meeting-extraction.ts` (reconstruction) + `apps/worker/test/composition/meeting-extraction.test.ts`; possibly the workflows `AgentExtraction`/`MeetingSchemaGate` port types (`packages/workflows`) if the reconstruction needs the candidate shape threaded — flag at 2.5 if it crosses to a shared port.

## RED test outline (Step 2)
**18.12a:** (1) `agent_extraction_is_a_brokercandidate_member` — union narrows the new kind; existing narrowers still compile. (2) `meeting_request_carries_json_schema_from_job_outputSchemaId` — strict/additionalProperties:false, schema id from the job. (3) `wellformed_output_normalizes_to_agent_extraction_candidate_zod_parsed`. (4) `malformed_output_denies_field_key_only`. (5) `evidenceRef_round_trips_through_the_normalizer`.
**18.12b:** (1) `accepted_agent_extraction_candidate_reconstructs_fields_with_evidenceRef`. (2) `concrete_value_without_evidenceRef_is_rejected_by_no_inference` (+ WITH ⇒ ok; the GATE-1 payoff pin). (3) `tbd_value_validates`. (4) `non_agent_extraction_or_unaccepted_outcome_yields_empty_extraction_no_commit`. (5) each RED test carries a `spec(§19.5)` / `spec(§9)` tag.

## Cross-doc invariant impact (implementer flags at Step 9; orchestrator writes the docs)
- **18.12a:** `BrokerCandidate` gains a member (shared providers contract) — flag as a `Cross-doc invariant change`; the orchestrator notes the §7/§19.5 union-member line (the Appendix-A row already exists from CP-1). Confirm no existing narrow breaks.
- **18.12b:** no new model; behavior change on the meeting leg (flag the L46 division-of-labor closure for the worker LESSONS + §19.5 note).

## Things to flag at Step 2.5
1. **Reconstruction seam** — does `mapAcceptedMeetingExtraction` receive the candidate via `BrokerOutcome.value.candidate` directly, or does the `AgentExtraction`/`MeetingSchemaGate` port (`@sow/workflows`) need widening to carry the candidate shape? Prefer reuse over duplicating the field type (L5).
2. **Schema-id-from-job** — confirm the request + normalizer both key off `AgentJob.outputSchemaId` (locked decision #2), not the candidate type.
3. **Zod-parsed consumption** — confirm the normalizer hands the worker a Zod-PARSED object (locked decision #3), and the `__proto__`/`constructor`/`prototype` blocklist from CP-1 is not re-bypassed by any raw-JSON path.
4. **Dormant-path byte-equivalence** — confirm the meeting leg's dormant-run outcome is unchanged (empty ⇒ no commit) until a real accepted `agent_extraction` arrives.

## Dependencies + sequencing
- **Depends on:** CP-1 (committed `beb77b6d`). **18.12b depends on 18.12a committed** (shared-checkout: land the producer's union member + full suite green before the worker consumer's gate — Wave-1 lesson).
- **Blocks:** CP-3 (source leg reuses this pattern). Critical path.

## Estimated commit count
**2** (18.12a providers, then 18.12b worker). **ISOLATE** each (REQ-F-017 / GATE-1 consumer). **security-reviewer = MANDATORY** on BOTH (REQ-F-017 evidence faithfulness + rule-2 candidate gate) + code-quality = every-slice.

## Lessons-logged candidates anticipated
- Closing the GATE-1 consumer half: an evidence-bearing `agent_extraction` candidate reconstructed FAITHFULLY (evidenceRef intact) so `validateNoInference` runs on real evidence — the KMP stand-in echo (L46) was only safe dormant.
- Future TODO — crossing: the extraction eval confirming the real model's `evidenceRef` faithfulness (eval-at-flip, owner's last step).

## How to invoke
1. **18.12a first:** `/tdd meeting_extraction_over_agent_extraction` in `integrations-impl` — Step 1 traces the model dir + normalizer; GROUND the Claude `json_schema` shape on Context7; Step 2.5 answers the 4 flags; security-reviewer MANDATORY.
2. **18.12b after 18.12a commits:** `/tdd meeting_extraction_over_agent_extraction` in `worker-impl3` — Step 1 traces `meeting-extraction.ts` + the port seam; Step 2.5 answers flag 1; security-reviewer MANDATORY.

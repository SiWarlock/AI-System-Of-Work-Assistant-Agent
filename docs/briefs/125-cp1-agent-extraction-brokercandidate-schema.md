# /tdd brief — agent_extraction_first_class_broker_candidate

## Feature
Promote the agent extraction output to a **first-class `agent_extraction` `BrokerCandidate` kind** + register its **Appendix-A JSON Schema** (evidence-preserving), so a real model's evidence-bearing extraction (an `ExtractionField` map carrying per-field `evidenceRef`) reaches `validateNoInference` FAITHFULLY. This is **GATE-1** of the crossing (the REQ-F-017 hard gate): today the meeting/source legs ride a **KMP stand-in** (`sow:knowledge-mutation-plan`) that DISCARDS `evidenceRef` — arming a real model over the stand-in would let an invented owner/date silently bypass no-inference. This slice adds the CONTRACT surface only; the legs that produce/consume it are CP-2/CP-3. **SAFE-BUILD: pure contract + schema, deterministic (TDD), NO real model call, NO spend.**

## Use case + traceability
- **Task ID:** 18.11 (CP-1; actions tracker #18 — the deferred/owner-gated arch decision; GATE-1 of crossing #13)
- **Architecture sections it implements:** `ARCHITECTURE.md §19.5` (primary — the real-model intelligence legs), `§7` (broker candidate + pipeline; conformance-is-the-contract), `§9` (extraction legs / REQ-F-017), **Appendix A** (the new schema is a frozen-surface model row).
- **Related context:**
  - **The gap (GATE-1):** `validateNoInference` (`packages/domain/src/validation/no-inference.ts:76` → `checkExtractionField:54`) rejects a concrete `value` whose `evidenceRef === undefined` as `inferred_owner_or_date`. The frozen KMP stand-in (`meeting.close` candidate under `KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID = "sow:knowledge-mutation-plan"`) has no per-field `evidenceRef`, so a real model's evidence-bearing fields can't reach the validator intact. Arming without this ⇒ REQ-F-017 silently defeated (per handoff-008 GATE-1 + worker Lesson 46).
  - **Field shape (already defined):** `ExtractionField<T> { value: T | typeof TBD; evidenceRef?: string }` (`packages/domain/src/validation/no-inference.ts:30`).
  - **Schema registry:** `packages/contracts/src/schema/registry.ts` (`buildSchemaRegistry(loadSchemasFromDir())`, lazy-cached); schema ids are per-model constants (mirror `KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID`, `packages/contracts/src/models/knowledge-mutation-plan.ts:39`).
  - **Claude structured-output grounding (Context7, Anthropic official — the schema shape we validate the model output against):** Claude's reliable-JSON path is `output_config.format = { type: "json_schema", schema }` with `strict` / `additionalProperties: false` / `required`. So the Appendix-A extraction schema = a strict object; each field carries `{ value, evidenceRef }`; we instruct Claude to fill `evidenceRef` with a verbatim source span. (The REQUEST that carries this schema is CP-2/CP-3's providers leg; this slice defines the CONTRACT the model output is validated against.)

## Acceptance criteria (what "done" means)
- [ ] **New `agent_extraction` `BrokerCandidate` kind** — an additive member of the discriminated union carrying the extraction field-map WITH per-field `evidenceRef` (`ExtractionField`-shaped: `value: primitive | TBD`, `evidenceRef?: string`). Existing kinds/consumers unchanged (additive — the KMP stand-in path stays until CP-2/CP-3 switch the legs).
- [ ] **New Appendix-A JSON Schema** (e.g. `sow:agent-extraction`) registered in the schema registry (loaded from the schema dir alongside the others): a strict object (`additionalProperties: false`, `required`), each field `{ value: <primitive | the "TBD" sentinel>, evidenceRef?: string }`. Malformed (missing `value`, non-primitive `value`, extra top-level keys) ⇒ schema-invalid.
- [ ] **Evidence-PRESERVING (the load-bearing property):** a candidate with a concrete `value` + `evidenceRef` round-trips through the schema validation with `evidenceRef` INTACT — so a downstream `validateNoInference` sees it (contrast the KMP stand-in, which drops it). Pin with an explicit round-trip assertion.
- [ ] **`TBD` sentinel** validates (a field may legitimately be `value: TBD` with no `evidenceRef` — REQ-F-017's park value).
- [ ] **Snapshot** for the new schema is GREEN (the schema-snapshot is the verify-by-test surface for the frozen surface).
- [ ] **Byte-equivalent / SAFE-BUILD:** additive only — no existing behavior changes, no real model call, no spend. The producers/consumers are CP-2/CP-3.
- [ ] **Cross-doc invariant (frozen surface):** this ADDS an Appendix-A model + a `BrokerCandidate` union member → flag at Step 9 as a `Cross-doc invariant change`; the orchestrator writes the ARCHITECTURE.md Appendix-A row + the §7/§19.5 note hot the same round.
- [ ] All unit tests pass; `/preflight` clean.

## Wiring / entry point (Step 7.5)
The new kind + schema are CONTRACT surfaces consumed by CP-2/CP-3 (which switch the meeting/source legs onto `agent_extraction` + wire the Claude request that emits it). This slice has NO production consumer yet — reachability of the new kind is **reachability-waivered until CP-2/CP-3** (worker Lesson 11); the SCHEMA is reachable-by-test (registered + snapshot-covered, verified-by-test). Confirm the registry loads + returns the new schema by id.

## Files expected to touch (contract-impl traces exact paths at Step 1)
**New/Modified:**
- `packages/contracts/src/models/` — the `agent_extraction` candidate model + `AGENT_EXTRACTION_SCHEMA_ID` (mirror `knowledge-mutation-plan.ts`).
- The `BrokerCandidate` discriminated union (wherever it lives — contracts) — additive member.
- The schema dir (the JSON Schema file loaded by `loadSchemasFromDir`) + registry wiring if needed.
- The schema snapshot test.

> If the `BrokerCandidate` union or the extraction field type lives in `packages/providers` or `packages/domain` rather than `packages/contracts`, trace it at Step 1 and flag the cross-package seam at Step 2.5 — the schema itself stays in contracts (the registry home).

## RED test outline (Step 2)
1. **`agent_extraction_is_a_valid_broker_candidate_member`** — the union accepts an `agent_extraction` candidate (type + discriminator); existing kinds still narrow.
2. **`extraction_schema_validates_wellformed_fieldmap`** — a `{ fields: { owner: {value, evidenceRef}, dueDate: {value: TBD} } }`-shaped candidate passes the registered schema.
3. **`extraction_schema_rejects_malformed`** — missing `value`, non-primitive `value`, and an extra top-level key (`additionalProperties:false`) each fail.
4. **`evidenceRef_round_trips_intact`** — a concrete `value` + `evidenceRef` survives validation with `evidenceRef` present (the evidence-preserving property; the anti-KMP-stand-in pin).
5. **`tbd_value_validates_without_evidenceRef`** — `value: TBD` with no `evidenceRef` is schema-valid (REQ-F-017 park value).
6. **`schema_registered_and_retrievable_by_id`** + snapshot — the registry returns the schema by its id; snapshot GREEN.

## Cross-doc invariant impact (implementer flags at Step 9; orchestrator writes the docs)
- **Model field changes:** YES — a NEW Appendix-A schema (`sow:agent-extraction`) + a NEW `BrokerCandidate` union member. Frozen-surface add. Orchestrator writes the Appendix-A row + the §7/§19.5 anchor note.
- **Shared-contract seam model touched?** YES — `BrokerCandidate` is a shared contract; additive member (existing consumers unaffected). Confirm no existing narrow breaks.

## Things to flag at Step 2.5
1. **Union home** — where `BrokerCandidate` + the extraction field type actually live (contracts vs providers vs domain). Default: the candidate kind rides the contracts union; the schema rides the contracts registry; the field reuses `packages/domain`'s `ExtractionField`. Flag if the field type must be re-exported/duplicated across the package boundary (prefer reuse over duplication, worker L5).
2. **Schema id + shape** — `sow:agent-extraction`; the field-map object shape (`fields: Record<name, {value, evidenceRef?}>`) mirroring the Claude `json_schema` (strict/additionalProperties:false). Confirm the `value` type union (string|number|boolean|null|the "TBD" sentinel) + how the sentinel is represented in JSON Schema.
3. **Additive-not-breaking** — confirm the KMP stand-in path (`meeting.close` under the KMP schema) is UNTOUCHED this slice (CP-2/CP-3 switch the legs); this slice only ADDS the surface. No behavior change ⇒ byte-equivalent.

## Dependencies + sequencing
- **Depends on:** nothing (foundational contract slice).
- **Blocks:** CP-2 (meeting leg over `agent_extraction`), CP-3 (source leg). Wave-1 critical path.

## Estimated commit count
**1** — contract + schema + registry + snapshot. **ISOLATE** (frozen-surface + REQ-F-017 hard gate). **security-reviewer = MANDATORY** (per the lead: frozen-surface + REQ-F-017) + code-quality = every-slice.

## Lessons-logged candidates anticipated
- **Convention candidate** — GATE-1 closure: an evidence-bearing extraction gets a FIRST-CLASS candidate kind + strict Appendix-A schema that PRESERVES `evidenceRef` end-to-end, so `validateNoInference` runs on the real model's evidence (a KMP stand-in that discards `evidenceRef` is only safe while the transport is dormant).
- **Future TODO — crossing:** the Claude extraction REQUEST that emits this schema (CP-2/CP-3 providers leg) + the extraction eval that confirms `evidenceRef` faithfulness (eval-at-flip, the owner's last step).

## How to invoke
1. **Read this brief end-to-end** — the 3 Step-2.5 questions need answers before GREEN.
2. **Run `/tdd agent_extraction_first_class_broker_candidate`** in the `contract-impl` session.
3. **Step 0 (Restate)** — GATE-1 contract surface; evidence-preserving; NO real model call; additive/byte-equivalent.
4. **Step 1 (Identify files)** — trace the `BrokerCandidate` union home + the schema registry + a sibling schema (`knowledge-mutation-plan`) + the snapshot pattern.
5. **Step 2.5** — send the test write-up + answers on the 3 questions; wait for `APPROVED.`/`TWEAK:`/`ADD:`.
6. **Step 8 reviewers** — security-reviewer (MANDATORY: frozen-surface + REQ-F-017) + code-quality-reviewer.
7. **Step 9** — categorized flags (the Cross-doc invariant add is expected — the orchestrator writes the Appendix-A row) + ship-ask.

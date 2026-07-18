# /tdd brief — rule7_reject_message_field_key_redaction (CP-7)

## Feature
Guarantee that **every extraction/schema-gate reject message carries field KEYS only — never field VALUES** (rule 7: raw content / secrets / prompts never reach a log sink or a surfaced message). Once a real model flows, a reject message that interpolates the offending value (e.g. an ajv default error echoing `data`, or a hand-built message embedding `f.value`) becomes a raw-content leak into logs/health/the renderer. Audit the worker-reachable extraction + schema-gate reject paths, and harden any that embed a value down to a **key-only** form. **Worker-only, one commit. SAFE-BUILD: a redaction-tightening — reduces what's surfaced, changes no accept/deny verdict.**

## Use case + traceability
- **Task ID:** 18.17 (CP-7; crossing #13 operational must-fix). Owner: worker-impl3. Independent — parallel-eligible.
- **Architecture sections it implements:** `ARCHITECTURE.md §19.5` (real-model legs), `§16` (observability / fail-closed degrade + redaction), and **safety rule 7** (secrets/raw-content/prompt redaction before any log sink — root `CLAUDE.md`).
- **Related context:**
  - **Already-safe reference:** `createMeetingExtractionSchemaGate` (`apps/worker/src/composition/meeting-extraction.ts:65`) already uses key-only messages (`field '${key}' value is not a primitive or TBD` — the KEY, never `f.value`). Use it as the pattern; do NOT regress it.
  - **Suspect surfaces (trace at Step 1):** the source extraction schema gate (CP-3 sibling); any ajv-driven validation whose error text (`error.message` / `error.data` / `instancePath` + value) is surfaced into a worker reject/`HealthItem`/log; `validateNoInference`'s `inferred_owner_or_date` reject (`packages/domain/src/validation/no-inference.ts:76` — **DOMAIN = contract-impl territory**; if the leak is there, flag at Step 2.5 for re-routing to contract-impl, do NOT edit domain from a worker slice).
  - **Redaction precedent:** worker L25/L53 — mint HealthItems/messages from SAFE tokens only (class + subjectRef + key + numeric limits), never the raw message/stack/value; L15 — a rejection test whose assertions live only in `.catch` is vacuously green (capture the reason + assert unconditionally).

## Acceptance criteria (what "done" means)
- [ ] **Audit** every worker-reachable extraction / schema-gate / candidate-gate reject-message construction and enumerate which (if any) embed a field VALUE (or raw content / a prompt). Record the audit list in the session doc.
- [ ] **Harden value-embedding messages to key-only** — a reject naming a bad field reports the field KEY + the structural reason (`not a primitive`, `evidenceRef is not a string`, `missing value`), NEVER the offending value. If an ajv error is surfaced, strip/replace its `data`/value-bearing text (keep `instancePath`/keyword/the key).
- [ ] **Load-bearing redaction pin (L15-safe):** feed a reject path a field whose VALUE is a recognizable secret-like sentinel (e.g. `"SECRET-LEAK-CANARY"`); assert UNCONDITIONALLY that the produced message + any minted `HealthItem` do NOT contain the canary, and DO contain the field key. A source-mutation proof: re-introducing `${value}` into the message turns the test RED.
- [ ] **No verdict change** — accept/deny outcomes are identical before/after; only the message text is redacted (byte-equivalent control flow).
- [ ] **Domain leak (if found) is flagged, not edited** — if `validateNoInference` (or any `packages/domain` reject) embeds a value, raise it at Step 2.5 as a cross-territory Finding → contract-impl owns the fix; this slice covers only worker-territory messages + pins the boundary.
- [ ] All unit tests pass; `/preflight` clean.

## Wiring / entry point (Step 7.5)
- Reject messages flow from the schema/candidate gates → the worker validation activity → `HealthItem` mint / log sink / (potentially) the renderer via a projection. `/wired` a representative reject from the gate to its surfacing sink to confirm the canary can't reach a log/health surface.

## Files expected to touch (impl traces exact paths at Step 1)
- `apps/worker/src/composition/` (source + meeting extraction gates; the validate activity); any worker reject→HealthItem mint site + tests. **NOT** `packages/domain` (flag instead).

## RED test outline (Step 2)
1. `reject_message_is_field_key_only_never_value` — a malformed field with a canary value ⇒ message contains the key, not the canary (unconditional assert, L15).
2. `minted_health_item_carries_no_raw_value` — the reject's `HealthItem` (if any) is value-free (rule 7 / L25/L53).
3. `source_mutation_reintroducing_value_goes_red` — documentary source-mutation proof.
4. `verdict_unchanged_only_message_redacted` — accept/deny parity.
5. each RED test carries `spec(§16)` / a rule-7 note.

## Cross-doc invariant impact
- No model/schema change. A redaction hardening → worker LESSONS candidate + a §16/§19.5 note. If a domain leak is found + routed to contract-impl, that becomes its own flagged cross-territory item.

## Things to flag at Step 2.5
1. **Audit scope** — the concrete list of reject sites that embed a value (or confirm none do beyond the already-safe meeting gate — in which case the slice becomes a REGRESSION-PIN + a source-mutation guard, still worth it: pin the invariant so a future value-embedding reject goes RED).
2. **Domain boundary** — is any leak in `packages/domain` (`validateNoInference`)? If so, it re-routes to contract-impl (flag, don't cross territory).
3. **ajv error text** — if ajv errors are surfaced anywhere, confirm the value-bearing portion is stripped.

## Dependencies + sequencing
- **Depends on:** nothing (independent). Parallel-eligible — dispatch this to worker-impl3 immediately (keeps the worker busy while integrations-impl runs CP-2a). Best done alongside/after CP-3 if it touches the same source-gate file, to avoid a shared-checkout collision — sequence commits.
- **Blocks:** the flip (rule-7-clean reject messages are a #13 precondition once a real model's content flows).

## Estimated commit count
**1** (worker-only). **ISOLATE** (rule 7). **security-reviewer = MANDATORY** (rule 7 redaction) + code-quality = every-slice.

## Lessons-logged candidates anticipated
- Extraction/schema reject messages are field-KEY-only by invariant (pinned with a canary + source-mutation proof, L15-safe) so a real model's raw values never leak into logs/health/renderer once the transport arms (rule 7); the meeting gate was already safe — the value is pinning the invariant against future regressions across all reject sites.

## How to invoke
1. **`/tdd rule7_reject_message_field_key_redaction`** in `worker-impl3`.
2. Step 1: audit the worker reject sites; if a domain leak surfaces, flag at 2.5 (don't cross territory).
3. Step 8: security-reviewer MANDATORY (rule 7).

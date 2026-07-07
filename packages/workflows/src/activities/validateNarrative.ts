// P3c (§13.5 / REQ-F-017) — the concrete ValidateNarrativePort. Produces the `ValidatedNarrative` brand the
// projectSync driver needs to commit; the ONLY producer of that brand, so this gate is structurally
// un-elidable. PURE + synchronous + never-throws.
//
// ★ WHY THIS IS NO-INFERENCE ONLY (the "is the schema gate redundant?" verdict, grounded in the code):
//   The port's contract names a composition — no-inference AND the ajv+Zod schema gate. In this pipeline the
//   two halves live in DIFFERENT places:
//   • The SCHEMA gate is owned UPSTREAM by the broker's candidate-data gate
//     (packages/providers/src/broker/schema-gate.ts `createSchemaGate`): it runs the FULL ajv-structural + model
//     Zod `.refine` composition against `job.outputSchemaId` on the RAW synthesis output, fail-closed (no
//     ajv-alone, LESSONS §3), BEFORE the `SynthesizeNarrativePort` returns the derived draft. Re-running ajv/Zod
//     here would be strictly redundant — same output, same schema, already validated. And there is no separate
//     "narrative-draft schema": `draft.fields` is an open `Record<string, ExtractionField<unknown>>` (the
//     concrete synthesis field shape is the §9/Phase-7 arch_gap), so there is nothing new to structurally check.
//   • The NO-INFERENCE gate is owned HERE. `SynthesizeNarrativePort` explicitly returns a CANDIDATE draft (prose,
//     not yet validated); the broker's no-inference view is OPTIONAL and runs over the RAW output — a different
//     representation, one extraction-step earlier. `draft.fields` is the EXACT representation
//     `BuildSyncOutputsPort.build` reads to produce the committed prose, so `validateNoInference(draft.fields)`
//     is the LAST gate on what actually gets committed (REQ-F-017). Non-redundant, load-bearing.
//
//   So the default concrete port = real no-inference + the brand. A future PINNED narrative-draft schema can be
//   wired via the injectable `narrativeSchema` hook WITHOUT a port change (it runs first, folding to
//   `schema_rejected`/`unsupported_claim`); today no such schema exists, so the hook is off by default.
//
// ⚠ GO-LIVE PRECONDITION (security review, session 047). The "schema gate already ran upstream" premise is
//   architecturally intended but NOT YET STRUCTURALLY ENFORCED: there is no concrete production
//   SynthesizeNarrativePort yet (only the test fake), and nothing asserts the synthesis AgentJob is dispatched
//   through the Broker (where `createSchemaGate` runs). This is SAFE while dormant — no real model output flows
//   through this port today. Before the real synthesize activity goes live, two things must land together:
//     (1) a conformance/eval assertion that the synthesis job IS dispatched via the Broker (so the ajv+Zod gate
//         provably ran on the raw output — otherwise omitting the re-run here would drop a real gate); AND
//     (2) a minimal narrative-draft schema wired ON via `narrativeSchema` (e.g. every field is
//         `{ value: primitive | TBD, evidenceRef? }`) — because the broker validates a DIFFERENT (raw →
//         normalized-candidate) representation than `draft.fields`, so the derived ExtractionField shape itself
//         is otherwise only no-inference-checked, never structurally checked. Tracked as a P4-wiring go-live gate.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { validateNoInference } from "@sow/domain";
import type {
  ProgressNarrativeDraft,
  ValidatedNarrative,
  ValidateNarrativePort,
  NarrativeRejection,
} from "../ports/projectSync";

/** The injected (default-off) narrative-schema check: a structural gate over the DERIVED draft, for a future
 *  pinned narrative-draft schema. Returns void on pass; a `schema_rejected`/`unsupported_claim` rejection
 *  otherwise. It is DISTINCT from the broker's output-schema gate (which validates the raw model output upstream)
 *  — this checks the extracted draft shape, which no schema pins today. */
export type NarrativeSchemaCheck = (
  draft: ProgressNarrativeDraft,
) => Result<void, { readonly code: "schema_rejected" | "unsupported_claim"; readonly message: string }>;

export interface ValidateNarrativeConfig {
  /** Optional draft-shape gate; default undefined (the schema gate is owned upstream by the broker). */
  readonly narrativeSchema?: NarrativeSchemaCheck;
}

/**
 * Build the concrete ValidateNarrativePort. `validate`:
 *   1. runs the OPTIONAL injected narrative-schema hook (default: none) — folds to schema_rejected/unsupported_claim;
 *   2. runs the LOAD-BEARING no-inference gate over `draft.fields` (REQ-F-017);
 *   3. on pass, emits the `ValidatedNarrative` brand (the commit-authorizing token) — prose only, no number.
 * NO side effect on a rejection (safety rule 2). Pure + synchronous; never throws.
 */
export function createValidateNarrativePort(config: ValidateNarrativeConfig = {}): ValidateNarrativePort {
  return {
    validate(draft: ProgressNarrativeDraft): Result<ValidatedNarrative, NarrativeRejection> {
      // 1. optional draft-shape gate (runs FIRST so a mis-shaped draft rejects as schema_rejected, not as a
      //    downstream no-inference artifact). Off by default — the raw-output schema gate ran at the broker.
      if (config.narrativeSchema !== undefined) {
        const s = config.narrativeSchema(draft);
        if (!s.ok) return err({ code: s.error.code, message: s.error.message, rejections: [] });
      }
      // 2. the LOAD-BEARING no-inference gate over the EXACT committed representation (REQ-F-017).
      const ni = validateNoInference(draft.fields);
      if (!ni.ok) {
        return err({
          code: "no_inference_violation",
          message: "REQ-F-017: narrative carries inferred or unbacked field(s)",
          rejections: ni.error,
        });
      }
      // 3. emit the ValidatedNarrative brand (the ONLY producer — the driver commits only a branded narrative).
      const validated: ValidatedNarrative = {
        validated: true,
        fields: draft.fields,
        ...(draft.schemaId !== undefined ? { schemaId: draft.schemaId } : {}),
      };
      return ok(validated);
    },
  };
}

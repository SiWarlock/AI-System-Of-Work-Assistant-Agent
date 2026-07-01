// spec(§7) — shared conformance-assessment core (task 5.10). DETERMINISTIC + PURE
// over an INJECTED schema gate: given a subject's produced candidate output for a
// capability, decides passing/failing and builds the persisted ConformanceResult.
// No clock, no network, no randomness — the caller supplies `checkedAt`.
//
// "Conformance is the contract" (§7): the gate is the §3 candidate-data JSON-Schema
// check (domain `validate`). OpenAI-compatible endpoints are NOT assumed identical —
// each subject's real output is proven against the capability's registered schema.
import { validate } from "@sow/domain";
import { isErr } from "@sow/contracts";
import type { Capability, EgressClass, ConformanceResult } from "@sow/contracts";
import type { ConformanceSubjectKind } from "@sow/contracts";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import { defaultSchemaRegistry } from "@sow/contracts/schema/registry";

/**
 * Injected structural gate: does `output` satisfy the capability's registered JSON
 * Schema? Returns a redaction-safe pass/fail + failure `detail` (error kind + JSON
 * field paths only — never raw content or a secret, §16). Default = the §3
 * ajv candidate-data gate over the process-wide registry.
 */
export type ConformanceGate = (
  output: unknown,
  schemaId: string,
) => { ok: boolean; detail?: string };

/** Build a ConformanceGate over a specific schema registry (default: process-wide). */
export function makeSchemaGate(registry: SchemaRegistry = defaultSchemaRegistry): ConformanceGate {
  return (output, schemaId) => {
    const r = validate(output, schemaId, registry);
    if (isErr(r)) {
      const e = r.error;
      const detail =
        e.code === "unknown_schema"
          ? `unknown_schema:${schemaId}`
          : `schema_violation:${
              (e.errors ?? [])
                .map((x) => x.path)
                .filter((p) => p.length > 0)
                .join(",") || "invalid"
            }`;
      return { ok: false, detail };
    }
    return { ok: true };
  };
}

/** Default conformance gate (process-wide `packages/contracts/schemas/*`). */
export const defaultConformanceGate: ConformanceGate = makeSchemaGate();

/** The identity of a conformance subject under test. */
export interface ConformanceSubject {
  readonly kind: ConformanceSubjectKind;
  readonly subjectId: string;
  readonly capability: Capability;
  readonly model: string;
  readonly egressClass: EgressClass;
  readonly outputSchemaId: string;
}

/** What a subject actually produced for a case: a candidate output, or a typed
 * production failure (provider/runtime error, or a budget cancel — no output). */
export type ProducedOutput =
  | { readonly ok: true; readonly candidateOutput: unknown }
  | { readonly ok: false; readonly detail: string };

/**
 * Assess a single (subject × capability × model) pair into a ConformanceResult.
 * A production failure OR a schema-gate rejection ⇒ `failing`; a gate pass ⇒
 * `passing`. Deterministic; `checkedAt` is caller-supplied (ISO datetime).
 */
export function assessCandidate(
  subject: ConformanceSubject,
  produced: ProducedOutput,
  checkedAt: string,
  gate: ConformanceGate = defaultConformanceGate,
): ConformanceResult {
  const base = {
    subjectKind: subject.kind,
    subjectId: subject.subjectId,
    capability: subject.capability,
    model: subject.model,
    egressClass: subject.egressClass,
    checkedAt,
  } as const;

  if (!produced.ok) {
    return { ...base, status: "failing", detail: produced.detail };
  }

  const gated = gate(produced.candidateOutput, subject.outputSchemaId);
  if (gated.ok) {
    return { ...base, status: "passing" };
  }
  return { ...base, status: "failing", ...(gated.detail !== undefined ? { detail: gated.detail } : {}) };
}

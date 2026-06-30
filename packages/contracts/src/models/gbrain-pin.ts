// GbrainPin seam model (task 4.20 / WT(§13), §6/§13). The typed config-contract
// for the `config/gbrain.pin` startup version-pin file: the GBrain adapter
// (packages/knowledge) reads the pin and verifies the running GBrain's commit
// SHA == gbrainSha — match enables the read/index surface against the pinned
// build; mismatch (or a PENDING sentinel) degrades that brain to
// read-only/index-only and opens a System Health item (fail-closed, §6/§13).
// `writeThroughEnabled` is a SEPARATE per-workspace gate from the version pin:
// default OFF (read-only/index-only fallback + kill switch), flipped ON only by
// the §12/task-12.22 enablement gate. Zod is the single source of truth: the TS
// type is `z.infer`, the JSON Schema is generated via `emitJsonSchema`. PURE —
// imports only zod (no branded fields).
import { z } from "zod";

/** Stable JSON-Schema `$id` for the schema registry. */
export const GBRAIN_PIN_SCHEMA_ID = "sow:gbrain-pin" as const;

// `validatedOn` is intentionally NOT a strict RFC3339 datetime (so NOT
// `z.string().datetime()`): it is EITHER an ISO date — the day the §12 four-GO
// round-trip went green LIVE against this SHA (a Phase-12 acceptance) — OR a
// PENDING_* sentinel while that validation is still owed. The two sentinels are
// spec-load-bearing: the §13 / task-4.20 enablement gate refuses to enable
// write-through (and the version-pin check refuses to serve) while `validatedOn`
// is either sentinel. Kept module-private here; task 4.20's file→model parser is
// the next consumer (see flags re: re-exporting + the camel/snake mapping).
const GBRAIN_PIN_VALIDATED_SENTINELS = [
  "PENDING_PHASE12",
  "PENDING_LIVE_VALIDATION",
] as const;

// arch_gap: Appendix A specifies `validatedOn` only as "ISO date | sentinel". An
// ISO date is matched as date-only (`YYYY-MM-DD`, the form `config/gbrain.pin`
// writes) OR a full RFC3339 datetime (forgiving superset); month/day RANGE
// validity is NOT pinned upstream, so it is not enforced here.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoDatetimeSchema = z.string().datetime();

const validatedOnSchema = z
  .string()
  .min(1)
  .refine(
    (s) =>
      (GBRAIN_PIN_VALIDATED_SENTINELS as readonly string[]).includes(s) ||
      ISO_DATE_RE.test(s) ||
      isoDatetimeSchema.safeParse(s).success,
    {
      message:
        "validatedOn must be an ISO date or a PENDING_PHASE12 / PENDING_LIVE_VALIDATION sentinel",
    },
  );

export const GbrainPinSchema = z
  .object({
    // 40-char lowercase-hex git commit SHA of the pinned GBrain build.
    gbrainSha: z.string().regex(/^[0-9a-f]{40}$/, "40-char lowercase-hex git commit sha"),
    // arch_gap: gbrainTag (human-readable release tag, e.g. "0.35.1.0") has no
    // upstream-specified format — modeled as a non-empty free string.
    gbrainTag: z.string().min(1),
    // Upstream clone URL the SHA is resolved against.
    gbrainRepo: z.string().url(),
    // `gbrain doctor --json` schema_version of the index format. Appendix A says
    // "number"; tightened to a non-negative integer (it is a doctor schema
    // version) — see flags.
    indexSchemaVersion: z.number().int().nonnegative(),
    validatedOn: validatedOnSchema,
    // arch_gap: validationRef is "path to the design spec / eval report" — a
    // free-string path with no upstream-specified shape.
    validationRef: z.string().min(1),
    // Per-workspace write-through gate; default OFF = read-only/index-only §6
    // fallback + kill switch. Flipped ON only by the §12/task-12.22 gate.
    writeThroughEnabled: z.boolean().default(false),
  })
  .strict();

export type GbrainPin = z.infer<typeof GbrainPinSchema>;

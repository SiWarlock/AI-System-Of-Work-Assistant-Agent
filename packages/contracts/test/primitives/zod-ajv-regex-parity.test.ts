// Zod-brand vs emitted-schema regex parity (task ### 24.89).
//
// THE DEFECT: `zod-to-json-schema` emits a `.regex()` brand's `pattern` as the
// regex SOURCE only — JSON Schema draft-07's `pattern` keyword has no flags
// mechanism, so a Zod `.regex(/…/i)` silently loses its case-insensitivity the
// moment the schema is emitted and compiled by ajv. Verified BEFORE this fix:
// `MdContentShaSchema` carried `/^[0-9a-f]{64}$/i`, while every emitted
// embedding schema (`semantic-fact.schema.json:26`,
// `fact-provenance.schema.json:21`, `signed-provenance-stamp.schema.json:12`,
// `divergence.schema.json:27`, `knowledge-mutation-plan.schema.json:227`)
// carried the flag-less `"pattern": "^[0-9a-f]{64}$"` — Zod ACCEPTED an
// uppercase sha256 hex that ajv REJECTED. Fix: drop `/i` (sha256 hex is
// canonically lowercase), tightening Zod to match all six emitted patterns.
//
// CENSUS — method + boundary, stated so a later reader doesn't have to
// re-derive it (root CLAUDE.md instrument discipline): every `.regex(` call
// site in `zod-brands.ts` was located (python regex over `\.regex\(`, 3 call
// sites: WorkspaceIdSchema/FactIdentitySchema/MdContentShaSchema), then each
// call's ARGUMENT was checked for a trailing JS regex flag — a literal
// `/…/<flags>` at the call site, or (for the two schemas that pass a named
// constant) a flag on that constant's own `/…/<flags>` declaration. Positive
// control: the same scan correctly matches `WORKSPACE_ID_RE` and
// `FACT_IDENTITY_RE`'s own literal declarations (proving it isn't blind to
// this file's actual regex literals). MEASURED: exactly ONE flag-bearing
// regex brand in `zod-brands.ts` today — `MdContentShaSchema`'s `/i` — not
// two; `WorkspaceIdSchema` and `FactIdentitySchema` carry no flags. (Widened
// to the whole owned territory —
// `packages/contracts/src/{primitives,models}` and
// `packages/domain/src/validation` — same result: one flag-bearer,
// `zod-brands.ts:190`; `gbrain-pin.ts:54`'s `.regex(/^[0-9a-f]{40}$/, ...)`
// carries none.)
//
// This suite still covers all THREE non-factory regex brands (not only the
// one flag-bearer), so a flag added to either of the other two in future reds
// here too — the test is data-driven over "every non-factory regex brand",
// which is a superset of "every flag-bearing" one and needs no maintenance
// when a brand gains or loses a flag.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  FactIdentitySchema,
  MdContentShaSchema,
  WorkspaceIdSchema,
} from "../../src/primitives/zod-brands";
import { emitJsonSchema } from "../../src/schema/emit";
import { buildSchemaRegistry } from "../../src/schema/registry";

interface RegexBrandCase {
  readonly name: string;
  readonly schema: z.ZodTypeAny;
  /** Probes chosen to exercise a case-flip per brand, plus a plain reject/accept pair. */
  readonly probes: readonly string[];
}

const REGEX_BRAND_CASES: readonly RegexBrandCase[] = [
  {
    name: "MdContentShaSchema",
    schema: MdContentShaSchema,
    probes: [
      "a".repeat(64), // lowercase — valid sha256 hex shape
      "A".repeat(64), // all-uppercase — exactly the shape the dropped `/i` admitted
      "AbCd" + "0".repeat(60), // mixed case, still 64 chars
      "not-hex-at-all",
      "a".repeat(63), // one short of the required length
    ],
  },
  {
    name: "WorkspaceIdSchema",
    schema: WorkspaceIdSchema,
    probes: ["employer-work", "EMPLOYER-WORK", "ws-1", "ws_1", ""],
  },
  {
    name: "FactIdentitySchema",
    schema: FactIdentitySchema,
    probes: ["page:slug", "PAGE:slug", "not-a-valid-identity"],
  },
];

describe("Zod regex-brand vs ajv-compiled emitted-schema parity (### 24.89)", () => {
  for (const { name, schema, probes } of REGEX_BRAND_CASES) {
    it(`${name}: ajv's verdict on the emitted schema agrees with Zod's verdict, for every probe`, () => {
      const schemaId = `sow:test-regex-parity-${name}`;
      const emitted = emitJsonSchema(schema, schemaId);
      const registry = buildSchemaRegistry([emitted]);
      const validate = registry.getValidator(schemaId);
      expect(validate, `${name} did not compile via ajv`).toBeTypeOf("function");

      for (const probe of probes) {
        const zodVerdict = schema.safeParse(probe).success;
        const ajvVerdict = validate!(probe);
        expect(
          ajvVerdict,
          `${name}: Zod said ${zodVerdict} but ajv said ${ajvVerdict} for ${JSON.stringify(probe)}`,
        ).toBe(zodVerdict);
      }
    });
  }
});

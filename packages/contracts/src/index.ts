// @sow/contracts — shared types, JSON Schemas, contract surface.
// Pure: imports nothing app- or adapter-side (§2.5 import-direction rule).
//
// Phase-1 contract freeze: this barrel re-exports the FULL frozen surface —
// primitives, the event catalog, the schema infrastructure, and every one of
// the frozen models (plus shared-enums / shared-shapes). `export *` is safe
// under verbatimModuleSyntax. No symbol collides across these modules (verified
// at freeze time); see registry-all.test.ts for the REQ-S-006 coverage proof.
//
// `SchemaRegistry` + `buildSchemaRegistry` (R7-c) are defined RIGHT HERE rather
// than re-exported from `./schema/registry.ts`, on purpose: that module also
// carries the fs-backed `defaultSchemaRegistry` (`import { readdirSync,
// readFileSync } from "node:fs"` at module scope), and `export *`ing it would
// pull that node:fs import into every consumer of this barrel — including a
// bundled/sandboxed context (e.g. a Temporal workflow bundle) that cannot
// resolve Node built-ins. Defining the ajv-only, fs-FREE half directly in the
// barrel keeps the whole barrel's transitive import graph free of node:fs /
// node:crypto (pinned by packages/domain/test/boundary/barrel-node-builtin-free
// .test.ts). `./schema/registry.ts` imports these two symbols back from here
// for its own re-export, so `@sow/contracts/schema/registry` (the deep-import
// path `packages/domain/src/validation/schema-gate.ts` uses) keeps exporting
// both `defaultSchemaRegistry` AND `SchemaRegistry`/`buildSchemaRegistry`
// unchanged.
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

export interface SchemaRegistry {
  has(id: string): boolean;
  getValidator(id: string): ValidateFunction | undefined;
  ids(): string[];
}

/**
 * Build a registry over a set of self-contained JSON Schemas, each keyed by its
 * own `$id`. Compiles every schema up front under `strict: true` + formats.
 */
export function buildSchemaRegistry(schemas: Record<string, unknown>[]): SchemaRegistry {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);

  const validators = new Map<string, ValidateFunction>();
  const idList: string[] = [];

  for (const schema of schemas) {
    const id = schema["$id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("buildSchemaRegistry: every schema must carry a non-empty string $id");
    }
    const validate = ajv.compile(schema);
    validators.set(id, validate);
    idList.push(id);
  }

  return {
    has: (id: string): boolean => validators.has(id),
    getValidator: (id: string): ValidateFunction | undefined => validators.get(id),
    ids: (): string[] => [...idList],
  };
}

// --- primitives ---
export * from "./primitives/ids";
export * from "./primitives/enums";
export * from "./primitives/result";
export * from "./primitives/failure";
export * from "./primitives/zod-brands";

// --- events ---
export * from "./events/catalog";

// --- schema infrastructure ---
export * from "./schema/emit";
export * from "./schema/field-set";
// (SchemaRegistry + buildSchemaRegistry are defined above, not re-exported
// from ./schema/registry — see the header comment.)

// --- shared model vocabulary ---
export * from "./models/shared-enums";
export * from "./models/shared-shapes";

// --- frozen models (27) ---
export * from "./models/agent-extraction";
export * from "./models/agent-job";
export * from "./models/approval";
export * from "./models/audit-record";
export * from "./models/divergence";
export * from "./models/egress-policy";
export * from "./models/entity-ref";
export * from "./models/external-write-envelope";
export * from "./models/fact-provenance";
export * from "./models/gbrain-pin";
export * from "./models/gbrain-proposed-fact";
export * from "./models/gbrain-read-grant";
export * from "./models/gcl-projection";
export * from "./models/health-item";
export * from "./models/knowledge-mutation-plan";
export * from "./models/notebook-mapping";
export * from "./models/parity-report";
export * from "./models/project";
export * from "./models/task";
export * from "./models/proposed-action";
export * from "./models/provider-matrix";
export * from "./models/provider-profile";
export * from "./models/provider-route";
export * from "./models/quarantine-record";
export * from "./models/semantic-fact";
export * from "./models/signed-provenance-stamp";
export * from "./models/source-envelope";
export * from "./models/tool-policy";
export * from "./models/workflow-run-ref";
export * from "./models/workspace";
export * from "./models/write-receipt";

// --- provider conformance (Phase 5, task 5.10) ---
export * from "./provider/conformance-result";

// --- observability (Phase 10.1: LogRecord type + redaction-marker vocabulary) ---
export * from "./observability/log-record";

// --- local app API surface (Phase 8.2: push-stream event catalog + UI-safe projections) ---
export * from "./api/ui-safe";
export * from "./api/events";

// --- config (Phase 10.7: non-secret config schema + secret-shape load guard) ---
export * from "./config/config-schema";

// --- install (Phase 11.5: install-doctor result — additive local result, NOT a frozen seam) ---
export * from "./install/doctor-result";

// --- contract-test fixtures (valid + invalid instances + FIXTURES registry) ---
// No symbol collides with the frozen surface above (verified at wiring time).
export * from "./fixtures/index";

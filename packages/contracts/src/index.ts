// @sow/contracts — shared types, JSON Schemas, contract surface.
// Pure: imports nothing app- or adapter-side (§2.5 import-direction rule).
//
// Phase-1 contract freeze: this barrel re-exports the FULL frozen surface —
// primitives, the event catalog, the schema infrastructure, and every one of
// the 27 frozen models (plus shared-enums / shared-shapes). `export *` is safe
// under verbatimModuleSyntax. No symbol collides across these modules (verified
// at freeze time); see registry-all.test.ts for the REQ-S-006 coverage proof.

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
export * from "./schema/registry";

// --- shared model vocabulary ---
export * from "./models/shared-enums";
export * from "./models/shared-shapes";

// --- frozen models (27) ---
export * from "./models/agent-job";
export * from "./models/approval";
export * from "./models/audit-record";
export * from "./models/divergence";
export * from "./models/egress-policy";
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

// --- contract-test fixtures (valid + invalid instances + FIXTURES registry) ---
// No symbol collides with the frozen surface above (verified at wiring time).
export * from "./fixtures/index";

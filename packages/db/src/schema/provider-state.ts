// Operational-store schema — provider state domain (Unit 1.14, §4/§7/§12).
//
// PERSISTS: ProviderProfile (frozen Appendix-A model). The typed description of
// a configured provider endpoint the ProviderMatrix routes capabilities onto,
// plus its conformance status.
//
// CLASSIFICATION: OPERATIONAL STATE — MUTABLE (conformanceStatus is updated by
// §12 conformance runs; cost caps / capabilities by config). NOT append-only,
// NOT a rebuildable read model — conformance results are operational truth.
//
// REQ-S-003 (safety rule 7, load-bearing): NO secret column. The model carries
// no apiKey/apiKeyRef/secret/token/credentials field — provider secrets resolve
// ONLY through SecretsPort/Keychain. Column parity makes that absence enforced.
//
// PARITY (REQ-D-002): column-name set MUST equal ProviderProfile's frozen
// top-level field-name set: { provider, endpoint, model, capabilities,
// egressClass, costCaps, conformanceStatus }. `capabilities` (Capability[]) and
// `costCaps` ({maxCostUsd?, maxRuntimeSeconds?}) are each stored as ONE json
// column NAMED by the top-level field.
//
// PK: composite over EXISTING columns (provider, endpoint, model) — a profile is
// identified by its provider × endpoint × pinned model; a composite PK adds NO
// column, so parity holds (no surrogate id).
//
// DIALECT/portability: SQLite single-source (see workspace-config.ts header).
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ProviderProfile } from "@sow/contracts";

export const providerProfiles = sqliteTable(
  "provider_state",
  {
    provider: text().$type<ProviderProfile["provider"]>().notNull(),
    endpoint: text().notNull(),
    model: text().notNull(),
    capabilities: text({ mode: "json" }).$type<ProviderProfile["capabilities"]>().notNull(),
    egressClass: text().$type<ProviderProfile["egressClass"]>().notNull(),
    costCaps: text({ mode: "json" }).$type<ProviderProfile["costCaps"]>().notNull(),
    conformanceStatus: text().$type<ProviderProfile["conformanceStatus"]>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.endpoint, t.model] }),
  }),
);

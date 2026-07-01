// Operational-store schema — PG-CORE MIRROR of the provider-state domain (Unit 2.1,
// §4/§7/§12). PARALLEL dialect of `../provider-state.ts`: persists ProviderProfile
// (frozen Appendix-A model) + conformance status. IDENTICAL column names + portable
// types (text; capabilities/costCaps as one `json` column each), composite PK over
// EXISTING (provider, endpoint, model) — adds NO column, parity holds — for the
// both-dialect repository contract suite (REQ-D-003).
//
// REQ-S-003 (safety rule 7): NO secret column — provider secrets resolve ONLY through
// SecretsPort/Keychain; column parity makes that absence enforced.
import { json, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import type { ProviderProfile } from "@sow/contracts";

export const providerProfiles = pgTable(
  "provider_state",
  {
    provider: text().$type<ProviderProfile["provider"]>().notNull(),
    endpoint: text().notNull(),
    model: text().notNull(),
    capabilities: json().$type<ProviderProfile["capabilities"]>().notNull(),
    egressClass: text().$type<ProviderProfile["egressClass"]>().notNull(),
    costCaps: json().$type<ProviderProfile["costCaps"]>().notNull(),
    conformanceStatus: text().$type<ProviderProfile["conformanceStatus"]>().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.provider, t.endpoint, t.model] }),
  }),
);

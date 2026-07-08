// Operational-store schema — PG-CORE MIRROR of the approvals domain (Unit 2.1,
// §4/§9/§10/§11). PARALLEL dialect of `../approvals.ts`: persists Approval (frozen
// Appendix-A model), IDENTICAL column names + portable types (text; optional model
// fields → nullable columns) for the both-dialect repository contract suite
// (REQ-D-003).
//
// REQ-S-003: no secret column (payload referenced by hash only — `payloadHash`).
import { pgTable, text } from "drizzle-orm/pg-core";
import type { Approval } from "@sow/contracts";
import { UNASSIGNED_WORKSPACE, DEFAULT_SUBJECT_KIND } from "../approvals";

export const approvals = pgTable("approvals", {
  id: text().$type<Approval["id"]>().primaryKey(),
  // §13.10a — actionRef is now OPTIONAL on the model (present iff subjectKind ===
  // "external_action"; a semantic_mutation card carries a `planRef` instead), so the
  // column is NULLABLE (no `.notNull()`). The indexed-access `$type` keeps the branded
  // alias NAMEABLE (a `NonNullable<>` wrapper unwraps it → TS4023 on the exported table).
  actionRef: text().$type<Approval["actionRef"]>(),
  // §13.10a — the pending-KMP ref (present iff subjectKind === "semantic_mutation"). Nullable.
  planRef: text().$type<Approval["planRef"]>(),
  // §13.10a — the SUBJECT discriminator (external_action | semantic_mutation). NOT NULL +
  // semantically-correct default so the additive ALTER backfills legacy rows to external_action.
  subjectKind: text()
    .$type<Approval["subjectKind"]>()
    .notNull()
    .default(DEFAULT_SUBJECT_KIND),
  // WS-4 inbox-scope attribution (frozen Approval field). NOT NULL + sentinel default so
  // the additive ALTER succeeds on a populated table; every write site supplies a real id.
  workspaceId: text()
    .$type<Approval["workspaceId"]>()
    .notNull()
    .default(UNASSIGNED_WORKSPACE as Approval["workspaceId"]),
  status: text().$type<Approval["status"]>().notNull(),
  actor: text().notNull(),
  channel: text().$type<Approval["channel"]>().notNull(),
  payloadHash: text().notNull(),
  // Optional model fields → nullable. snoozeUntil meaningful only while deferred
  // (contract `.refine`); expiresAt is the auto-expiry instant. Both ISO-8601.
  snoozeUntil: text(),
  expiresAt: text(),
});

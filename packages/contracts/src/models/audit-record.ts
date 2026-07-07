// AuditRecord seam model (task 1.9, §3/§4/§16). The operational audit-trail
// record — OPERATIONAL TRUTH, not a rebuildable read model (§16 Backup &
// Recovery). REDACTION-FRIENDLY (§16): the payload is referenced only by hash
// and before/after are human-readable SUMMARIES — there is NO raw-content field,
// so a record can be persisted/logged through the redaction layer without
// leaking secrets or raw Employer-Work content. Carries NO `id` (per the
// Appendix-A field list). Zod is the single source of truth: the TS type is
// `z.infer`, the JSON Schema is generated via `emitJsonSchema`. PURE — imports
// only zod (no branded ids, so `z.infer` names no module-private brand symbol —
// the EgressPolicy/SourceRef interface workaround is unnecessary here).
import { z } from "zod";

/** Stable JSON-Schema `$id` for the schema registry. */
export const AUDIT_RECORD_SCHEMA_ID = "sow:audit-record" as const;

// arch_gap: the `timestamps` shape is minimal spec-implied — §16/Appendix A name
// only "timestamps". `occurredAt` is when the audited event happened;
// `recordedAt?` is when the record was persisted (absent until persistence
// stamps it). Both ISO-8601 datetimes. `.strict()` so a parent gate rejects
// unknown nested keys.
const TimestampsSchema = z
  .object({
    occurredAt: z.string().datetime(),
    recordedAt: z.string().datetime().optional(),
  })
  .strict();

export const AuditRecordSchema = z
  .object({
    // arch_gap: actor identity taxonomy unspecified upstream (a human user, an
    // agent actor such as 'KnowledgeWriter', or a system/workflow actor) —
    // modeled as an OPEN non-empty string, NOT a closed enum.
    actor: z.string().min(1),
    // arch_gap: event taxonomy unspecified upstream (no closed event-name set
    // is given in §3/§4/§16) — modeled as an OPEN non-empty string, NOT a
    // closed enum.
    event: z.string().min(1),
    // Opaque references to the audited subjects (action / approval /
    // workflow-run / plan refs, etc.). arch_gap: ref grammar unspecified
    // upstream — per the task contract, a list of non-empty strings (may be
    // empty when the event references nothing).
    refs: z.array(z.string().min(1)),
    // arch_gap: payload hash algorithm/encoding unspecified upstream — modeled
    // as an OPEN non-empty string. The hash, NEVER the raw payload
    // (redaction-friendly, §16).
    payloadHash: z.string().min(1),
    // SUMMARIES (redaction-friendly, §16), never raw before/after content.
    // Required per the Appendix-A field list (which marks only `recordedAt?`
    // optional in this model) — see the lifecycle flag in the session return.
    beforeSummary: z.string(),
    afterSummary: z.string(),
    timestamps: TimestampsSchema,
    // OPTIONAL workspace attribution — the WS-8 scope key the audit→recent_changes
    // projector (§9.5) groups + filters by. OPTIONAL, not required: some
    // control-plane audit events are GLOBAL (unscoped) — e.g. the Tool-Gateway
    // external-write audit has no workspaceId in scope. Precedent: EventLogRecord /
    // LogRecord carry a nullable/optional workspaceId for exactly this reason. Kept
    // a PLAIN string (not the branded WorkspaceId) to preserve this model's
    // brand-free `z.infer` purity (see the header note + Lesson §1).
    workspaceId: z.string().min(1).optional(),
  })
  .strict();

export type AuditRecord = z.infer<typeof AuditRecordSchema>;

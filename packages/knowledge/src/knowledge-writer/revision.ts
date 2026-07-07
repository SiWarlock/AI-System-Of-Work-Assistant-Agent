// Revision identity + commit-record shapes for the KnowledgeWriter (§6, task 4.1).
//
// A revision id is a deterministic content hash of the WHOLE vault snapshot — it
// is the compare-revision precondition's currency: the writer commits against an
// expected base revision, and refuses (write_conflict) if the on-disk revision has
// moved. Because it is a pure function of bytes, an out-of-band writer (Obsidian
// Sync / iCloud / git — task 4.6) that changed the tree yields a different id and
// is detected, never silently clobbered.
//
// PURE at the compute surface: no clock/network/random. `node:crypto` hashing is
// deterministic. The commit RECORD (persisted for idempotent replay + audit) is a
// data shape only; its store is an injected port.
import { createHash } from "node:crypto";
import type { AuditRecord, WorkflowRunRef } from "@sow/contracts";

/** Opaque content-addressed revision identifier (`rev:<sha256>`). */
export type RevisionId = string;

/** Full vault state: vault-relative path → complete file content. */
export type VaultSnapshot = ReadonlyMap<string, string>;

const sha256 = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

/**
 * Compute the revision id of a whole-vault snapshot. Deterministic + order-
 * independent: entries are sorted by path, each folded in as `path\0sha256(body)`,
 * and the concatenation is hashed. An empty vault has a stable, well-defined id.
 */
export function computeRevisionId(snapshot: VaultSnapshot): RevisionId {
  const lines = [...snapshot.entries()]
    .map(([path, content]) => `${path}${String.fromCharCode(0)}${sha256(content)}`)
    .sort();
  return `rev:${sha256(lines.join("\n"))}`;
}

/** Revision equality (compare-revision precondition). */
export function compareRevision(a: RevisionId, b: RevisionId): boolean {
  return a === b;
}

/**
 * The durable record of one committed KnowledgeWriter revision. Persisted through
 * `KnowledgeRevisionStore` so a replay with the same `idempotencyKey` returns the
 * already-committed revision (no double write / no second AuditRecord), and so the
 * committed revision is traceable back to actor + source event + workflow run.
 */
export interface CommittedRevision {
  readonly revisionId: RevisionId;
  readonly baseRevisionId: RevisionId;
  readonly idempotencyKey: string;
  readonly planId: string;
  readonly actor: string;
  readonly sourceEventRef: string;
  readonly workflowRunRef: WorkflowRunRef;
  readonly auditRecord: AuditRecord;
  readonly committedAt: string;
}

/**
 * Operational-truth store of committed KnowledgeWriter revisions, keyed for
 * idempotent replay. Defined in-package: the frozen `@sow/db` interface set has an
 * audit repo + outbox but no knowledge-revision repo yet (arch_gap — flagged for
 * §4 / Phase-4 wiring). The concrete driver is out of scope; tests use an
 * in-memory fake. Methods never throw across the boundary.
 */
export interface KnowledgeRevisionStore {
  /** Idempotency lookup — returns the prior commit for this key, else undefined. */
  getByIdempotencyKey(idempotencyKey: string): Promise<CommittedRevision | undefined>;
  /** Persist a freshly committed revision (append-only; called once per commit). */
  record(revision: CommittedRevision): Promise<void>;
}

/** Fields the writer folds into the commit AuditRecord (§6). */
export interface AuditRecordInput {
  readonly actor: string;
  readonly sourceEventRef: string;
  readonly workflowRunRef: WorkflowRunRef;
  readonly idempotencyKey: string;
  readonly planId: string;
  readonly baseRevisionId: RevisionId;
  readonly newRevisionId: RevisionId;
  readonly beforeSummary: string;
  readonly afterSummary: string;
  readonly payloadHash: string;
  readonly occurredAt: string;
  /**
   * The committing plan's workspace (WS-8 scope for the §9.5 recent-changes projector). Optional on the
   * input for builder flexibility, but every real commit supplies it — a KnowledgeMutationPlan always
   * carries a workspaceId (the KN commit gate requires it). Folded onto the AuditRecord's optional field.
   */
  readonly workspaceId?: string;
}

/**
 * Build the single AuditRecord recorded on a successful commit. It carries the new
 * revision id, actor, source event ref, workflow run ref, idempotency key, and
 * before/after SUMMARIES only — never raw content (redaction-friendly, §16).
 */
export function buildCommitAuditRecord(input: AuditRecordInput): AuditRecord {
  return {
    actor: input.actor,
    event: "knowledge_writer.commit",
    refs: [
      input.sourceEventRef,
      input.workflowRunRef.workflowId,
      input.idempotencyKey,
      input.planId,
      input.newRevisionId,
    ],
    payloadHash: input.payloadHash,
    beforeSummary: input.beforeSummary,
    afterSummary: input.afterSummary,
    timestamps: { occurredAt: input.occurredAt },
    // Fold the workspace scope only when supplied — omit the key entirely otherwise (the field is optional
    // on AuditRecord; a global/unscoped commit stays workspaceId-less rather than carrying `undefined`).
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  };
}

/** Deterministic content hash of arbitrary JSON (the plan payload hash, §16). */
export function hashPayload(value: unknown): string {
  return sha256(JSON.stringify(value));
}

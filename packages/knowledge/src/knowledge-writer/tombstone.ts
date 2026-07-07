// KnowledgeWriter tombstone / removal commit-point primitive (§6, task 4.5,
// REQ-F-013). This is the Markdown COMMIT POINT of the §9 user-initiated
// cross-store deletion saga (workflow 9, step "Markdown tombstone via
// KnowledgeWriter"): an ordered, per-step-idempotent removal that
//   • REMOVES the targeted assistant-owned canonical content, yet
//   • preserves EVERY unaffected human-owned section (KN-7 — no collateral
//     deletion) and every untargeted assistant region byte-for-byte (KN-8), and
//   • leaves a TOMBSTONE, not a silent delete: a whole-note removal keeps the
//     file path with a machine-owned `<!-- kw:tombstone -->` stub so backlinks /
//     history resolve to a tombstone rather than a dangling reference.
//
// Like every KnowledgeWriter mutation it commits ATOMICALLY (temp-write+rename)
// at exactly one new revision, records exactly one AuditRecord + CommittedRevision,
// and is guarded by a compare-revision precondition so an out-of-band Obsidian /
// iCloud / git edit is a write_conflict (reconciled by task 4.6), never clobbered.
//
// SCOPE BOUNDARY (task 4.5 bullet 4): this primitive owns ONLY the Markdown
// commit point. The ordered cross-store purge orchestration — GBrain purge/re-index
// → event-store tombstone (history preserved) → read-model / external-ref
// reconciliation, with compensating states on partial failure — is owned by the
// §9 deletion workflow. Here we merely FIRE the post-commit GBrain purge via the
// task-4.4 trigger path; that purge is ASYNC and best-effort and NEVER rolls back
// the durable Markdown tombstone (REQ-D-001: the brain is a derived store).
//
// IDEMPOTENCY (task 4.5 bullet 2) — two independent mechanisms, both proving
// "crash/replay re-drive yields the same end state; no resurrection; no duplicate
// tombstone":
//   (a) same idempotencyKey  → the revision store short-circuits to the prior
//       commit (no second write, no second AuditRecord);
//   (b) a fresh key over an already-tombstoned vault → the projection yields ZERO
//       byte changes → a no-op success with no new revision/audit.
//
// NOT candidate data: a deletion plan is built DETERMINISTICALLY by the §9 saga
// from validated explicit user intent, not emitted by a model — so this primitive
// runs no ajv/Zod candidate-data gate (safety rule 2 governs model output). It
// still validates the command structurally and fails closed with typed variants.
//
// NEVER throws across the boundary (§16): every outcome is a typed `Result`.
import { ok, err } from "@sow/contracts";
import type { Result, AuditRecord, WorkflowRunRef } from "@sow/contracts";
import type { AuditRepository } from "@sow/db";
import { atomicCommit } from "../markdown-vault/atomic-write";
import type { FileChange, VaultFs } from "../markdown-vault/atomic-write";
import {
  parseSections,
  humanOwnedText,
  type AssistantSection,
} from "../markdown-vault/sections";
import {
  compareRevision,
  computeRevisionId,
  hashPayload,
  type CommittedRevision,
  type KnowledgeRevisionStore,
  type RevisionId,
  type VaultSnapshot,
} from "./revision";
import type { WriteConflict, CommitFailed } from "./writer";
import type {
  GbrainSyncOutcome,
  GbrainSyncTriggerFault,
  GbrainSyncTriggerInput,
} from "./gbrain-sync-trigger";

// The machine-owned marker a whole-note tombstone leaves behind. It lives in
// human text space but is NEVER human content (the `kw:` namespace is reserved
// for KnowledgeWriter), so the human-preservation check strips it before
// comparing. Fixed + singular so re-tombstoning never stacks a second marker.
const TOMBSTONE_MARKER = "<!-- kw:tombstone -->";

// ── command / deps / result shapes ──────────────────────────────────────────

/**
 * One note to tombstone. When `regionIds` is ABSENT the WHOLE note is tombstoned
 * (every assistant region removed + a note-level tombstone stub left behind). When
 * `regionIds` is PRESENT only those assistant regions are surgically excised — the
 * note lives on (no note-level stub), and every other region + all human content
 * stays intact. An id present in `regionIds` but already gone is a silent no-op
 * (supports idempotent re-drive).
 */
export interface TombstoneTarget {
  readonly path: string;
  readonly regionIds?: readonly string[];
}

/** One tombstone commit request (built by the §9 deletion saga). */
export interface TombstoneCommand {
  readonly workspaceId: string;
  /** The deletion saga / plan id — audit + purge linkage (never raw content). */
  readonly deletionId: string;
  readonly targets: readonly TombstoneTarget[];
  /** Compare-revision precondition — the revision the removal is computed against. */
  readonly expectedBaseRevision: RevisionId;
  readonly actor: string;
  readonly sourceEventRef: string;
  readonly workflowRunRef: WorkflowRunRef;
  readonly idempotencyKey: string;
  /** Human-readable removal reason (audit SUMMARY only — never raw content, §16). */
  readonly reason?: string;
}

/**
 * The post-commit GBrain purge/re-index trigger (task 4.4 `triggerGbrainSync`
 * shape). Injected + OPTIONAL: when absent the tombstone still commits and
 * drain-on-wake (task 4.6) re-derives the index later. Its result — success OR a
 * typed fault — is surfaced but NEVER fails the tombstone (async, never rolls back).
 */
export type PostCommitGbrainPurgeTrigger = (
  input: GbrainSyncTriggerInput,
) => Promise<Result<GbrainSyncOutcome, GbrainSyncTriggerFault>>;

export interface TombstoneDeps {
  readonly vault: VaultFs;
  readonly revisions: KnowledgeRevisionStore;
  readonly audit: AuditRepository;
  /** Injected clock (ISO-8601) — keeps the primitive deterministic under test. */
  readonly now: () => string;
  readonly triggerGbrainPurge?: PostCommitGbrainPurgeTrigger;
}

export interface TombstoneSuccess {
  readonly revisionId: RevisionId;
  /** Present IFF a NEW commit happened (absent on the idempotent no-op path). */
  readonly auditRecord?: AuditRecord;
  /** True when returned via idempotent replay of the SAME idempotencyKey. */
  readonly replayed: boolean;
  /**
   * False when the vault was ALREADY in the tombstoned end state (idempotent
   * no-op: no new revision, no new audit, no duplicate tombstone).
   */
  readonly changed: boolean;
  /** Paths touched by this tombstone commit (targets, in request order). */
  readonly affectedPaths: readonly string[];
  /** Assistant regions removed by this commit (0 on replay / no-op). */
  readonly removedRegionCount: number;
  /**
   * Best-effort post-commit purge outcome. NEVER affects the committed tombstone.
   * Absent when no trigger is wired, on the no-op/replay path, or when the trigger
   * unexpectedly threw (swallowed — the durable tombstone stands, drain-on-wake
   * re-indexes).
   */
  readonly purge?: Result<GbrainSyncOutcome, GbrainSyncTriggerFault>;
}

/**
 * Structural / safety rejection of a tombstone command (never thrown, §16):
 * - `empty_targets` — no targets given;
 * - `target_missing` — a named path is absent from the vault (a tombstone leaves a
 *   stub, so a missing file signals a plan/vault inconsistency — fail closed,
 *   never a silent no-op that could mask it);
 * - `malformed_markers` — a target note has a corrupt region layout (ownership
 *   can't be attributed safely — refuse rather than corrupt);
 * - `collateral_deletion` — the projected removal would drop human-owned content
 *   (defensive KN-7 backstop; unreachable by construction, fails closed if a bug
 *   ever regresses it).
 */
export interface TombstoneRejected {
  readonly code: "tombstone_rejected";
  readonly reason:
    | "empty_targets"
    | "target_missing"
    | "malformed_markers"
    | "collateral_deletion";
  readonly path?: string;
  readonly detail?: string;
}

/** Enumerable, never-silent failure surface (§16). */
export type TombstoneFailure = TombstoneRejected | WriteConflict | CommitFailed;

// ── the primitive ────────────────────────────────────────────────────────────

/**
 * Apply one tombstone/removal atomically. See the module header for the
 * pipeline + invariants. Returns the committed revision (+ its AuditRecord), an
 * idempotent replay/no-op, or a typed `TombstoneFailure`; NEVER throws.
 */
export async function applyTombstone(
  command: TombstoneCommand,
  deps: TombstoneDeps,
): Promise<Result<TombstoneSuccess, TombstoneFailure>> {
  // 1 — idempotent replay: a prior commit for this key returns without any new
  //     write or second AuditRecord (task 4.5 bullet 2, mechanism (a)).
  const prior = await deps.revisions.getByIdempotencyKey(command.idempotencyKey);
  if (prior !== undefined) {
    return ok({
      revisionId: prior.revisionId,
      auditRecord: prior.auditRecord,
      replayed: true,
      changed: true,
      affectedPaths: command.targets.map((t) => t.path),
      removedRegionCount: 0,
    });
  }

  // 2 — structural validation (deterministic deletion plan, not model candidate
  //     data — see the module header). No filesystem touch before it passes.
  if (command.targets.length === 0) {
    return err({ code: "tombstone_rejected", reason: "empty_targets" });
  }

  // 3 — compare-revision precondition against live on-disk state (no clobbering an
  //     out-of-band edit — task 4.6 reconciliation owns advancing the base).
  const snapshot = await readSnapshot(deps.vault);
  const onDisk = computeRevisionId(snapshot);
  if (!compareRevision(onDisk, command.expectedBaseRevision)) {
    return err({
      code: "write_conflict",
      expectedBaseRevision: command.expectedBaseRevision,
      onDiskRevision: onDisk,
    });
  }

  // 4 — project each target into post-tombstone bytes; collect the changed set.
  const next = new Map<string, string>(snapshot);
  const changes: FileChange[] = [];
  const affectedPaths: string[] = [];
  let removedRegionCount = 0;

  for (const target of command.targets) {
    const current = snapshot.get(target.path);
    if (current === undefined) {
      return err({
        code: "tombstone_rejected",
        reason: "target_missing",
        path: target.path,
      });
    }
    const projected = projectTombstone(current, target.regionIds);
    if (!projected.ok) {
      return err({
        code: "tombstone_rejected",
        reason: "malformed_markers",
        path: target.path,
        detail: projected.error,
      });
    }
    // KN-7 backstop: the removal must never disturb human-owned content.
    if (!humanPreserved(current, projected.value.next)) {
      return err({
        code: "tombstone_rejected",
        reason: "collateral_deletion",
        path: target.path,
      });
    }
    removedRegionCount += projected.value.removed.length;
    affectedPaths.push(target.path);
    if (projected.value.next !== current) {
      next.set(target.path, projected.value.next);
      changes.push({ path: target.path, content: projected.value.next });
    }
  }

  // 5 — idempotent content no-op: the vault is already in the tombstoned end state
  //     (task 4.5 bullet 2, mechanism (b)). No new revision/audit, no duplicate
  //     tombstone, no purge.
  if (changes.length === 0) {
    return ok({
      revisionId: onDisk,
      replayed: false,
      changed: false,
      affectedPaths,
      removedRegionCount: 0,
    });
  }

  // 6 — atomic all-or-nothing commit (temp-write+rename). The new revision id is
  //     the deterministic staging token — no clock/random enters the primitive.
  const newRevision = computeRevisionId(next);
  const committed = await atomicCommit(deps.vault, changes, tokenOf(newRevision));
  if (!committed.ok) {
    return err({
      code: "commit_failed",
      path: committed.error.path,
      cause: committed.error.cause,
    });
  }

  // 7 — record exactly one AuditRecord + CommittedRevision. Markdown is now durable
  //     (safety rule 1: a committed tombstone never rolls back) — a recording fault
  //     is a System-Health concern, not a rollback.
  const occurredAt = deps.now();
  const auditRecord: AuditRecord = {
    actor: command.actor,
    event: "knowledge_writer.tombstone",
    refs: [
      command.sourceEventRef,
      command.workflowRunRef.workflowId,
      command.idempotencyKey,
      command.deletionId,
      newRevision,
    ],
    payloadHash: hashPayload({
      deletionId: command.deletionId,
      targets: command.targets,
    }),
    beforeSummary: `revision ${command.expectedBaseRevision}`,
    afterSummary:
      `tombstone: ${affectedPaths.length} note(s), ` +
      `${removedRegionCount} region(s) removed` +
      (command.reason !== undefined ? `; ${command.reason}` : ""),
    timestamps: { occurredAt },
    // WS-8 scope for the §9.5 recent-changes projector — the tombstone command carries its workspaceId.
    workspaceId: command.workspaceId,
  };
  await deps.audit.append(auditRecord);

  const record: CommittedRevision = {
    revisionId: newRevision,
    baseRevisionId: command.expectedBaseRevision,
    idempotencyKey: command.idempotencyKey,
    planId: command.deletionId,
    actor: command.actor,
    sourceEventRef: command.sourceEventRef,
    workflowRunRef: command.workflowRunRef,
    auditRecord,
    committedAt: occurredAt,
  };
  await deps.revisions.record(record);

  // 8 — fire the post-commit GBrain purge/re-index (task 4.4 path). ASYNC +
  //     best-effort: a fault (typed OR thrown) NEVER rolls back the tombstone —
  //     the brain is derived and re-derives from the current (tombstoned) Markdown.
  const purge = await runPurge(deps.triggerGbrainPurge, {
    workspaceId: command.workspaceId,
    committedRevisionId: newRevision,
    planId: command.deletionId,
    // §16 AuditRecord carries no id; the committed revision id is the stable
    // commit linkage the health item threads through.
    auditRef: newRevision,
    sourceEventRef: command.sourceEventRef,
  });

  const success: TombstoneSuccess = {
    revisionId: newRevision,
    auditRecord,
    replayed: false,
    changed: true,
    affectedPaths,
    removedRegionCount,
    ...(purge !== undefined ? { purge } : {}),
  };
  return ok(success);
}

// ── projection ────────────────────────────────────────────────────────────────

interface TombstoneProjection {
  readonly next: string;
  readonly removed: readonly string[];
}

/**
 * Project one note's post-tombstone bytes. Removes the targeted assistant regions
 * (all of them when `regionIds` is absent = whole-note tombstone; only the named
 * ones otherwise), keeps every human span and every untargeted assistant region
 * verbatim, and — for a whole-note tombstone — leaves a single `<!-- kw:tombstone -->`
 * stub. PURE. A malformed region layout returns the parse reason (never corrupts).
 */
function projectTombstone(
  content: string,
  regionIds: readonly string[] | undefined,
): Result<TombstoneProjection, string> {
  const parsed = parseSections(content);
  if (!parsed.ok) {
    return err(
      parsed.error.regionId !== undefined
        ? `${parsed.error.reason}:${parsed.error.regionId}`
        : parsed.error.reason,
    );
  }
  const wholeNote = regionIds === undefined;
  const removeSet = wholeNote ? undefined : new Set(regionIds);
  const removed: string[] = [];
  let out = "";
  for (const section of parsed.value) {
    if (
      section.kind === "assistant" &&
      (wholeNote || removeSet!.has(section.regionId))
    ) {
      removed.push(section.regionId);
      continue; // excise this region
    }
    out += section.kind === "assistant" ? (section as AssistantSection).raw : section.text;
  }
  // Whole-note tombstone leaves a stub (tombstone, not silent delete). Surgical
  // region removal excises in place — the note lives on, no note-level stub.
  if (wholeNote) {
    out = ensureTombstoneMarker(out);
  }
  return ok({ next: out, removed });
}

/** Add the tombstone stub unless one is already present (no duplicate tombstone). */
function ensureTombstoneMarker(content: string): string {
  if (content.includes(TOMBSTONE_MARKER)) {
    return content;
  }
  const trimmed = content.replace(/\s+$/u, "");
  return trimmed.length === 0
    ? `${TOMBSTONE_MARKER}\n`
    : `${trimmed}\n\n${TOMBSTONE_MARKER}\n`;
}

// ── human-owned preservation (KN-7) ────────────────────────────────────────────

/**
 * Human-owned bytes compared modulo framing whitespace + the machine tombstone
 * marker (neither is human semantic content) — mirrors `ownership.ts`. Every
 * non-whitespace human character + its order is pinned.
 */
function humanSignature(content: string): string {
  const parsed = parseSections(content);
  const text = parsed.ok ? humanOwnedText(parsed.value) : content;
  return text.split(TOMBSTONE_MARKER).join("").replace(/\s+/gu, " ").trim();
}

function humanPreserved(prior: string, next: string): boolean {
  return humanSignature(prior) === humanSignature(next);
}

// ── helpers ────────────────────────────────────────────────────────────────────

async function readSnapshot(vault: VaultFs): Promise<VaultSnapshot> {
  const paths = await vault.list();
  const snapshot = new Map<string, string>();
  for (const path of paths) {
    const content = await vault.read(path);
    if (content !== undefined) {
      snapshot.set(path, content);
    }
  }
  return snapshot;
}

/** Staging-token form of a revision id (strip the `rev:` prefix / non-word chars). */
function tokenOf(revisionId: RevisionId): string {
  return revisionId.replace(/[^a-zA-Z0-9]/gu, "");
}

/**
 * Await the injected purge trigger. The trigger's own contract is no-throw (task
 * 4.4), but we defend anyway: an unexpected throw is swallowed to `undefined` so
 * the durable tombstone is NEVER rolled back by a purge fault — drain-on-wake
 * re-indexes later.
 */
async function runPurge(
  trigger: PostCommitGbrainPurgeTrigger | undefined,
  input: GbrainSyncTriggerInput,
): Promise<Result<GbrainSyncOutcome, GbrainSyncTriggerFault> | undefined> {
  if (trigger === undefined) {
    return undefined;
  }
  try {
    return await trigger(input);
  } catch {
    return undefined;
  }
}

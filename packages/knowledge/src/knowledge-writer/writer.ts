// KnowledgeWriter core — the SOLE autonomous writer of canonical Markdown
// (safety rule 1: one writer / no hidden brain, REQ-F-006 / KN-4 / KN-9), §6 /
// task 4.1. Every semantic mutation the whole system makes to a vault flows
// through `applyPlan`; this module exposes no raw-write export, so no other
// component can commit Markdown through this contract.
//
// Pipeline (each step fails closed with a typed variant, never a throw — §16):
//   1. idempotent-replay short-circuit (same idempotencyKey ⇒ prior revision)
//   2. COMPOSED candidate-data gate: ajv validate() ∘ Zod .parse ∘ ruleScopedMutation
//      (never ajv alone — ajv drops Zod .refine, so empty sourceRefs slips the
//      JSON-Schema layer; the Zod parse + §3 rule catch it — LESSONS §3)
//   3. compare-revision precondition (on-disk == expected base, else write_conflict)
//   4. project the plan into post-apply file bytes
//   5. ownership check hook (task 4.2) — BEFORE the secret scan and the commit
//   6. secret scan hook (task 4.3) — immediately BEFORE the atomic commit
//   7. atomic all-or-nothing commit (temp-write + rename)
//   8. record exactly one AuditRecord + one CommittedRevision (durable, replayable)
//
// No side effect (no Markdown write) happens before the gate passes (safety rule
// 2). The ownership + secret hooks are injected: task 4.1 ships pass-through
// defaults so the ORDERING and the typed variants exist now; tasks 4.2 / 4.3
// install the real predicates without touching the pipeline.
import { ok, err } from "@sow/contracts";
import type {
  Result,
  KnowledgeMutationPlan,
  NoteCreate,
  NotePatch,
  LinkMutation,
  FrontmatterPatch,
  AuditRecord,
  WorkflowRunRef,
  FactIdentity,
  MdContentSha,
  RevisionId as ContractRevisionId,
} from "@sow/contracts";
import {
  KnowledgeMutationPlanSchema,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
} from "@sow/contracts";
import { validate, ruleScopedMutation } from "@sow/domain";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import type { AuditRepository } from "@sow/db";
import { atomicCommit } from "../markdown-vault/atomic-write";
import type { FileChange, VaultFs } from "../markdown-vault/atomic-write";
import {
  buildCommitAuditRecord,
  compareRevision,
  computeRevisionId,
  hashPayload,
  type CommittedRevision,
  type KnowledgeRevisionStore,
  type RevisionId,
  type VaultSnapshot,
} from "./revision";
// Secure-by-default: the REAL ownership + secret predicates are the applyPlan
// defaults (a caller may still override via deps). ownership.ts / secret-scan.ts
// import only TYPES from this module (erased at runtime) so these value imports
// create no runtime cycle.
import { enforceHumanOwnership } from "./ownership";
import { scanForSecrets } from "./secret-scan";
// The on-disk frontmatter format codec (§13.10a gate 2 + its inverse). Kept in one module so the
// forward serializer and its inverse cannot drift; the region/link projection stays here.
import { serializeScalar, parseNote, composeNote, KW_STAMP_FRONTMATTER_KEY } from "./frontmatter";
import { stampProvenance, serializeStampFieldValue } from "./provenance-stamp";
import type { StamperDeps } from "./provenance-stamp";
// The SHARED page-hash core (gate 4 G1d-1): the writer mints its stamp through the SAME function
// deriveCanonicalFacts uses, so the (factIdentity, mdContentSha) bound here == what the serving gate re-derives.
import { computePageProvenance } from "../gbrain/derive/canonical-fact-deriver";

// ── injected hooks (tasks 4.2 / 4.3) ────────────────────────────────────────

export interface OwnershipCheckContext {
  readonly path: string;
  readonly priorContent: string | undefined;
  readonly nextContent: string;
  readonly plan: KnowledgeMutationPlan;
}
export interface OwnershipViolation {
  readonly code: "ownership_violation";
  readonly path: string;
  readonly regionId?: string;
  readonly reason?: string;
}
/** Human-owned-section guard (KN-7 / task 4.2). Default: pass. */
export type OwnershipCheck = (
  ctx: OwnershipCheckContext,
) => Result<void, OwnershipViolation>;

export interface SecretScanContext {
  readonly path: string;
  readonly content: string;
}
export interface SecretFound {
  readonly code: "secret_found";
  readonly path: string;
  readonly kind?: string;
}
/** Blocking pre-commit secret scan (reject-not-redact / task 4.3). Default: pass. */
export type SecretScan = (ctx: SecretScanContext) => Result<void, SecretFound>;

// ── command / deps / result shapes ──────────────────────────────────────────

/**
 * One KnowledgeWriter apply request. `plan` is CANDIDATE DATA (`unknown`) — the
 * writer runs the composed gate itself; nothing is trusted pre-validation.
 */
export interface KnowledgeWriteCommand {
  readonly plan: unknown;
  /** The revision the apply is computed against (compare-revision precondition). */
  readonly expectedBaseRevision: RevisionId;
  readonly actor: string;
  readonly sourceEventRef: string;
  readonly workflowRunRef: WorkflowRunRef;
  readonly idempotencyKey: string;
}

export interface KnowledgeWriterDeps {
  readonly vault: VaultFs;
  readonly revisions: KnowledgeRevisionStore;
  readonly audit: AuditRepository;
  /** Injected clock (ISO-8601). Keeps the writer deterministic under test. */
  readonly now: () => string;
  readonly ownershipCheck?: OwnershipCheck;
  readonly secretScan?: SecretScan;
  /** Schema-registry override (tests); defaults to the process registry. */
  readonly registry?: SchemaRegistry;
  /**
   * Gate 4 (G1d-2) provenance-signing seam. When PRESENT, the writer mints a `SignedProvenanceStamp` for each
   * changed page note and embeds it under the reserved `kwStamp` frontmatter key at commit — the authorship
   * proof the serving gate re-verifies. When ABSENT (the default / dormant case), the commit is BYTE-IDENTICAL
   * to today: no stamp is minted or embedded. Provisioned only once a real Keychain signing key exists.
   */
  readonly signing?: StamperDeps;
}

export interface WriteSuccess {
  readonly revisionId: RevisionId;
  readonly auditRecord: AuditRecord;
  /** True when returned via idempotent replay (no new write / no new audit). */
  readonly replayed: boolean;
}

export interface SchemaRejected {
  readonly code: "schema_rejected";
  readonly stage: "ajv" | "zod" | "scoped";
  readonly issues: readonly { readonly path: string; readonly message: string }[];
}
export interface WriteConflict {
  readonly code: "write_conflict";
  readonly expectedBaseRevision: RevisionId;
  readonly onDiskRevision: RevisionId;
}
export interface CommitFailed {
  readonly code: "commit_failed";
  readonly path: string;
  readonly cause: unknown;
}

/**
 * Enumerable, never-silent failure surface (§16). The four semantic/policy
 * variants (schema_rejected | write_conflict | ownership_violation | secret_found)
 * are the ones the brief pins; `commit_failed` is the typed infrastructure-fault
 * route (a filesystem fault mid-commit) — still typed, still routable to System
 * Health, never a swallowed throw.
 */
export type WriteFailure =
  | SchemaRejected
  | WriteConflict
  | OwnershipViolation
  | SecretFound
  | CommitFailed;

// ── the writer ───────────────────────────────────────────────────────────────

// (The former pass-through no-op defaults were a fail-OPEN hole — an uninjected
// caller got NO ownership/secret enforcement. Defaults are now the real predicates.)

/**
 * Apply one KnowledgeMutationPlan atomically. See the module header for the
 * pipeline + invariants. Returns the committed revision + its AuditRecord, or a
 * typed `WriteFailure`; NEVER throws across the boundary.
 */
export async function applyPlan(
  command: KnowledgeWriteCommand,
  deps: KnowledgeWriterDeps,
): Promise<Result<WriteSuccess, WriteFailure>> {
  const ownership = deps.ownershipCheck ?? enforceHumanOwnership;
  const scan = deps.secretScan ?? scanForSecrets;

  // 1 — idempotent replay: a prior commit for this key returns without any new
  // write or second AuditRecord (§6 idempotency).
  const prior = await deps.revisions.getByIdempotencyKey(command.idempotencyKey);
  if (prior !== undefined) {
    return ok({
      revisionId: prior.revisionId,
      auditRecord: prior.auditRecord,
      replayed: true,
    });
  }

  // 2 — composed candidate-data gate (ajv → Zod → §3 scoped rule). No filesystem
  // touch happens before this passes (safety rule 2).
  const gated = runGate(command.plan, deps.registry);
  if (!gated.ok) {
    return gated;
  }
  const plan = gated.value;

  // 3 — compare-revision precondition against the live on-disk state.
  const snapshot = await readSnapshot(deps.vault);
  const onDisk = computeRevisionId(snapshot);
  if (!compareRevision(onDisk, command.expectedBaseRevision)) {
    return err({
      code: "write_conflict",
      expectedBaseRevision: command.expectedBaseRevision,
      onDiskRevision: onDisk,
    });
  }

  // 4 — project the plan into post-apply bytes; derive the changed file set.
  const projected = projectPlan(snapshot, plan);
  const changes = diffChanges(snapshot, projected);

  // 5 — ownership check (task 4.2), BEFORE the secret scan and the commit.
  for (const change of changes) {
    const decision = ownership({
      path: change.path,
      priorContent: snapshot.get(change.path),
      nextContent: change.content,
      plan,
    });
    if (!decision.ok) {
      return err(decision.error);
    }
  }

  // 6 — blocking secret scan (task 4.3), immediately BEFORE the commit. Runs over the SEMANTIC changes; the
  // gate-4 provenance stamp embedded below is machine-generated writer metadata (an HMAC of public fields),
  // not secret-bearing content, so it is deliberately not re-scanned.
  for (const change of changes) {
    const decision = scan({ path: change.path, content: change.content });
    if (!decision.ok) {
      return err(decision.error);
    }
  }

  // 6b — gate 4 (G1d-2): embed a KnowledgeWriter authorship stamp into each changed page note. DORMANT unless a
  // signing key is provisioned (absent ⇒ committedProjected === projected, committedChanges === changes ⇒
  // byte-identical to today). Runs AFTER ownership + secret (the stamp is the writer's OWN provenance, not a
  // semantic mutation subject to the human-ownership gate, and not secret-bearing) and BEFORE the commit so the
  // committed bytes + recorded revision carry it. The stamp binds the page hash over BASE bytes; kwStamp is
  // carved out of that hash (G1b), so embedding it never perturbs what it signs (⇒ no next-commit conflict).
  const committedProjected =
    deps.signing !== undefined
      ? await embedProvenanceStamps(snapshot, projected, plan, deps.signing, {
          sourceEventRef: command.sourceEventRef,
          baseRevision: command.expectedBaseRevision,
          now: deps.now,
        })
      : projected;
  const committedChanges =
    deps.signing !== undefined ? diffChanges(snapshot, committedProjected) : changes;

  // 7 — atomic all-or-nothing commit (temp-write + rename). The new revision id
  // is the deterministic staging token — no clock/random enters the primitive.
  const newRevision = computeRevisionId(committedProjected);
  const committed = await atomicCommit(deps.vault, committedChanges, tokenOf(newRevision));
  if (!committed.ok) {
    // Both atomic phases (stage_failed / commit_failed) roll the vault back to the
    // prior revision; surface either as the single typed infra-fault variant.
    return err({
      code: "commit_failed",
      path: committed.error.path,
      cause: committed.error.cause,
    });
  }

  // 8 — record exactly one AuditRecord + one CommittedRevision. Markdown is now
  // durable (safety rule 1: committed_to_markdown never rolls back), so a recording
  // fault is a System-Health concern, not a rollback — the commit stands.
  const occurredAt = deps.now();
  const auditRecord = buildCommitAuditRecord({
    actor: command.actor,
    sourceEventRef: command.sourceEventRef,
    workflowRunRef: command.workflowRunRef,
    idempotencyKey: command.idempotencyKey,
    planId: plan.planId,
    baseRevisionId: command.expectedBaseRevision,
    newRevisionId: newRevision,
    beforeSummary: `revision ${command.expectedBaseRevision}`,
    afterSummary: summarize(plan, changes.length),
    payloadHash: hashPayload(plan),
    occurredAt,
    // WS-8 scope for the §9.5 recent-changes projector — the plan always carries a workspaceId (KN gate).
    workspaceId: plan.workspaceId,
  });
  await deps.audit.append(auditRecord);

  const record: CommittedRevision = {
    revisionId: newRevision,
    baseRevisionId: command.expectedBaseRevision,
    idempotencyKey: command.idempotencyKey,
    planId: plan.planId,
    actor: command.actor,
    sourceEventRef: command.sourceEventRef,
    workflowRunRef: command.workflowRunRef,
    auditRecord,
    committedAt: occurredAt,
  };
  await deps.revisions.record(record);

  return ok({ revisionId: newRevision, auditRecord, replayed: false });
}

// ── the composed candidate-data gate ─────────────────────────────────────────

function runGate(
  candidate: unknown,
  registry: SchemaRegistry | undefined,
): Result<KnowledgeMutationPlan, SchemaRejected> {
  // (a) ajv structural gate (REQ-S-006).
  const structural =
    registry === undefined
      ? validate(candidate, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID)
      : validate(candidate, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, registry);
  if (!structural.ok) {
    return err({
      code: "schema_rejected",
      stage: "ajv",
      issues: structural.error.errors ?? [
        { path: structural.error.schemaId, message: structural.error.code },
      ],
    });
  }

  // (b) Zod parse — recovers the `.refine` rules ajv/JSON-Schema drop (LESSONS §3),
  // e.g. the non-empty sourceRefs requirement.
  const parsed = KnowledgeMutationPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    return err({
      code: "schema_rejected",
      stage: "zod",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const plan = parsed.data;

  // (c) §3 universal scoped-mutation rule (REQ-F-006): workspaceId + ≥1 sourceRef.
  const scoped = ruleScopedMutation(plan);
  if (!scoped.ok) {
    return err({
      code: "schema_rejected",
      stage: "scoped",
      issues: (scoped.error.fields ?? []).map((f) => ({
        path: f,
        message: scoped.error.code,
      })),
    });
  }

  return ok(plan);
}

// ── plan projection (interim; region/link byte-semantics firm up in task 4.2) ─

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

/**
 * Read the current whole-vault revision id LIVE from `vault` — `computeRevisionId ∘ readSnapshot`, the SAME
 * pair `applyPlan`'s compare-revision precondition uses (step 3 above). The COMMIT-ON-APPROVAL path resolves
 * its expected base revision to THIS at commit time: a Copilot semantic plan is approved long after propose,
 * so a FIXED base would spuriously `write_conflict` on any unrelated vault change between the two. Resolving
 * head-at-commit makes the whole-vault compare a no-op and delegates TARGET integrity to the executor's
 * gate-1 (`readNoteProjectId` / `noteExists`) — the precise, per-target check. Read-only; never mutates.
 */
export async function readVaultHeadRevision(vault: VaultFs): Promise<RevisionId> {
  return computeRevisionId(await readSnapshot(vault));
}

/**
 * Gate 4 (G1d-2) — embed a KnowledgeWriter authorship stamp into each CHANGED page note, returning a stamped
 * copy of the projected vault. Called only when a signing key is provisioned. For each note whose projected
 * content differs from the snapshot (a create/update — deletes are absent from `projected`) and ends in `.md`,
 * mints a stamp binding the SHARED page provenance (identity + hash over the BASE, unstamped bytes via
 * `computePageProvenance`) and embeds it under the reserved `kwStamp` frontmatter key.
 *
 * FAIL-SAFE + never throws: a note with no safe page slug, a mint that errs, or a SecretsPort that throws is
 * left UNSTAMPED — it commits normally (safely UNTRUSTED at serving). The stamp is best-effort provenance that
 * NEVER blocks a semantic write and NEVER falsely trusts. `kwStamp` is carved out of the page hash (G1b), so
 * embedding it does not perturb what it signs (⇒ the committed note re-derives to the SAME hash the gate checks).
 */
async function embedProvenanceStamps(
  snapshot: VaultSnapshot,
  projected: VaultSnapshot,
  plan: KnowledgeMutationPlan,
  signing: StamperDeps,
  meta: { readonly sourceEventRef: string; readonly baseRevision: RevisionId; readonly now: () => string },
): Promise<VaultSnapshot> {
  const stamped = new Map(projected);
  for (const [path, content] of projected) {
    if (snapshot.get(path) === content) continue; // unchanged — nothing to stamp
    if (!path.endsWith(".md")) continue; // only Markdown notes carry a page fact
    const page = computePageProvenance(path, content);
    if (page === null) continue; // no safe slug ⇒ not a servable page ⇒ leave unstamped
    let minted: Awaited<ReturnType<typeof stampProvenance>>;
    try {
      minted = await stampProvenance(
        {
          workspaceId: plan.workspaceId,
          factIdentity: page.pageIdentity as FactIdentity,
          originPath: path,
          mdContentSha: page.pageSha as MdContentSha,
          // kwRevision is UNSIGNED informational (G1a) — the base revision the note is committed against; the
          // writer's RevisionId is an unbranded string, so brand it for the StampInputs shape.
          kwRevision: meta.baseRevision as unknown as ContractRevisionId,
          sourceEventRef: meta.sourceEventRef,
          committedAt: meta.now(),
        },
        signing,
      );
    } catch {
      continue; // an unexpected SecretsPort throw ⇒ fail-safe (commit this note unstamped)
    }
    if (!minted.ok) continue; // key-unresolved / mint failure ⇒ fail-safe (commit this note unstamped)
    const { frontmatter, body } = parseNote(content);
    const nextFrontmatter = new Map(frontmatter);
    nextFrontmatter.set(KW_STAMP_FRONTMATTER_KEY, serializeStampFieldValue(minted.value));
    stamped.set(path, composeNote(nextFrontmatter, body));
  }
  return stamped;
}

/**
 * Fold every mutation kind (creates / frontmatterUpdates / patches / linkMutations)
 * into the post-apply vault. Returns the WHOLE next snapshot so one revision id
 * covers the plan atomically. The precise region-marker + wikilink byte-format is
 * an interim convention here — task 4.2 (`sections.ts`) owns the stable-ID,
 * human-ownership-preserving version; this task pins the atomic/gate/revision core.
 */
function projectPlan(
  snapshot: VaultSnapshot,
  plan: KnowledgeMutationPlan,
): Map<string, string> {
  const next = new Map<string, string>(snapshot);

  for (const create of plan.creates) {
    next.set(create.path, renderCreate(create));
  }
  for (const patch of plan.frontmatterUpdates) {
    next.set(patch.path, applyFrontmatter(next.get(patch.path) ?? "", patch));
  }
  for (const patch of plan.patches) {
    next.set(patch.path, applyRegionPatch(next.get(patch.path) ?? "", patch));
  }
  for (const link of plan.linkMutations) {
    next.set(link.srcPath, applyLink(next.get(link.srcPath) ?? "", link));
  }

  return next;
}

function renderCreate(create: NoteCreate): string {
  const fm = new Map<string, string>();
  for (const [key, value] of Object.entries(create.frontmatter ?? {})) {
    fm.set(key, serializeScalar(value));
  }
  if (create.title !== undefined) {
    // Route the title through the SAME YAML-safe serializer (it is model-authored — an unsafe title
    // must not land as a raw frontmatter value; it formerly bypassed serialization).
    fm.set("title", serializeScalar(create.title));
  }
  return composeNote(fm, create.body);
}

function applyFrontmatter(content: string, patch: FrontmatterPatch): string {
  const { frontmatter, body } = parseNote(content);
  frontmatter.set(patch.key, serializeScalar(patch.value));
  return composeNote(frontmatter, body);
}

function applyRegionPatch(content: string, patch: NotePatch): string {
  const { frontmatter, body } = parseNote(content);
  const open = `<!-- kw:region:${patch.regionId} -->`;
  const close = `<!-- /kw:region:${patch.regionId} -->`;
  const region = `${open}\n${patch.newBody}\n${close}`;
  const start = body.indexOf(open);
  const end = body.indexOf(close);
  let nextBody: string;
  if (start !== -1 && end !== -1 && end > start) {
    nextBody = body.slice(0, start) + region + body.slice(end + close.length);
  } else {
    nextBody = body.length === 0 ? region : `${body}\n\n${region}`;
  }
  return composeNote(frontmatter, nextBody);
}

function applyLink(content: string, link: LinkMutation): string {
  const { frontmatter, body } = parseNote(content);
  const wikilink = `[[${link.dstSlug}]]`;
  if (link.op === "add") {
    if (body.includes(wikilink)) {
      return content;
    }
    const nextBody = body.length === 0 ? wikilink : `${body}\n${wikilink}`;
    return composeNote(frontmatter, nextBody);
  }
  // remove: strip every occurrence and tidy the whitespace it leaves behind.
  const nextBody = body
    .split("\n")
    .map((line) => line.replace(wikilink, "").replace(/[ \t]+$/u, ""))
    .filter((line, idx, arr) => !(line === "" && arr[idx - 1] === ""))
    .join("\n");
  return composeNote(frontmatter, nextBody);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function diffChanges(
  snapshot: VaultSnapshot,
  projected: ReadonlyMap<string, string>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, content] of projected) {
    if (snapshot.get(path) !== content) {
      changes.push({ path, content });
    }
  }
  return changes;
}

/** Staging-token form of a revision id (strip the `rev:` prefix / non-word chars). */
function tokenOf(revisionId: RevisionId): string {
  return revisionId.replace(/[^a-zA-Z0-9]/gu, "");
}

function summarize(plan: KnowledgeMutationPlan, changedFiles: number): string {
  return (
    `revision-applied: ${changedFiles} file(s) changed; ` +
    `${plan.creates.length} create(s), ${plan.patches.length} patch(es), ` +
    `${plan.linkMutations.length} link(s), ${plan.frontmatterUpdates.length} frontmatter update(s)`
  );
}

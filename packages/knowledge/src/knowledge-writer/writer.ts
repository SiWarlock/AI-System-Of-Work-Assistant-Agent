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

  // 6 — blocking secret scan (task 4.3), immediately BEFORE the commit.
  for (const change of changes) {
    const decision = scan({ path: change.path, content: change.content });
    if (!decision.ok) {
      return err(decision.error);
    }
  }

  // 7 — atomic all-or-nothing commit (temp-write + rename). The new revision id
  // is the deterministic staging token — no clock/random enters the primitive.
  const newRevision = computeRevisionId(projected);
  const committed = await atomicCommit(deps.vault, changes, tokenOf(newRevision));
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

const FM_FENCE = "---";

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

/**
 * YAML-safe frontmatter scalar serialization (§13.10a go-live gate 2 — the first untrusted→frontmatter
 * exposure). A model/domain-authored STRING is emitted as a plain scalar ONLY when it is unambiguously
 * safe; otherwise it is double-quoted + escaped so a real vault (Obsidian / gbrain ingest) cannot
 * misparse a value that starts with a YAML indicator or carries a flow/comment ambiguity (`: `, ` #`,
 * `[`, `#`, …). The writer's own parseNote/composeNote round-trip stays stable: parseNote reads a value
 * verbatim and composeNote re-emits it verbatim, so a re-parsed already-quoted value is NEVER
 * double-quoted (only a fresh set/patch value is re-serialized). Non-string values keep their compact
 * JSON form (numbers/booleans/null are already valid YAML plain scalars).
 */
function serializeScalar(value: unknown): string {
  if (typeof value !== "string") return JSON.stringify(value);
  return needsYamlQuoting(value) ? yamlDoubleQuote(value) : value;
}

/** True when a string is NOT an unambiguously-safe YAML plain scalar (⇒ must be double-quoted). */
function needsYamlQuoting(s: string): boolean {
  if (s.length === 0) return true; // empty ⇒ must quote
  if (s !== s.trim()) return true; // leading/trailing whitespace flips a plain scalar's meaning
  // Safe plain = starts with a LETTER, then only word-chars + space + inert punctuation. Requiring a
  // LETTER start (never a digit) is load-bearing: it forces EVERY digit-leading value — a number, an
  // ISO date `2020-01-01`, hex `0x1F`, octal `0o17`, binary `0b101`, a version — down the quote path,
  // so a real YAML parser (Obsidian / gbrain ingest, YAML 1.1) can never re-TYPE it. Any indicator /
  // `: ` / ` #` / newline / control char also fails this and is quoted.
  if (!/^[A-Za-z][\w ./-]*$/u.test(s)) return true;
  // A letter-leading plain scalar YAML would TYPE as bool/null ⇒ quote to keep it a string.
  if (/^(y|yes|n|no|true|false|on|off|null)$/iu.test(s)) return true;
  return false;
}

/** Escape a string as a YAML double-quoted scalar (the always-safe quoting style). */
function yamlDoubleQuote(s: string): string {
  const escaped = s
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")
    // Any REMAINING non-printable char (C0 minus the above, DEL, C1, U+2028/U+2029) → a \xXX / \uXXXX
    // escape. A raw control char inside `"…"` is NOT `c-printable`, so a strict YAML parser would reject
    // the whole frontmatter block — escaping keeps the note metadata readable.
    .replace(new RegExp("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F-\\x9F\\u2028\\u2029]", "gu"), (c) => {
      const code = c.charCodeAt(0);
      return code <= 0xff
        ? `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`
        : `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    });
  return `"${escaped}"`;
}

interface ParsedNote {
  readonly frontmatter: Map<string, string>;
  readonly body: string;
}

function parseNote(content: string): ParsedNote {
  const frontmatter = new Map<string, string>();
  if (!content.startsWith(`${FM_FENCE}\n`)) {
    return { frontmatter, body: content };
  }
  const closeIdx = content.indexOf(`\n${FM_FENCE}\n`, FM_FENCE.length);
  if (closeIdx === -1) {
    return { frontmatter, body: content };
  }
  const block = content.slice(FM_FENCE.length + 1, closeIdx);
  for (const line of block.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    frontmatter.set(line.slice(0, sep).trim(), line.slice(sep + 1).trim());
  }
  const body = content.slice(closeIdx + FM_FENCE.length + 2);
  return { frontmatter, body };
}

function composeNote(frontmatter: ReadonlyMap<string, string>, body: string): string {
  if (frontmatter.size === 0) {
    return body;
  }
  const lines = [...frontmatter.entries()]
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
  return `${FM_FENCE}\n${lines}\n${FM_FENCE}\n${body}`;
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

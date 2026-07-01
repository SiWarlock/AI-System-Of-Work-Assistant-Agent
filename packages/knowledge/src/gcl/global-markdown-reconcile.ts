// Bidirectional Global/Coordination-Markdown ↔ GCL-DB reconcile (§6, task 4.11;
// OQ-010, REQ-UX-002/003). The GCL DB is the queryable MASTER (task 4.10); the
// Global/Coordination Markdown repo is an Obsidian-editable surface PROJECTED
// FROM the DB. The owner may edit that Markdown, so a per-vault watcher (the 4.6
// infrastructure — `createVaultWatcher`) hands each settled burst to this PURE
// reconcile core, exactly as the fs-watch watcher pairs with `reconcile.ts`.
//
// Two directions, ordered so neither clobbers the other (bullet 4):
//   • DB → Markdown  — `projectProjectionsToMarkdown` renders the authoritative
//     DB rows to an inspectable Markdown surface; `reconcileGlobalMarkdown`
//     re-projects DB rows the owner did NOT touch (refreshing stale blocks).
//   • Markdown → DB  — an owner edit is validated (visibility-level validation
//     via the 4.10 Visibility Gate, which reuses @sow/policy) and, only if it
//     passes AND the DB did not change concurrently, admitted back into the DB.
//
// Safety posture (mirrors `reconcile.ts` 4.6 semantics):
//   • An owner edit RAISING content above its allowed visibility is REJECTED and
//     surfaced as a review item — NEVER silently admitted (bullet 2 / safety
//     rule 4). Raw-content-shaped keys, schema failures, malformed JSON and an
//     identity mismatch are rejected the same way.
//   • A CONCURRENT DB-vs-Markdown change (both sides moved since the base) is a
//     conflict-review item, not a silent overwrite; the DB stays authoritative
//     and the owner's edited block is HELD (not clobbered) pending resolution
//     (bullet 3). An owner deleting a DB-backed block is likewise a conflict —
//     the master row is never silently deleted.
//
// PURE + total: no fs/clock/network (the `now`/`newHealthItemId`/`resolveWorkspace`
// seams are injected); never throws across the boundary (§16) — a typed outcome
// carries the admit-set, the review `HealthItem`s and the merged re-projection.
import { HealthItemSchema } from "@sow/contracts";
import type { GclProjection, HealthItem, Workspace } from "@sow/contracts";
import type { SchemaRegistry } from "@sow/contracts/schema/registry";
import { admitProjection, type GclGateError } from "./visibility-gate";

// ── DB → Markdown projection surface ─────────────────────────────────────────

const BLOCK_START = (key: string): string => `<!-- gcl:projection ${key} -->`;
const BLOCK_END = "<!-- /gcl:projection -->";

// The parse anchor: a start marker with a whitespace-free identity key, a body,
// and a closing marker. Non-greedy body so a stray end-marker closes the block
// (a body that then fails JSON.parse is flagged, never thrown).
const BLOCK_RE = /<!-- gcl:projection (\S+) -->\n([\s\S]*?)\n<!-- \/gcl:projection -->/g;

/** Stable per-projection identity: `${workspaceId}::${projectionType}`. */
export function projectionKey(p: {
  readonly workspaceId: string;
  readonly projectionType: string;
}): string {
  return `${p.workspaceId}::${p.projectionType}`;
}

/**
 * Recursively key-sort a JSON value so a projection renders to a CANONICAL body
 * — the DB→Markdown projection is deterministic, and an unchanged DB row renders
 * byte-identically to the base it produced last reconcile (so "DB unchanged" is a
 * reliable byte comparison).
 */
function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map(canonicalize);
  }
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Canonical body text (pretty, key-sorted JSON) for one projection. */
function canonicalBody(p: GclProjection): string {
  return JSON.stringify(canonicalize(p), null, 2);
}

function renderBlock(key: string, body: string): string {
  return `${BLOCK_START(key)}\n${body}\n${BLOCK_END}`;
}

/**
 * Project authoritative GCL DB rows into the inspectable Global/Coordination
 * Markdown surface (bullet 1). Deterministic: blocks are emitted in ascending
 * key order with a canonical, key-sorted JSON body.
 */
export function projectProjectionsToMarkdown(rows: readonly GclProjection[]): string {
  const blocks = [...rows]
    .map((p) => ({ key: projectionKey(p), body: canonicalBody(p) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((b) => renderBlock(b.key, b.body));
  return blocks.length === 0 ? "" : `${blocks.join("\n\n")}\n`;
}

/** One parsed Markdown block keyed by its marker identity. */
export interface ParsedBlock {
  readonly key: string;
  /** Exact body bytes between the markers (for byte-level owner-edit detection). */
  readonly body: string;
  /** `JSON.parse(body)` on success, otherwise `undefined`. */
  readonly candidate: unknown;
  readonly parseOk: boolean;
}

export interface ParsedMarkdown {
  readonly blocks: ReadonlyMap<string, ParsedBlock>;
  /** Keys that appeared more than once (first kept; later flagged ambiguous). */
  readonly duplicateKeys: readonly string[];
}

/**
 * Parse the Global/Coordination Markdown surface back into per-key blocks. Total:
 * an unparseable body yields `parseOk:false` (never a throw); a duplicate key is
 * recorded rather than silently overwriting the first.
 */
export function parseGlobalMarkdown(md: string): ParsedMarkdown {
  const blocks = new Map<string, ParsedBlock>();
  const duplicateKeys: string[] = [];
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(md)) !== null) {
    const key = m[1]!;
    const body = m[2]!;
    if (blocks.has(key)) {
      duplicateKeys.push(key);
      continue;
    }
    let candidate: unknown;
    let parseOk = false;
    try {
      candidate = JSON.parse(body);
      parseOk = true;
    } catch {
      candidate = undefined;
      parseOk = false;
    }
    blocks.set(key, { key, body, candidate, parseOk });
  }
  return { blocks, duplicateKeys };
}

// ── reconcile ────────────────────────────────────────────────────────────────

export interface ReconcileGlobalMarkdownInput {
  /** Authoritative GCL DB rows now (the queryable master). */
  readonly dbRows: readonly GclProjection[];
  /** Last-reconciled Markdown = the DB projection at that time (the base). */
  readonly baseMarkdown: string;
  /** Current owner-edited Markdown on disk. */
  readonly currentMarkdown: string;
}

export interface ReconcileGlobalMarkdownDeps {
  /** Resolve a projection's OWN source workspace for visibility validation. */
  readonly resolveWorkspace: (workspaceId: string) => Workspace | undefined;
  /** Injected clock (ISO-8601) — deterministic health-item timestamps. */
  readonly now: () => string;
  /** Injected System-Health id minter (no ambient random). */
  readonly newHealthItemId: () => string;
  /** AuditRecord id the review items link back to (§6 / §16). */
  readonly auditRef: string;
  /** Optional ajv schema registry override (defaults to the global registry). */
  readonly registry?: SchemaRegistry;
}

/**
 * Per-key reconcile classification:
 *  - `clean_admit`  — owner edit validated + admitted back into the DB.
 *  - `reproject`    — DB moved, owner untouched → refresh Markdown from the DB.
 *  - `conflict`     — concurrent DB+Markdown change (or owner deletion of a
 *                     master row) → review item, DB authoritative, block held.
 *  - `rejected`     — owner edit failed visibility / raw-content / schema /
 *                     JSON / identity validation → flagged, NEVER admitted.
 */
export type GlobalReconcileClass = "clean_admit" | "reproject" | "conflict" | "rejected";

export interface GlobalReconcileEntry {
  readonly key: string;
  readonly class: GlobalReconcileClass;
  /** Enumerable cause for a `conflict`/`rejected` entry. */
  readonly reason?: GlobalReconcileReason;
  /** The validated projection to upsert (only on `clean_admit`). */
  readonly admit?: GclProjection;
}

export type GlobalReconcileReason =
  | "concurrent_db_change"
  | "owner_deleted_master_row"
  | "visibility_exceeds_source"
  | "raw_content_present"
  | "schema_rejected"
  | "malformed_json"
  | "identity_mismatch"
  | "unknown_workspace";

export interface GlobalReconcileOutcome {
  /** Non-unchanged entries, in ascending key order. */
  readonly entries: readonly GlobalReconcileEntry[];
  /** Validated owner edits to upsert into the GCL DB (the master), key-ordered. */
  readonly toAdmit: readonly GclProjection[];
  /** One review `HealthItem` per conflict/rejection (§16) — never silent. */
  readonly healthItems: readonly HealthItem[];
  /** Merged DB→Markdown re-projection that clobbers no held block (bullet 4). */
  readonly projectedMarkdown: string;
  /** True iff no conflicts and no rejections (a fully clean reconcile). */
  readonly clean: boolean;
}

/** Read a string field off an unknown candidate without throwing. */
function readString(o: unknown, k: string): string | undefined {
  if (o !== null && typeof o === "object" && k in (o as Record<string, unknown>)) {
    const v = (o as Record<string, unknown>)[k];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

/** Map a Visibility-Gate error to this module's enumerable reject reason. */
function gateReason(e: GclGateError): GlobalReconcileReason {
  switch (e.code) {
    case "visibility_exceeds_source":
      return "visibility_exceeds_source";
    case "raw_content_present":
      return "raw_content_present";
    default:
      return "schema_rejected";
  }
}

/**
 * Reconcile the owner-edited Global/Coordination Markdown against the
 * authoritative GCL DB. See the module header for the full attribution model +
 * the fail-closed rules. PURE + total: never throws, never admits an
 * over-visibility / raw / unattributed owner edit, never silently overwrites a
 * concurrent DB change, and re-projects only blocks the owner did not touch.
 */
export function reconcileGlobalMarkdown(
  input: ReconcileGlobalMarkdownInput,
  deps: ReconcileGlobalMarkdownDeps,
): GlobalReconcileOutcome {
  const dbByKey = new Map<string, GclProjection>();
  for (const row of input.dbRows) {
    dbByKey.set(projectionKey(row), row);
  }
  const base = parseGlobalMarkdown(input.baseMarkdown).blocks;
  const current = parseGlobalMarkdown(input.currentMarkdown).blocks;

  const keys = [...new Set([...dbByKey.keys(), ...base.keys(), ...current.keys()])].sort(
    (a, b) => (a < b ? -1 : a > b ? 1 : 0),
  );

  const entries: GlobalReconcileEntry[] = [];
  const toAdmit: GclProjection[] = [];
  const healthItems: HealthItem[] = [];
  // Per-key body to render into the merged re-projection (undefined ⇒ drop block).
  const renderBodies = new Map<string, string>();

  const reject = (key: string, reason: GlobalReconcileReason, held: string | undefined): void => {
    entries.push({ key, class: "rejected", reason });
    healthItems.push(
      buildReviewHealthItem(deps, "schema_rejection", key, `owner Markdown edit rejected (${reason})`),
    );
    if (held !== undefined) {
      renderBodies.set(key, held); // hold the owner's block — do not clobber
    }
  };

  const conflict = (key: string, reason: GlobalReconcileReason, renderBody: string): void => {
    entries.push({ key, class: "conflict", reason });
    healthItems.push(
      buildReviewHealthItem(
        deps,
        "conflict_review",
        key,
        `Global-Markdown vs GCL-DB conflict at '${key}' (${reason}); DB authoritative, review pending.`,
      ),
    );
    renderBodies.set(key, renderBody);
  };

  for (const key of keys) {
    const db = dbByKey.get(key);
    const baseBody = base.get(key)?.body;
    const cur = current.get(key);
    const curBody = cur?.body;

    const dbBody = db === undefined ? undefined : canonicalBody(db);
    const dbChanged = dbBody !== baseBody;
    const ownerEdited = curBody !== baseBody;

    if (!ownerEdited) {
      // Owner did not touch this block. If the DB moved, re-project from the DB;
      // otherwise it is unchanged. Either way the DB body wins the render.
      if (dbChanged) {
        entries.push({ key, class: "reproject" });
      }
      if (dbBody !== undefined) {
        renderBodies.set(key, dbBody);
      }
      continue;
    }

    // Owner edited this block.
    if (dbChanged) {
      // Both sides moved since the base → conflict. DB authoritative; keep the
      // owner's block on disk (held) unless they deleted it, in which case the
      // master row is re-projected back.
      conflict(key, "concurrent_db_change", curBody ?? dbBody ?? "");
      continue;
    }

    // Only the owner moved (DB unchanged since base).
    if (cur === undefined) {
      // Owner deleted a DB-backed block — never a silent master-row deletion.
      conflict(key, "owner_deleted_master_row", dbBody ?? "");
      continue;
    }
    if (!cur.parseOk) {
      reject(key, "malformed_json", curBody);
      continue;
    }

    // Identity pin: the JSON's own identity must match its block key (no smuggling
    // a projection into a foreign workspace/type via an edited body).
    const wsId = readString(cur.candidate, "workspaceId");
    const pType = readString(cur.candidate, "projectionType");
    if (wsId === undefined || pType === undefined || projectionKey({ workspaceId: wsId, projectionType: pType }) !== key) {
      reject(key, "identity_mismatch", curBody);
      continue;
    }

    const workspace = deps.resolveWorkspace(wsId);
    if (workspace === undefined) {
      reject(key, "unknown_workspace", curBody);
      continue;
    }

    // Visibility-level validation via the 4.10 gate (reuses @sow/policy). An edit
    // raising visibility above the workspace default is rejected here, not admitted.
    const admitted = admitProjection(cur.candidate, workspace, deps.registry);
    if (!admitted.ok) {
      reject(key, gateReason(admitted.error), curBody);
      continue;
    }

    // Clean owner edit → admit back into the DB (master). The re-projection uses
    // the canonical body of the admitted row so DB and Markdown agree post-admit.
    entries.push({ key, class: "clean_admit", admit: admitted.value });
    toAdmit.push(admitted.value);
    renderBodies.set(key, canonicalBody(admitted.value));
  }

  const projectedMarkdown = renderMerged(renderBodies);
  const clean = !entries.some((e) => e.class === "conflict" || e.class === "rejected");

  return { entries, toAdmit, healthItems, projectedMarkdown, clean };
}

/** Assemble the merged re-projection from per-key bodies, ascending key order. */
function renderMerged(renderBodies: ReadonlyMap<string, string>): string {
  const keys = [...renderBodies.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (keys.length === 0) {
    return "";
  }
  return `${keys.map((k) => renderBlock(k, renderBodies.get(k)!)).join("\n\n")}\n`;
}

/**
 * Build a review System-Health item (§16), validated through the frozen
 * `HealthItemSchema`. On the (unreachable) parse-fail path we still return a
 * type-correct item — reconciliation must never throw and must always surface the
 * review rather than let an edit slip through silently.
 */
export function buildReviewHealthItem(
  deps: ReconcileGlobalMarkdownDeps,
  failureClass: "conflict_review" | "schema_rejection",
  key: string,
  message: string,
): HealthItem {
  const candidate = {
    id: deps.newHealthItemId(),
    failureClass,
    severity: "warn",
    message: `${message} [${key}]`,
    auditRef: deps.auditRef,
    openedAt: deps.now(),
    state: "open" as const,
  };
  const parsed = HealthItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as HealthItem);
}

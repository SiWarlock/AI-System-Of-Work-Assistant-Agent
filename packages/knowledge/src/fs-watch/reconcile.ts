// Out-of-band-writer reconciliation core (§6, task 4.6, REQ-S-NEW-008). Because
// Obsidian Sync / iCloud / a git remote are a SUPPORTED V1 config, KnowledgeWriter
// is NOT the only possible writer of the working tree. This module reconciles the
// current on-disk state against the last reconciled base by POSITIVE KnowledgeWriter
// attribution (a `kw_writer_sig` + a write-journal): every working-tree mutation is
// classified as one of exactly three things —
//
//   • kw_write            — a verified KW write (a committed/pending write-journal
//                           entry whose content-sha matches the on-disk bytes AND
//                           whose kw_writer_sig verifies). Clean.
//   • human_region_edit   — an edit confined to human-owned bytes: assistant
//                           marker-regions stay byte-stable, or a brand-new file
//                           that carries NO assistant regions, or the deletion of a
//                           pure-human file. Clean.
//   • conflict            — ANYTHING else: a NEW assistant-domain file KW never
//                           wrote, an out-of-band edit of an assistant region, an
//                           external change to a path KW has a write pending for,
//                           the removal of an assistant-region file, or a malformed
//                           marker layout that can't be attributed.
//
// A clean reconcile (every mutation kw_write or human_region_edit) advances the base
// revision so subsequent KnowledgeWriter applies (task 4.1) precondition the NEW
// revision — external edits are never clobbered. The presence of ANY conflict
// withholds the advance entirely and surfaces one `conflict_review` System-Health
// item per conflicting mutation (§16) — never a silent lost update, never an
// auto-advance over an unattributed change (closing the out-of-band hidden-brain
// hole, §6). This function is PURE + total: no fs/clock/network, no throw across the
// boundary — the injected `now`/`newHealthItemId`/`verifyKwSig` are the only seams.
import { HealthItemSchema } from "@sow/contracts";
import type { HealthItem } from "@sow/contracts";
import { createHash } from "node:crypto";
import { computeRevisionId } from "../knowledge-writer/revision";
import type { RevisionId, VaultSnapshot } from "../knowledge-writer/revision";
import { parseSections } from "../markdown-vault/sections";
import type { AssistantSection, Section } from "../markdown-vault/sections";

// ── write-journal + positive-attribution primitives ─────────────────────────

/**
 * One append-only write-journal record positively attributing a file byte-state
 * to KnowledgeWriter. `contentSha` is `sha256` of the exact bytes KW wrote;
 * `kwWriterSig` is the attribution signature (the HMAC-over-(path,contentSha,
 * revisionId) binding via SecretsPort is wired by task 4.15 — see `verifyKwSig`).
 * `pending` marks an in-flight write not yet committed (the concurrent-write race
 * window); `committed` marks a landed KW write.
 */
export interface WriteJournalEntry {
  readonly path: string;
  readonly contentSha: string;
  readonly revisionId: RevisionId;
  readonly kwWriterSig: string;
  readonly state: "pending" | "committed";
}

/**
 * A per-path view over the write-journal the watcher hands to `reconcileVault`.
 * Keeping it a plain in-memory projection keeps reconciliation a PURE function; the
 * watcher owns the (never-throwing) I/O of loading it from the operational store.
 */
export interface JournalView {
  readonly committed: ReadonlyMap<string, readonly WriteJournalEntry[]>;
  readonly pending: ReadonlyMap<string, readonly WriteJournalEntry[]>;
}

/**
 * Verifies a write-journal entry's `kw_writer_sig`. DEFAULT is a structural
 * presence check (a non-empty sig); task 4.15 swaps in the keyed HMAC verifier
 * (SecretsPort) so a tampered journal row fails positive attribution. Positive
 * attribution requires BOTH a content-sha match AND a verifying sig — a sha match
 * alone is never enough.
 */
export type KwSigVerifier = (entry: WriteJournalEntry) => boolean;

const defaultVerifyKwSig: KwSigVerifier = (e) => e.kwWriterSig.trim().length > 0;

/** `sha256` of a file's bytes — the identity the write-journal matches against. */
export function fileContentSha(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Fold a flat entry list into the per-path `JournalView` reconciliation consumes. */
export function buildJournalView(entries: readonly WriteJournalEntry[]): JournalView {
  const committed = new Map<string, WriteJournalEntry[]>();
  const pending = new Map<string, WriteJournalEntry[]>();
  for (const entry of entries) {
    const bucket = entry.state === "committed" ? committed : pending;
    const list = bucket.get(entry.path);
    if (list === undefined) {
      bucket.set(entry.path, [entry]);
    } else {
      list.push(entry);
    }
  }
  return { committed, pending };
}

// ── mutation diff ────────────────────────────────────────────────────────────

export type MutationKind = "added" | "modified" | "removed";

export interface FileMutation {
  readonly path: string;
  readonly kind: MutationKind;
  /** Bytes at the reconciled base (absent for an `added` file). */
  readonly baseContent?: string;
  /** Bytes on disk now (absent for a `removed` file). */
  readonly currentContent?: string;
}

/** Diff the reconciled base snapshot against the current on-disk snapshot. */
export function computeMutations(
  base: VaultSnapshot,
  current: VaultSnapshot,
): FileMutation[] {
  const paths = new Set<string>([...base.keys(), ...current.keys()]);
  const mutations: FileMutation[] = [];
  for (const path of paths) {
    const b = base.get(path);
    const c = current.get(path);
    if (b === undefined && c !== undefined) {
      mutations.push({ path, kind: "added", currentContent: c });
    } else if (b !== undefined && c === undefined) {
      mutations.push({ path, kind: "removed", baseContent: b });
    } else if (b !== undefined && c !== undefined && b !== c) {
      mutations.push({ path, kind: "modified", baseContent: b, currentContent: c });
    }
    // b === c → unchanged, not a mutation.
  }
  return mutations;
}

// ── attribution ──────────────────────────────────────────────────────────────

export type ConflictReason =
  | "concurrent_pending_write"
  | "unattributed_assistant_region"
  | "new_assistant_domain_file"
  | "assistant_file_removed"
  | "malformed_markers"
  | "rollback_to_prior_kw_state"
  | "unattributed_change";

export type Attribution =
  | { readonly class: "kw_write"; readonly path: string; readonly revisionId: RevisionId }
  | { readonly class: "human_region_edit"; readonly path: string }
  | { readonly class: "conflict"; readonly path: string; readonly reason: ConflictReason };

function hasAssistantRegion(content: string): { ok: boolean; malformed: boolean; has: boolean } {
  const parsed = parseSections(content);
  if (!parsed.ok) {
    return { ok: false, malformed: true, has: false };
  }
  return { ok: true, malformed: false, has: parsed.value.some((s) => s.kind === "assistant") };
}

/** id → exact marker-to-marker byte slice, for assistant-region byte-stability. */
function regionRawById(sections: readonly Section[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of sections) {
    if (s.kind === "assistant") {
      map.set(s.regionId, (s as AssistantSection).raw);
    }
  }
  return map;
}

/**
 * Are the assistant marker-regions byte-identical between base and current? A
 * `stable` modification touched only human-owned bytes (a clean human-region edit);
 * an unstable one changed / added / removed an assistant region — which, absent a
 * verified KW write, is a conflict. Malformed markers on either side can't be
 * attributed at all.
 */
function assistantRegionsStable(
  baseContent: string,
  currentContent: string,
): { stable: boolean; malformed: boolean } {
  const b = parseSections(baseContent);
  const c = parseSections(currentContent);
  if (!b.ok || !c.ok) {
    return { stable: false, malformed: true };
  }
  const bRegions = regionRawById(b.value);
  const cRegions = regionRawById(c.value);
  if (bRegions.size !== cRegions.size) {
    return { stable: false, malformed: false };
  }
  for (const [id, raw] of bRegions) {
    if (cRegions.get(id) !== raw) {
      return { stable: false, malformed: false };
    }
  }
  return { stable: true, malformed: false };
}

/**
 * Positive KnowledgeWriter attribution for the current bytes at `path`: a committed
 * OR pending write-journal entry whose `contentSha` matches AND whose `kw_writer_sig`
 * verifies. Returns the producing revision id on a hit.
 */
function matchesKwWrite(
  path: string,
  currentSha: string,
  view: JournalView,
  verify: KwSigVerifier,
): { readonly revisionId: RevisionId; readonly stale: boolean } | undefined {
  // A landing in-flight (pending) write matching the current bytes = a fresh KW write.
  const pendingHit = (view.pending.get(path) ?? []).find(
    (e) => e.contentSha === currentSha && verify(e),
  );
  if (pendingHit !== undefined) return { revisionId: pendingHit.revisionId, stale: false };

  // The HEAD committed entry (the expected on-disk state after the last KW write)
  // matching = a clean landed write. The write-journal is chronological, so the
  // head is the LAST entry for the path.
  const committed = view.committed.get(path) ?? [];
  const head = committed[committed.length - 1];
  if (head !== undefined && head.contentSha === currentSha && verify(head)) {
    return { revisionId: head.revisionId, stale: false };
  }

  // Current bytes match a SUPERSEDED (non-head) committed entry: the file was
  // reverted out-of-band to a PRIOR KW state (a rollback). Attributing this as a
  // fresh KW write would clean-advance the base and silently LOSE the newer
  // content — so flag it stale (→ conflict-review), never a clean advance.
  const staleHit = committed.slice(0, -1).find((e) => e.contentSha === currentSha && verify(e));
  if (staleHit !== undefined) return { revisionId: staleHit.revisionId, stale: true };

  return undefined;
}

/** Classify one working-tree mutation into exactly one `Attribution`. */
function classify(
  mutation: FileMutation,
  view: JournalView,
  verify: KwSigVerifier,
): Attribution {
  const { path } = mutation;

  // A verified KW write to the current bytes always attributes to KW (a landed
  // commit reflected on disk), whether the file was added or modified.
  if (mutation.currentContent !== undefined) {
    const m = matchesKwWrite(path, fileContentSha(mutation.currentContent), view, verify);
    if (m !== undefined) {
      if (m.stale) {
        // Out-of-band rollback to a prior KW state — conflict-review, never a
        // clean base advance (the lost-update guard).
        return { class: "conflict", path, reason: "rollback_to_prior_kw_state" };
      }
      return { class: "kw_write", path, revisionId: m.revisionId };
    }
  }

  // KW has an in-flight (pending) write for this path but the on-disk bytes don't
  // match it → an external writer clobbered a path KW is mid-writing (the lost-
  // update race). Conflict — never a silent advance.
  if ((view.pending.get(path) ?? []).length > 0) {
    return { class: "conflict", path, reason: "concurrent_pending_write" };
  }

  switch (mutation.kind) {
    case "added": {
      const cur = mutation.currentContent ?? "";
      const parsed = hasAssistantRegion(cur);
      if (parsed.malformed) {
        return { class: "conflict", path, reason: "malformed_markers" };
      }
      // A NEW file carrying assistant regions that KW never wrote is exactly the
      // out-of-band hidden-brain hole — conflict, never auto-advance.
      if (parsed.has) {
        return { class: "conflict", path, reason: "new_assistant_domain_file" };
      }
      return { class: "human_region_edit", path };
    }
    case "removed": {
      const prev = mutation.baseContent ?? "";
      const parsed = hasAssistantRegion(prev);
      if (parsed.malformed) {
        return { class: "conflict", path, reason: "malformed_markers" };
      }
      // Deleting a file that carried assistant (KW-owned) regions out-of-band is a
      // potential lost update — surface it, don't silently accept the deletion.
      if (parsed.has) {
        return { class: "conflict", path, reason: "assistant_file_removed" };
      }
      return { class: "human_region_edit", path };
    }
    case "modified": {
      const base = mutation.baseContent ?? "";
      const cur = mutation.currentContent ?? "";
      const regions = assistantRegionsStable(base, cur);
      if (regions.malformed) {
        return { class: "conflict", path, reason: "malformed_markers" };
      }
      // Assistant regions byte-stable ⇒ only human-owned bytes moved ⇒ clean.
      if (regions.stable) {
        return { class: "human_region_edit", path };
      }
      // An assistant region changed but no verified KW write claims it → conflict.
      return { class: "conflict", path, reason: "unattributed_assistant_region" };
    }
    default: {
      return { class: "conflict", path, reason: "unattributed_change" };
    }
  }
}

// ── the reconcile ────────────────────────────────────────────────────────────

export interface ReconcileInput {
  readonly baseRevisionId: RevisionId;
  readonly baseSnapshot: VaultSnapshot;
  readonly currentSnapshot: VaultSnapshot;
}

export interface ReconcileDeps {
  readonly journal: JournalView;
  /** Injected clock (ISO-8601); keeps health-item timestamps deterministic. */
  readonly now: () => string;
  /** Injected System-Health id minter (no ambient random). */
  readonly newHealthItemId: () => string;
  /** AuditRecord id the conflict-review health items link back to (§6 / §16). */
  readonly auditRef: string;
  /** Positive-attribution sig verifier (default: structural presence). */
  readonly verifyKwSig?: KwSigVerifier;
}

export type ReconcileOutcomeKind = "noop" | "clean_advance" | "conflict_review";

export interface ReconcileOutcome {
  readonly kind: ReconcileOutcomeKind;
  /** ADVANCED to the on-disk revision on a clean reconcile; UNCHANGED otherwise. */
  readonly baseRevisionId: RevisionId;
  readonly attributions: readonly Attribution[];
  /** The subset of `attributions` with `class === "conflict"`. */
  readonly conflicts: readonly Attribution[];
  /** One `conflict_review` System-Health item (§16) per conflict. */
  readonly healthItems: readonly HealthItem[];
}

/**
 * Reconcile the on-disk vault against the reconciled base. See the module header
 * for the attribution model + the fail-closed advance rule. PURE + total: it never
 * throws and never advances the base over an unattributed change.
 */
export function reconcileVault(input: ReconcileInput, deps: ReconcileDeps): ReconcileOutcome {
  const verify = deps.verifyKwSig ?? defaultVerifyKwSig;
  const mutations = computeMutations(input.baseSnapshot, input.currentSnapshot);

  if (mutations.length === 0) {
    return {
      kind: "noop",
      baseRevisionId: input.baseRevisionId,
      attributions: [],
      conflicts: [],
      healthItems: [],
    };
  }

  const attributions = mutations.map((m) => classify(m, deps.journal, verify));
  const conflicts = attributions.filter((a) => a.class === "conflict");

  // ANY conflict withholds the base advance entirely (never a partial advance over
  // an unattributed change) and surfaces one conflict_review item per conflict.
  if (conflicts.length > 0) {
    const healthItems = conflicts.map((c) =>
      buildConflictReviewHealthItem(
        deps,
        c.path,
        c.class === "conflict" ? c.reason : "unattributed_change",
      ),
    );
    return {
      kind: "conflict_review",
      baseRevisionId: input.baseRevisionId,
      attributions,
      conflicts,
      healthItems,
    };
  }

  // Every mutation is a verified KW write or a human-owned-region edit → clean;
  // advance the base to the current on-disk revision so later applies precondition it.
  return {
    kind: "clean_advance",
    baseRevisionId: computeRevisionId(input.currentSnapshot),
    attributions,
    conflicts: [],
    healthItems: [],
  };
}

/**
 * Build the distinct `conflict_review` System-Health item (§16), validated through
 * the frozen `HealthItemSchema`. On the (unreachable) parse-fail path we still
 * return a type-correct item — reconciliation must never throw and must always
 * surface the conflict rather than let it advance silently.
 */
export function buildConflictReviewHealthItem(
  deps: ReconcileDeps,
  path: string,
  reason: ConflictReason,
): HealthItem {
  const candidate = {
    id: deps.newHealthItemId(),
    failureClass: "conflict_review" as const,
    // severity is an OPEN string upstream (no closed enum) — see HealthItem model.
    severity: "warn",
    message:
      `Out-of-band vault change at '${path}' (${reason}) could not be attributed to a ` +
      `verified KnowledgeWriter write or a human-owned-region edit; base revision ` +
      `withheld pending conflict review.`,
    auditRef: deps.auditRef,
    openedAt: deps.now(),
    state: "open" as const,
  };
  const parsed = HealthItemSchema.safeParse(candidate);
  return parsed.success ? parsed.data : (candidate as unknown as HealthItem);
}

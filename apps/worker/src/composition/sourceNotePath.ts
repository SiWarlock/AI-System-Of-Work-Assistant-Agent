// @sow/worker — the per-source ingestion note-path derivation (task 11.1 slice #46, §13/§16).
//
// The ingestion build stage derives the canonical Markdown note path for a dropped source file.
// This is an INJECTION SURFACE: the per-file `sourceId` embeds the file's relative path (the vault
// watcher mints `file:<ws>:<relPath>`), which is attacker/owner-controlled — a file named
// `../../etc/passwd` must NEVER escape the workspace's `sources/<ws>/` subtree. Safety is BY
// CONSTRUCTION, not by validation-of-the-raw-value:
//   • the per-source segment is a sha256 hex digest of the source identity (`[0-9a-f]` only — it
//     can't contain `..`, a separator, a dot, a NUL, or a control char), so distinct sources get
//     distinct notes and no hostile identity can forge a path component;
//   • the `<ws>` segment is GUARDED (WorkspaceId is a bare branded string with no charset schema —
//     ids.ts only rejects empty/whitespace), so an unsafe `ws` fails CLOSED rather than being
//     interpolated raw (defense for the `sources/<ws>/` WS-8 confinement, since the vault-root
//     guard in createFsVault only backstops WHOLE-vault escape, not cross-workspace-within-vault).
//
// CONTENT-ADDRESSED: the identity folds `sourceId` + `contentHash`, so a same-file same-content
// re-drop derives the SAME path (→ the durable revision store replays; no duplicate), while an
// edited file (new contentHash) derives a NEW path (a new note — lossless; update-on-edit via a
// note-exists→patch probe is a deliberate follow-on, out of this slice).
import { createHash } from "node:crypto";
import { ok, err } from "@sow/contracts";
import type { Result, SourceId, WorkspaceId } from "@sow/contracts";

/**
 * The narrow per-file source identity the note-path + planId derivation keys on. Deliberately
 * NARROW (not the full `SourceEnvelope`): it STRUCTURALLY excludes the attacker-influenceable
 * source fields (`origin`, `routingHints`, `sensitivity`) from ever reaching the path-construction
 * surface — the derivation can only see what it legitimately keys on.
 */
export interface SourceNoteIdentity {
  readonly sourceId: SourceId;
  readonly contentHash: string;
}

/** Typed derivation refusal (§16 — never throws across the boundary). */
export interface SourceNotePathError {
  readonly code: "unsafe_workspace_segment";
  readonly message: string;
}

// A workspace path segment must be a plain alphanumeric/`-`/`_` token — the shape every real
// WorkspaceId already has (`personal-business`, `employer-work`, `ws-src`). This forbids `.`
// (so `.`/`..` can't form), `/`, `\`, whitespace, NUL, and every control char — so the `<ws>`
// segment can never introduce a traversal/confusion component.
const SAFE_WS_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** How many hex chars of the sha256 digest to keep (128 bits — collision-negligible). */
const HASH_LEN = 32;

const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

/**
 * The content-addressed digest of a per-file source identity — a 128-bit sha256 hex prefix over
 * `sourceId ‖ contentHash`. The single primitive both the note PATH and the note's planId key on,
 * so they stay consistent: a same-file same-content re-drop yields the SAME digest (→ same path +
 * same planId → the durable revision store replays; no duplicate), while an edited file (new
 * contentHash) yields a NEW digest (→ a new note). Safe by construction — hex only (`[0-9a-f]`).
 */
export function sourceIdentityDigest(identity: SourceNoteIdentity): string {
  // Fold with a NUL separator so `(sourceId="a", contentHash="bc")` and `("ab", "c")` can never
  // collide (a separator no valid utf8 field carries).
  return sha256Hex(`${String(identity.sourceId)}\0${identity.contentHash}`).slice(0, HASH_LEN);
}

/**
 * Derive the traversal-safe, deterministic, collision-free canonical note path for an ingested
 * source: `sources/<ws>/<digest>.md`. Returns a typed `err` (never throws) when the `<ws>` segment
 * is unsafe — fail-closed, never a raw interpolation.
 *
 * WS-8: `ws` is the ROUTING-BOUND workspace (stamped by the caller, never a source-content value);
 * the path is always under that workspace's `sources/<ws>/` subtree.
 */
export function deriveSourceNotePath(
  ws: WorkspaceId,
  identity: SourceNoteIdentity,
): Result<string, SourceNotePathError> {
  const wsSegment = String(ws);
  if (!SAFE_WS_SEGMENT.test(wsSegment)) {
    return err({
      code: "unsafe_workspace_segment",
      message: "workspace id is not a safe path segment (refused to derive an ingestion note path)",
    });
  }
  return ok(`sources/${wsSegment}/${sourceIdentityDigest(identity)}.md`);
}

// §13.10a gate 1 (slug-collision) — the concrete `NoteProjectIdReader` for the on-approval semantic
// executor (`semanticMutationDispatch`). The executor derives each write TARGET's intended project by
// reading that note's frontmatter `projectId` and comparing it (raw string equality) against the plan's
// stamped `expectedProjectId`; this adapter is the read side of that comparison.
//
// Two seams compose here:
//   • WorkspaceNoteRead — the injected WS-8-scoped note read (the runner, G4, supplies the concrete one
//     that resolves the served workspace's vault + reads the file). Mirrors `VaultFs.read` semantics:
//     `undefined` ⇒ the note is ABSENT (never a throw for mere absence).
//   • @sow/knowledge `readFrontmatterField` — the DETERMINISTIC core: parse the `---` block + UNESCAPE
//     the value (the inverse of the writer's `serializeScalar`). Co-located with the forward serializer
//     so it cannot drift — a quoted on-disk id (e.g. a digit-leading `"2024-x"`) is recovered as its raw
//     form, so the executor's raw-equality compare against `expectedProjectId` never false-rejects.
//
// REDACTION (safety rule 7): a real read fault (permission / I/O) is folded to a bounded, redaction-safe
// `FailureVariant` carrying ONLY a stable cause code — never the raw path, error, or content. The
// executor treats an `err` as fail-closed (no commit). NEVER throws across the boundary (§16).
import { ok, err, failure } from "@sow/contracts";
import type { FailureVariant, Result, WorkspaceId } from "@sow/contracts";
import { readFrontmatterField } from "@sow/knowledge";
import type { NoteExistsProbe, NoteProjectIdReader } from "../procedures/semanticMutationDispatch";

/**
 * The injected WS-8-scoped note read: return the note's raw file content for a `(path, workspaceId)`, or
 * `undefined` when the note is absent (mirrors `VaultFs.read` — absence is `undefined`, not a throw). The
 * runner supplies the concrete impl that resolves the workspace's vault; a real I/O fault MAY throw and is
 * caught + redacted by the adapter.
 */
export type WorkspaceNoteRead = (path: string, workspaceId: WorkspaceId) => Promise<string | undefined>;

/** The one frontmatter key gate 1 compares (the note's declared owning project). */
const FRONTMATTER_PROJECT_ID_KEY = "projectId";

/** Redaction-safe read-fault variant: only a bounded cause code crosses — never the raw path/error/content. */
function readFault(): FailureVariant {
  // Retryable: a transient fs/permission fault should not permanently wedge the approval dispatch.
  return failure("degraded_unavailable", "note read: vault read fault", {
    retryable: true,
    cause: { code: "NOTE_PROJECT_ID_READ_FAULT" },
  });
}

/**
 * Build the concrete `NoteProjectIdReader` from a WS-8-scoped note read. Reads the note content, returns
 * its frontmatter `projectId` UNESCAPED, or `undefined` when the note is absent OR carries no `projectId`.
 * A read fault → a redaction-safe `FailureVariant`; never throws.
 */
export function createNoteProjectIdReader(readNote: WorkspaceNoteRead): NoteProjectIdReader {
  return async (path: string, workspaceId: WorkspaceId): Promise<Result<string | undefined, FailureVariant>> => {
    try {
      const content = await readNote(path, workspaceId);
      // The extract runs INSIDE the try: a misbehaving read that hands back a non-string (an untyped-JS
      // boundary violation) would otherwise throw past the boundary and bypass redaction.
      if (typeof content !== "string") return ok(undefined); // absent (undefined) or a non-string ⇒ no id
      return ok(readFrontmatterField(content, FRONTMATTER_PROJECT_ID_KEY));
    } catch {
      return err(readFault());
    }
  };
}

/**
 * Build the concrete `NoteExistsProbe` from the SAME WS-8-scoped note read. `true` ⇔ the read returns
 * content (any string, including a note with no `projectId`); a read fault → a redaction-safe
 * `FailureVariant`; never throws. Gate 1's create-clobber guard keys on THIS, not on `projectId` presence.
 */
export function createNoteExistsProbe(readNote: WorkspaceNoteRead): NoteExistsProbe {
  return async (path: string, workspaceId: WorkspaceId): Promise<Result<boolean, FailureVariant>> => {
    try {
      const content = await readNote(path, workspaceId);
      if (content === undefined) return ok(false); // absent ⇒ the create target is free
      if (typeof content === "string") return ok(true); // present ⇒ occupied (regardless of frontmatter)
      return err(readFault()); // a non-string, non-undefined value is a contract violation → fail CLOSED (a
      // create-clobber guard must never report "free" on ambiguity — that direction is the data-loss one)
    } catch {
      return err(readFault());
    }
  };
}

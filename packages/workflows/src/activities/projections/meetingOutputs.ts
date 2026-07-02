// @sow/workflows — task 7.6 PROJECTION: the meeting.close OutputsProjection.
//
// A PURE mapper from a VALIDATED extraction (+ the correlation-bound workspaceId)
// onto the meeting NoteCreate + the external-action descriptors the buildOutputs
// ACTIVITY (activities/buildOutputs.ts) turns into a KnowledgeMutationPlan +
// ExternalWriteEnvelope pairs. It implements {@link OutputsProjection}.
//
// SAFETY POSTURE (why this file is safety-critical):
//   • no-inference (REQ-F-017 / safety rule 2): the projection receives ONLY the
//     fields that PASSED the validate gate, so an inferred owner/date can never be
//     in `validated.fields`. It never SYNTHESIZES a value: an absent convention
//     field is stamped with the TBD sentinel via {@link frontmatterValue} — never
//     an invented value. An action item WITHOUT an evidence-backed (concrete,
//     non-TBD) owner + title derives NO external action (fail-closed — a todo is
//     never created for a guessed owner).
//   • workspace-isolation (WS-2/WS-4 / safety rule 4): the note is placed under the
//     PASSED workspaceId's meetings area. A validated field literally named
//     `workspaceId` is NOT a routing field — it is IGNORED for path/target derivation
//     (a caller/model field can never redirect the durable write to another
//     workspace). The passed workspaceId is the ONLY authority.
//   • evidence-only (inv-3): ONLY the documented convention field names are read
//     off `validated.fields`; any other key present in the extraction is ignored,
//     never fabricated into the note.
//   • fail-closed (inv-3 / §16): a field set with no concrete title (the note
//     anchor) cannot be projected → err({ code: "unmappable_extraction" }) with NO
//     partial note. The projection NEVER throws.
//   • determinism (inv-5): pure — no clock, no I/O, no node:crypto, no
//     Date.now()/Math.random(). Identical (validated, workspaceId) ⇒ identical
//     output; the buildOutputs ACTIVITY computes the idempotency/canonical keys.
//
// FIELD-NAME CONVENTION (the meeting.close ValidatedExtraction contract):
// The validate gate keys fields by an opaque name; this projection reads a FIXED,
// DOCUMENTED subset and ignores the rest.
//
//   NOTE (frontmatter, evidence-only):
//     • `title`      — the meeting title. REQUIRED (concrete, non-TBD) — the note
//                       anchor; absent/TBD ⇒ unmappable_extraction (fail-closed).
//     • `attendees`  — the attendee list (optional; TBD sentinel when absent).
//     • `decisions`  — the decisions list (optional; TBD sentinel when absent).
//     • `owner`      — the meeting/closeout owner (optional; TBD sentinel when
//                       absent — NEVER invented, REQ-F-017).
//     • `dueDate`    — the closeout due date (optional; TBD sentinel when absent).
//
//   ACTIONS (one todo-create descriptor per evidence-backed action item):
//     Action items are keyed positionally as `actionItems.<n>.title` and
//     `actionItems.<n>.owner`. An index derives EXACTLY ONE `todoist` create
//     descriptor IFF BOTH `actionItems.<n>.title` AND `actionItems.<n>.owner` are
//     present AND concrete (evidence-backed, non-TBD). An index missing either — or
//     carrying a TBD owner — derives NO action (fail-closed: no guessed owner).
import { ok, err } from "@sow/contracts";
import type { Result, WorkspaceId, NoteCreate } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import {
  frontmatterValue,
  isConcrete,
} from "../buildOutputs";
import type {
  OutputsProjection,
  DerivedActionDescriptor,
} from "../buildOutputs";
import type {
  ValidatedExtraction,
  BuildOutputsFailure,
} from "../../ports/meetingCloseout";

/**
 * The frontmatter convention field names read off the validated extraction. The
 * ORDER is fixed so the emitted frontmatter is deterministic (inv-5). Every name
 * here is stamped into frontmatter (TBD sentinel when the field is absent); NO other
 * key is ever surfaced (evidence-only).
 */
const NOTE_FRONTMATTER_FIELDS = [
  "title",
  "attendees",
  "decisions",
  "owner",
  "dueDate",
] as const;

/** The meeting title field name — the required note anchor. */
const TITLE_FIELD = "title";

/** The external target the derived action items are proposed against. */
const ACTION_TARGET = "todoist" as const;

/** `actionItems.<n>.title` key for a positional action item. */
function actionTitleKey(index: number): string {
  return `actionItems.${index}.title`;
}

/** `actionItems.<n>.owner` key for a positional action item. */
function actionOwnerKey(index: number): string {
  return `actionItems.${index}.owner`;
}

/**
 * The highest positional action-item index present in the field set (−1 when none).
 * Derived from the `actionItems.<n>.title|owner` keys so iteration is bounded by the
 * actual extraction, deterministically (sorted numeric scan of the key set).
 */
function highestActionIndex(
  fields: Record<string, ExtractionField<unknown>>,
): number {
  let max = -1;
  const re = /^actionItems\.(\d+)\.(?:title|owner)$/;
  for (const key of Object.keys(fields)) {
    const m = re.exec(key);
    if (m !== undefined && m !== null) {
      const n = Number(m[1]);
      if (Number.isInteger(n) && n > max) {
        max = n;
      }
    }
  }
  return max;
}

/**
 * Read a field's concrete string value, or `undefined` when the field is absent or
 * NOT a concrete (non-TBD) scalar string. Used for the action-item owner/title,
 * where only an evidence-backed concrete string is a valid basis for a todo.
 */
function concreteString(
  field: ExtractionField<unknown> | undefined,
): string | undefined {
  if (!isConcrete(field)) return undefined;
  const value = field!.value;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Reduce a MODEL-CONTROLLED title to a path-safe filename slug. The title is
 * evidence-backed (it passed no-inference) but its CONTENT is untrusted — a title
 * like `../../ws-other/secrets/x` would otherwise be interpolated raw into
 * `note.path` and, after the vault's `join(root, path)`, escape the bound workspace
 * (a cross-workspace / arbitrary-filesystem durable write — safety rule 4 / WS-4).
 * We keep ONLY letters/digits and collapse every other run (path separators `/` `\`,
 * dots — so `..` is impossible — whitespace, control chars, NUL) to a single hyphen.
 * The result therefore contains NO separator and NO `..`, so it can never inject path
 * structure. The raw title is still preserved on `note.title` + frontmatter (display).
 */
function safeNoteSlug(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
}

/**
 * Build the meeting note body from the evidence-backed fields. Pure + deterministic
 * — the body is a stable, human-readable rendering of the convention fields (the
 * frontmatter carries the machine-readable copy). A TBD field is rendered as the TBD
 * sentinel, never an invented value (REQ-F-017).
 */
function composeBody(
  fields: Record<string, ExtractionField<unknown>>,
): string {
  const title = frontmatterValue(fields[TITLE_FIELD]);
  const attendees = frontmatterValue(fields["attendees"]);
  const decisions = frontmatterValue(fields["decisions"]);
  const render = (value: unknown): string =>
    Array.isArray(value) ? value.map((v) => `- ${String(v)}`).join("\n") : String(value);
  return [
    `# ${String(title)}`,
    "",
    "## Attendees",
    render(attendees),
    "",
    "## Decisions",
    render(decisions),
    "",
  ].join("\n");
}

/**
 * The meeting.close OutputsProjection. Maps a {@link ValidatedExtraction} + the
 * PASSED (correlation-bound) workspaceId onto a meeting {@link NoteCreate} + the
 * derived {@link DerivedActionDescriptor} list. PURE; fail-closed; never throws.
 * See the file header for the full field-name convention + safety posture.
 */
export const meetingOutputsProjection: OutputsProjection = {
  project(
    validated: ValidatedExtraction,
    workspaceId: WorkspaceId,
  ): Result<
    { readonly note: NoteCreate; readonly actions: readonly DerivedActionDescriptor[] },
    BuildOutputsFailure
  > {
    const fields = validated.fields;

    // fail-closed: the note NEEDS a concrete title anchor. An absent / TBD title (or
    // an entirely empty set) cannot be projected → unmappable_extraction, no partial.
    const titleField = fields[TITLE_FIELD];
    if (!isConcrete(titleField)) {
      return err({
        code: "unmappable_extraction",
        message:
          "meeting.close projection: no concrete `title` field to anchor the meeting note (fail-closed, never a guessed note)",
      });
    }

    // frontmatter: ONLY the convention field names, in fixed order. An absent field
    // becomes the TBD sentinel (REQ-F-017 — never invented); a validated field named
    // `workspaceId` is NOT in this set, so it can NEVER redirect the write.
    const frontmatter: Record<string, unknown> = {};
    for (const name of NOTE_FRONTMATTER_FIELDS) {
      frontmatter[name] = frontmatterValue(fields[name]);
    }

    // WS-2/WS-4: the note is placed under the PASSED workspace — the ONLY routing
    // authority. A caller/model `workspaceId` field is ignored (never read here). The
    // model-controlled title is SLUGGED into the filename so it cannot inject path
    // structure (`..`, separators) and escape the bound workspace after the vault's
    // `join(root, path)` (the exact traversal the adversarial verify caught). A title
    // that slugs to nothing (all-punctuation, e.g. "../..") has no safe anchor →
    // fail-closed (never a note written to an unintended path).
    const rawTitle = String(frontmatter[TITLE_FIELD]);
    const slug = safeNoteSlug(rawTitle);
    if (slug.length === 0) {
      return err({
        code: "unmappable_extraction",
        message:
          "meeting.close projection: `title` has no path-safe characters to anchor the note filename (fail-closed, never a traversal-shaped path)",
      });
    }
    const note: NoteCreate = {
      path: `meetings/${String(workspaceId)}/${slug}.md`,
      title: rawTitle,
      body: composeBody(fields),
      frontmatter,
    };

    // actions: one todo-create descriptor per action item that carries BOTH an
    // evidence-backed (concrete, non-TBD) owner AND title. Any other item — missing
    // owner, missing title, or TBD owner — derives NO action (fail-closed).
    const actions: DerivedActionDescriptor[] = [];
    const lastIndex = highestActionIndex(fields);
    for (let i = 0; i <= lastIndex; i += 1) {
      const itemTitle = concreteString(fields[actionTitleKey(i)]);
      const itemOwner = concreteString(fields[actionOwnerKey(i)]);
      if (itemTitle === undefined || itemOwner === undefined) {
        continue; // no guessed owner / no untitled todo — skip.
      }
      actions.push({
        targetSystem: ACTION_TARGET,
        // Logical object identity → canonicalObjectKey (pre-write existence check).
        // Bound to the workspace + item title so the same closeout dedupes on replay.
        canonicalIdentity: {
          workspace: String(workspaceId),
          title: itemTitle,
        },
        operation: "todoist.create",
        // Logical operation identity → idempotencyKey (replay-dedupe key).
        idempotencyIdentity: {
          workspace: String(workspaceId),
          title: itemTitle,
          owner: itemOwner,
        },
        payload: { title: itemTitle, owner: itemOwner },
        approvalPolicy: "auto",
        // A deterministic payload digest (the activity does not re-hash; the digest
        // is a stable, pure encoding of the payload identity — no node:crypto here).
        payloadHash: `payload:todoist.create:${String(workspaceId)}:${itemTitle}:${itemOwner}`,
        preconditions: ["not_exists"],
      });
    }

    return ok({ note, actions });
  },
};

/** Re-export the sentinel so callers/tests can assert the no-inference stamp. */
export { TBD };

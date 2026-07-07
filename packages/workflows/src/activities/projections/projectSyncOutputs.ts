// P3e-2 (§9.5 / §13.5) — the concrete SyncOutputsProjection. Projects the DETERMINISTIC progress facts + the
// no-inference-gated ValidatedNarrative into BOTH sync outputs: the UiSafeProjectDashboard read-model row
// (wrapped in the {workspaceId, dashboard} envelope the real ProjectSyncUpdateDashboardPort consumes) and the
// committed project-status NoteCreate (canonical Markdown, one-writer via the KMP). PURE + never-throws.
//
// Three load-bearing invariants (adversarial-verify MAJORS folded in):
//  • WS-8: the note's PHYSICAL path is rooted at the SERVER-BOUND workspaceId (`projects/<ws>/<leaf>.md`),
//    NEVER the multi-segment slug — the vault joins `note.path` verbatim + the KW gate does not check
//    path-in-workspace, so the projection is the sole path-scoping enforcer. The leaf is the projectId run
//    through the shared `safeNoteSlug` gate (no separators / no `..`); a value that slugs to empty FAILS CLOSED.
//    The human-readable slug lives in frontmatter ONLY.
//  • REQ-F-011: EVERY committed percent (note body AND dashboard row) is RE-DERIVED via `computePercent` from
//    the counts — never a narrative field, never a verbatim `progress.percentComplete`.
//  • No-inference (REQ-F-017): the note prose renders through the SAME `renderProseLines` helper the dashboard
//    uses (TBD-skip + single-line collapse + cap) — one shared defense, never a duplicated re-implementation.
import { ok, err } from "@sow/contracts";
import type { Result, WorkspaceId, NoteCreate } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import { buildProjectDashboardPayload, renderProseLines } from "../projectDashboard";
import type { ProjectDashboardProse } from "../projectDashboard";
import { computePercent } from "../deterministicProgress";
import type { SyncOutputsProjection } from "../deterministicProgress";
import type {
  ProjectIdentity,
  DeterministicProgress,
  ValidatedNarrative,
  BuildSyncOutputsFailure,
} from "../../ports/projectSync";
import { safeNoteSlug } from "./noteSlug";

/** The KN-7 assistant-region id wrapping all sync-mutable note content (frontmatter + H1 stay human scaffold). */
const PROJECT_STATUS_REGION = "project-status";

const fail = (code: BuildSyncOutputsFailure["code"], message: string): BuildSyncOutputsFailure => ({ code, message });

/**
 * Collect a dashboard category's ExtractionFields from the narrative under the positional-index convention
 * `<prefix>.<n>` (e.g. `blockers.0`, `blockers.1`), returned in ascending index order (deterministic). A field
 * NOT matching `<prefix>.<n>` is IGNORED (evidence-only — never fabricated). Per-item indexing lets each item be
 * individually no-inference-gated + rendered (contrast an array-valued field, which the no-inference gate could
 * only pass/fail as a unit). This is the de-facto `sow:project-sync-output` field vocabulary.
 */
function categoryFields(
  fields: Record<string, ExtractionField<unknown>>,
  prefix: string,
): ExtractionField<string>[] {
  const re = new RegExp(`^${prefix}\\.(\\d+)$`, "u");
  const hits: Array<[number, ExtractionField<string>]> = [];
  for (const [k, f] of Object.entries(fields)) {
    const m = re.exec(k);
    // Only a genuinely-string value (or TBD) is a valid prose field — a non-string value is DROPPED, never
    // String()-coerced into canonical Markdown (mirrors meetingOutputs' concreteString discipline). The
    // parsed index is clamped so an absurd (Infinity) index can't make the sort comparator non-deterministic.
    if (m && isStringField(f)) hits.push([boundedIndex(m[1]!), f]);
  }
  hits.sort((a, b) => a[0] - b[0]);
  return hits.map(([, f]) => f);
}

/** A field usable as prose: its value is a real string, or the TBD sentinel (renderProseLines skips TBD). */
function isStringField(f: ExtractionField<unknown>): f is ExtractionField<string> {
  return typeof f.value === "string" || f.value === TBD;
}

/** Parse a positional index, clamped to a sane bound so a pathological key can't yield Infinity/NaN ordering. */
function boundedIndex(digits: string): number {
  const n = Number(digits);
  return Number.isFinite(n) ? Math.min(n, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
}

/** The scalar `explanation` prose lead, rendered leak-safe (TBD / non-string / absent → undefined). */
function explanationLine(fields: Record<string, ExtractionField<unknown>>): string | undefined {
  const f = fields["explanation"];
  if (f === undefined || !isStringField(f) || f.value === TBD) return undefined;
  return renderProseLines([f])[0];
}

/**
 * WS-8 note path: `projects/<workspaceId>/<safeLeaf>.md`, where the workspace folder segment is the SERVER-BOUND
 * workspaceId (never the slug) and the leaf is the projectId sanitized by `safeNoteSlug`. Returns null when the
 * projectId sanitizes to empty (no safe anchor) → the caller fails closed. Stable per project (good for re-runs).
 */
function projectNotePath(workspaceId: WorkspaceId, projectId: string): string | null {
  const leaf = safeNoteSlug(projectId);
  if (leaf.length === 0) return null;
  return `projects/${String(workspaceId)}/${leaf}.md`;
}

/** Render one Markdown section: header + a bullet per line; omitted entirely when there are no lines. */
function section(header: string, lines: readonly string[]): string {
  if (lines.length === 0) return "";
  return `## ${header}\n${lines.map((l) => `- ${l}`).join("\n")}\n\n`;
}

/**
 * Build the concrete SyncOutputsProjection. Stateless (no injected clock/identity — all inputs arrive via
 * `project()`), so it is pure + testable. Returns the {note, dashboard-envelope, actions} the activity wraps
 * into the KnowledgeMutationPlan; a null dashboard (unservable identity) or an empty note leaf fails closed.
 */
export function createProjectSyncOutputsProjection(): SyncOutputsProjection {
  return {
    project(
      validated: ValidatedNarrative,
      progress: DeterministicProgress,
      workspaceId: WorkspaceId,
      identity: ProjectIdentity,
      updatedAt: string,
    ): Result<
      { note: NoteCreate; dashboard: Record<string, unknown>; actions: readonly never[] },
      BuildSyncOutputsFailure
    > {
      // 1. categorize the narrative prose (evidence-only; unknown keys ignored).
      const prose: ProjectDashboardProse = {
        blockers: categoryFields(validated.fields, "blockers"),
        waitingItems: categoryFields(validated.fields, "waitingItems"),
        nextActions: categoryFields(validated.fields, "nextActions"),
      };
      const lead = explanationLine(validated.fields);

      // 2. dashboard — REUSE the pure builder (percent RE-DERIVED there; TBD-skip via renderProseLines).
      const dashboard = buildProjectDashboardPayload({
        projectId: identity.projectId,
        title: identity.title,
        status: identity.lifecycleState,
        progress,
        prose,
        evidenceRefs: [],
        updatedAt,
      });
      if (dashboard === null) {
        return err(fail("unmappable_progress", "project identity/timestamp unservable for the dashboard row"));
      }

      // 3. note path — WS-8: rooted at workspaceId, fail-closed on an empty leaf.
      const path = projectNotePath(workspaceId, identity.projectId);
      if (path === null) {
        return err(fail("build_failed", "projectId has no safe note-path anchor (sanitizes to empty)"));
      }

      const note: NoteCreate = {
        path,
        title: identity.title,
        frontmatter: {
          projectId: identity.projectId,
          slug: identity.slug, // display/frontmatter ONLY — never the physical path (WS-8)
          workspaceId: String(workspaceId),
          lifecycleState: identity.lifecycleState,
          provenanceOrigin: "project_sync",
          title: identity.title,
        },
        body: composeBody(identity, progress, prose, lead, updatedAt),
      };

      // 4. the {workspaceId, dashboard} envelope the real update port re-validates.
      return ok({ note, dashboard: { workspaceId: String(workspaceId), dashboard }, actions: [] });
    },
  };
}

/**
 * Compose the project-status note body: frontmatter + H1 are the stable human scaffold; ALL sync-mutable content
 * is wrapped in the `kw:region:project-status` assistant region (KN-7). The percent is RE-DERIVED via
 * `computePercent` (REQ-F-011 — never verbatim); prose renders via the SHARED `renderProseLines` (no-inference).
 * An empty category omits its whole `## <Header>` section (no bare header).
 */
function composeBody(
  identity: ProjectIdentity,
  progress: DeterministicProgress,
  prose: ProjectDashboardProse,
  lead: string | undefined,
  updatedAt: string,
): string {
  const completed = Math.max(0, Math.trunc(progress.completedCount));
  const total = Math.max(0, Math.trunc(progress.totalCount));
  const percent = computePercent(completed, total); // REQ-F-011 — re-derive, never verbatim
  return [
    `# ${identity.title} — Status\n\n`,
    `<!-- kw:region:${PROJECT_STATUS_REGION} -->\n`,
    ...(lead !== undefined ? [`${lead}\n\n`] : []),
    `## Progress\n${completed} / ${total} tasks complete (${percent}%)\n\n`,
    section("Blockers", renderProseLines(prose.blockers)),
    section("Waiting on", renderProseLines(prose.waitingItems)),
    section("Next actions", renderProseLines(prose.nextActions)),
    `_Last synced ${updatedAt}_\n`,
    `<!-- /kw:region:${PROJECT_STATUS_REGION} -->\n`,
  ].join("");
}

// P3 (§9.5 / §13.5) — the pure Project-dashboard PAYLOAD builder. Turns the DETERMINISTIC progress facts + the
// no-inference-gated prose into a servable `UiSafeProjectDashboard` — the concrete shape the projectSync
// `BuildSyncOutputsPort`/`SyncOutputsProjection` `dashboard` field must carry (today it is an opaque
// `Record<string,unknown>`), and that the worker's `ProjectSyncUpdateDashboardPort` upserts into
// `read_models[project_dashboards]`. PURE + deterministic + never-throws (no clock/IO — the caller supplies
// `updatedAt`).
//
// TWO load-bearing invariants:
//  (1) REQ-F-011 DETERMINISTIC PROGRESS: `percentComplete` is RE-DERIVED here via `computePercent` from the
//      counts — NEVER trusted from an input field — so the served row satisfies the worker's re-check
//      (`sanitizeProjectDashboards`: percent === computePercent(completed,total)) by construction. A
//      model-supplied percentage can never become the served number.
//  (2) NO-INFERENCE prose (REQ-F-017): the prose arrays come from a ValidatedNarrative's ExtractionFields. A
//      `TBD` (unstated) value is SKIPPED (not rendered as a guess); a concrete value is rendered. Each entry is
//      collapsed to a single line (defense-in-depth — a multi-line entry is the shape of leaked raw content)
//      and the arrays are capped. The field-key→category extraction from `validated.fields` is the caller's job
//      (that convention is the arch_gap §9/Phase-7 synthesis-output schema) — this builder takes the already
//      categorized fields so it stays decoupled + testable.
import {
  UiSafeProjectDashboardSchema,
  MANAGED_DOC_SLOTS,
  collapseToSummaryLine,
} from "@sow/contracts";
import type { UiSafeProjectDashboard, UiSafeManagedDoc } from "@sow/contracts";
import { TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import { computePercent } from "./deterministicProgress";
import type { DeterministicProgress } from "../ports/projectSync";

/** The pre-categorized, no-inference-gated prose fields (one ExtractionField per entry). */
export interface ProjectDashboardProse {
  readonly blockers: readonly ExtractionField<string>[];
  readonly waitingItems: readonly ExtractionField<string>[];
  readonly nextActions: readonly ExtractionField<string>[];
}

/** The pure builder's input — identity + the deterministic facts + the validated prose + opaque evidence. */
export interface ProjectDashboardInput {
  readonly projectId: string;
  readonly title: string;
  /** A display status token (e.g. the Project lifecycleState "active") — a free display string. */
  readonly status: string;
  readonly progress: DeterministicProgress;
  readonly prose: ProjectDashboardProse;
  /** OPAQUE canonical evidence ids (never paths/URLs — the caller supplies opaque refs). */
  readonly evidenceRefs?: readonly string[];
  readonly updatedAt: string;
}

/** The per-array element cap (matches the schema's `.max(50)`). */
export const PROSE_ARRAY_CAP = 50;

/**
 * Render pre-categorized ExtractionFields to a bounded, leak-safe string array — the LOAD-BEARING no-inference
 * render defense (REQ-F-017): skip TBD (unstated — never a guess), collapse each concrete value to a SINGLE
 * line (a multi-line value is the shape of leaked raw content), cap the count. EXPORTED + shared: the concrete
 * projectSync projection's committed NOTE body MUST render its prose through THIS same helper so the dashboard
 * row and the canonical Markdown carry byte-identical no-inference defense (never a duplicated re-implementation
 * where a dropped TBD-skip could commit an unstated value into canonical truth).
 */
export function renderProseLines(fields: readonly ExtractionField<string>[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    if (f.value === TBD) continue; // unstated → not shown (REQ-F-017)
    const line = collapseToSummaryLine(String(f.value));
    if (line.length > 0) out.push(line);
    if (out.length >= PROSE_ARRAY_CAP) break;
  }
  return out;
}

/** The default doc pack: the 5 canonical slots, honestly unlinked/unknown until a Drive connector exists. */
function defaultDocPack(): UiSafeManagedDoc[] {
  return MANAGED_DOC_SLOTS.map((s) => ({
    slot: s.slot,
    title: s.title,
    linkState: "unlinked" as const,
    syncState: "unknown" as const,
  }));
}

/**
 * Build the servable `UiSafeProjectDashboard` from the deterministic facts + validated prose. Returns the
 * `.safeParse`-validated row on success. Returns `null` ONLY when the identity/timestamp is itself unservable
 * (empty projectId/title/status or a non-ISO updatedAt) — a genuinely unbuildable row; the caller (the update
 * port) skips a null rather than writing a malformed dashboard. Never throws.
 */
export function buildProjectDashboardPayload(input: ProjectDashboardInput): UiSafeProjectDashboard | null {
  const completedCount = Math.max(0, Math.trunc(input.progress.completedCount));
  const totalCount = Math.max(0, Math.trunc(input.progress.totalCount));
  const candidate: UiSafeProjectDashboard = {
    projectId: input.projectId,
    title: collapseToSummaryLine(input.title),
    status: input.status,
    // (1) REQ-F-011 — re-derive; never trust an input percent.
    progress: { completedCount, totalCount, percentComplete: computePercent(completedCount, totalCount) },
    // (2) no-inference prose — TBD skipped, single-lined, capped.
    blockers: renderProseLines(input.prose.blockers),
    waitingItems: renderProseLines(input.prose.waitingItems),
    nextActions: renderProseLines(input.prose.nextActions),
    evidenceRefs: (input.evidenceRefs ?? []).slice(0, PROSE_ARRAY_CAP),
    docPack: defaultDocPack(),
    updatedAt: input.updatedAt,
  };
  const parsed = UiSafeProjectDashboardSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

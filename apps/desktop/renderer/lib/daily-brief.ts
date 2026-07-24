// 9.20 — the deterministic, model-FREE Today daily brief. A pure, window-free assembler (LESSON 3) over the
// hydrated store's UI-safe COUNTS — recent changes · items to triage · pending approvals — producing an
// honest one-line summary + a compact meta chip line. NO model call, NO side effects; renders only counts
// (desktop rule 5 — no raw content can leak, the input is numbers). This is the demo/offline brief; the rich
// model-synthesized briefing (query.copilotBriefing) stays the separate on-request Copilot path (Phase-24.x).
// System-health "issues" are intentionally NOT a brief stat (that conflates infra health with work items and
// duplicates the System Health section rendered directly below the brief).

/** The UI-safe counts the brief summarizes (assembled in App.tsx from the scope-hydrated store slices). */
export interface DailyBriefStats {
  readonly recentChanges: number;
  readonly toTriage: number;
  readonly pendingApprovals: number;
}

/** The assembled brief: a narrative headline (`summary`) + a compact chip line (`meta`) + the raw counts. */
export interface DailyBrief {
  readonly summary: string;
  readonly meta: string;
  readonly stats: DailyBriefStats;
}

/** `n one` / `n many` with the count prefixed (honest singular/plural — never "1 items"). */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Assemble the deterministic daily brief from UI-safe counts. The headline is the single most-actionable
 * non-zero stat (pending approvals > items to triage > recent changes); the meta chip line lists ALL non-zero
 * counts in a fixed order, zero-dropped (empty string when nothing is non-zero). All-zero ⇒ an honest
 * "caught up" line (never a mockup, never a crash). Pure + deterministic.
 */
export function buildDailyBrief(stats: DailyBriefStats): DailyBrief {
  const { recentChanges, toTriage, pendingApprovals } = stats;

  // Headline — the single most-actionable non-zero stat.
  let summary: string;
  if (pendingApprovals > 0) {
    summary = `${count(pendingApprovals, "approval is", "approvals are")} waiting on you.`;
  } else if (toTriage > 0) {
    summary = `${count(toTriage, "item is", "items are")} waiting to be triaged.`;
  } else if (recentChanges > 0) {
    summary = `${count(recentChanges, "recent change", "recent changes")} to review.`;
  } else {
    summary = "You're all caught up — nothing new to review yet.";
  }

  // Meta chip line — all non-zero counts, fixed order, zero-dropped.
  const chips: string[] = [];
  if (recentChanges > 0) chips.push(count(recentChanges, "recent change", "recent changes"));
  if (toTriage > 0) chips.push(`${toTriage} to triage`);
  if (pendingApprovals > 0) chips.push(count(pendingApprovals, "pending approval", "pending approvals"));

  return { summary, meta: chips.join(" · "), stats };
}

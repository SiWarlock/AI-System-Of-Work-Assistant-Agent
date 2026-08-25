// A short human relative-time from an ISO instant ("just now" / "3h" / "2d"). Display-only —
// pure/DOM-free (Date + Math only, no `window`), so it typechecks under the node tier (LESSONS
// §3) despite living beside the render surfaces that consume it. Single-sourced (25.6): the
// Today "Recent activity" / "Workflow runs" rows and the Projects surface's `updatedAt` freshness
// line all format the same way — extracted here so the two consumers can't silently drift
// (contracts LESSONS §5/§37/§88 — a display formatter shared by two surfaces should be ONE
// definition, not two that happen to agree today).
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

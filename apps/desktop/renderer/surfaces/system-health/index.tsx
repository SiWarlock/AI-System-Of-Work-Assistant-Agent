import type { ReactElement } from "react";
import type { UiSafeHealthItem } from "@sow/contracts/api/ui-safe";

// Task 14.3 (desktop leg) — the System Health panel. Renders the retained UiSafeHealthItems
// (state / class / severity / timing) the worker already projected redaction-safe. It reads ONLY
// the UI-safe fields present on the item (the frozen HealthItem's message / auditRef /
// parityReportRef / factIdentity were dropped worker-side and are not on this type) — the surface
// never reconstructs or requests a raw field. Empty-until-data.

export interface SystemHealthProps {
  /** The retained System-Health items (already UI-safe / redaction-safe from the worker). */
  readonly items: readonly UiSafeHealthItem[];
}

export function SystemHealth({ items }: SystemHealthProps): ReactElement {
  return (
    <div className="sow-system-health" role="main" aria-label="System Health">
      <h1>System Health</h1>
      {items.length === 0 ? (
        <div className="sow-empty" role="status">
          All clear — no health items
        </div>
      ) : (
        <ul className="sow-health-list" aria-label="Health items">
          {items.map((it) => (
            <li
              key={it.id}
              className="sow-health-item"
              data-health-id={it.id}
              data-state={it.state}
              data-severity={it.severity}
            >
              <span className="sow-health-class">{it.failureClass}</span>
              <span className="sow-health-severity">{it.severity}</span>
              <span className="sow-health-state">{it.state}</span>
              <span className="sow-health-opened">{it.openedAt}</span>
              {it.resolvedAt !== undefined ? (
                <span className="sow-health-resolved">{it.resolvedAt}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

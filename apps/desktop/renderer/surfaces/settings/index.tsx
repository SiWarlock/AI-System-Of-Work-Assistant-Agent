import type { ReactElement } from "react";
import type { Route } from "../../store/route";

// The Settings hub — what the toolbar gear and the sidebar "Settings" row open.
//
// ⛔ WHY THIS EXISTS — owner report 2026-09-21: "the dark mode toggle looks weird and doesn't work".
// It was the toolbar Settings gear, drawn so it read as a sun, with no click handler. The sidebar
// Settings row was dead as well, and there was no Settings screen for either one to open.
//
// ⚠ It lists ONLY settings screens that exist. The old sidebar hint promised "Models · Audit ·
// Workspaces"; none of those are built, and a row that leads nowhere is the defect this replaces.
// Add a row here in the same change that builds its screen, never before.

interface SettingsRow {
  readonly title: string;
  readonly description: string;
  readonly route: Route;
}

const ROWS: readonly SettingsRow[] = [
  {
    title: "Connectors",
    description: "Connect services to a workspace and save their keys to your Keychain.",
    route: { surface: "connectors" },
  },
  {
    title: "Egress",
    description: "Choose which services may receive each workspace's data.",
    route: { surface: "workspace-settings" },
  },
];

export interface SettingsProps {
  readonly onNavigate: (route: Route) => void;
}

export function Settings({ onNavigate }: SettingsProps): ReactElement {
  return (
    <main className="sow-content sow-settings" aria-label="Settings">
      <div className="sow-page-head">
        <h1>Settings</h1>
      </div>
      <ul className="sow-settings-list">
        {ROWS.map((row) => (
          <li key={row.title}>
            <button type="button" className="sow-settings-row" onClick={() => onNavigate(row.route)}>
              <span className="sow-settings-row-text">
                <span className="sow-settings-row-title">{row.title}</span>
                <span className="sow-settings-row-desc">{row.description}</span>
              </span>
              <svg
                className="sow-settings-row-chev"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          </li>
        ))}
      </ul>
    </main>
  );
}

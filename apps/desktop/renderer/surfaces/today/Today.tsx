// Global Today Dashboard — macOS Liquid Glass (LOCKED 2026-07-03)
//
// Renders into a real Electron window with titleBarStyle:'hiddenInset' +
// real system vibrancy.  There is NO fake menu bar, NO fake window border,
// NO fake traffic lights — the OS provides all three.  The root element fills
// 100vw/100vh and is transparent so the real vibrancy shows through each pane.
//
// Imports:
//   - react (types)                   — ReactElement, type only
//   - ../../store                     — ConnectionStatus (type only)
//   - @sow/contracts                  — UiSafe* (types only)
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useState, type CSSProperties, type ReactElement } from "react";
import type { ConnectionStatus } from "../../store";
import { WORKSPACE_SCOPES, scopeMeta, type WorkspaceScope } from "../../store/scope";
import { groupGlobalByWorkspace } from "../../store/projections";
import type {
  UiSafeDashboardCard,
  UiSafeHealthItem,
  UiSafeGclProjection,
} from "@sow/contracts/api/ui-safe";

export interface TodayProps {
  readonly connection: ConnectionStatus;
  readonly scope: WorkspaceScope;
  readonly onScopeChange: (scope: WorkspaceScope) => void;
  readonly cards: readonly UiSafeDashboardCard[];
  readonly health: readonly UiSafeHealthItem[];
  /** The Global-scope cross-workspace GCL surface (§9.4). */
  readonly global: readonly UiSafeGclProjection[];
  /** Request a policy-gated drill-down into a workspace's context (worker-enforced). */
  readonly onDrillDown: (workspaceId: string, projectionType: string) => void;
}

/** Set the subtle per-workspace accent via a CSS var (dot + scope line only). */
function accentVar(accent: string): CSSProperties {
  return { ["--sow-ws-accent"]: accent } as CSSProperties;
}

// ── Workspace scope switcher (top-bar pull-down) ───────────────────────────────

function ScopeSwitcher({
  scope,
  onScopeChange,
}: {
  readonly scope: WorkspaceScope;
  readonly onScopeChange: (scope: WorkspaceScope) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const current = scopeMeta(scope);
  return (
    <div
      className="sow-ws-switch-wrap"
      onKeyDown={(e) => {
        if (e.key === "Escape") setOpen(false);
      }}
    >
      <button
        className="sow-ws-switch"
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Workspace scope: ${current.label}`}
        style={accentVar(current.accent)}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="sow-ws-dot" aria-hidden="true" />
        <span>{current.label}</span>
        <span className="sow-ws-chev" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 9l4-4 4 4" />
            <path d="M16 15l-4 4-4-4" />
          </svg>
        </span>
      </button>
      {open ? (
        <ul className="sow-ws-menu" role="listbox" aria-label="Workspace scope">
          {WORKSPACE_SCOPES.map((m) => {
            const selected = m.id === scope;
            return (
              <li
                key={m.id}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                className={selected ? "sow-ws-opt sow-ws-opt--sel" : "sow-ws-opt"}
                style={accentVar(m.accent)}
                onClick={() => {
                  onScopeChange(m.id);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onScopeChange(m.id);
                    setOpen(false);
                  }
                }}
              >
                <span className="sow-ws-dot" aria-hidden="true" />
                <span className="sow-ws-opt-label">{m.label}</span>
                {selected ? (
                  <svg className="sow-ws-opt-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12l4 4 10-10" />
                  </svg>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

// ── Connection status pill ─────────────────────────────────────────────────

function ConnectionPill({ connection }: { readonly connection: ConnectionStatus }): ReactElement {
  switch (connection) {
    case "live":
      return (
        <span className="sow-pill sow-pill-live">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
          Live
        </span>
      );
    case "connecting":
      return (
        <span className="sow-pill sow-pill-connecting" aria-live="polite">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
          </svg>
          Connecting…
        </span>
      );
    case "reconnecting":
      return (
        <span className="sow-pill sow-pill-connecting" aria-live="polite">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
          </svg>
          Reconnecting…
        </span>
      );
    case "worker-down":
      return (
        <span className="sow-pill sow-pill-down" role="alert">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 4l9 15.5H3z" />
            <path d="M12 10v4.5M12 17.2v.3" />
          </svg>
          Worker offline
        </span>
      );
  }
}

// ── Waiting-on-you cards ───────────────────────────────────────────────────

function DashboardCards({ cards }: { readonly cards: readonly UiSafeDashboardCard[] }): ReactElement {
  if (cards.length === 0) {
    return (
      <div className="sow-empty" role="status">
        Nothing waiting
      </div>
    );
  }
  return (
    <div className="sow-cards-grid">
      {cards.map((card) => (
        <div className="sow-stat-card" key={card.cardId} tabIndex={0}>
          <span className="sow-card-arr" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </span>
          <div className="sow-card-num" aria-label={`${String(card.count)} ${card.title}`}>
            {card.count}
          </div>
          <div className="sow-card-name">{card.title}</div>
        </div>
      ))}
    </div>
  );
}

// ── System health ──────────────────────────────────────────────────────────

/** Render an enum token ("connector_unreachable") as readable text ("Connector unreachable"). */
function humanizeToken(token: string): string {
  const spaced = token.replace(/[_-]+/g, " ").trim();
  return spaced.length === 0 ? token : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function HealthSection({ health }: { readonly health: readonly UiSafeHealthItem[] }): ReactElement {
  if (health.length === 0) {
    return (
      <div className="sow-callout sow-callout--healthy" role="status">
        <span className="sow-callout-ico sow-callout-ico--healthy" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 12l2 2 4-4" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </span>
        <div className="sow-callout-body">
          <div className="sow-callout-title">All systems healthy</div>
        </div>
      </div>
    );
  }
  return (
    <div className="sow-health-list">
      {health.map((item) => (
        <div className="sow-callout" key={item.id}>
          <span className="sow-callout-ico" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4l9 15.5H3z" />
              <path d="M12 10v4.5M12 17.2v.3" />
            </svg>
          </span>
          <div className="sow-callout-body">
            <div className="sow-callout-title">{humanizeToken(item.failureClass)}</div>
            <div className="sow-callout-sub">
              {item.severity} · {humanizeToken(item.state)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Global (§9.4) cross-workspace grouped surface ──────────────────────────

function GlobalGroups({
  global,
  onDrillDown,
}: {
  readonly global: readonly UiSafeGclProjection[];
  readonly onDrillDown: (workspaceId: string, projectionType: string) => void;
}): ReactElement {
  const groups = groupGlobalByWorkspace(global);
  if (groups.length === 0) {
    return (
      <div className="sow-empty" role="status">
        Nothing across your workspaces yet
      </div>
    );
  }
  return (
    <div className="sow-global-groups">
      {groups.map((group) => {
        // Resolve the workspace's label + subtle accent; unknown ids (pre-onboarding)
        // fall back to the raw id + the app blue.
        const meta = WORKSPACE_SCOPES.find((m) => m.workspaceId === group.workspaceId);
        const label = meta?.label ?? group.workspaceId;
        return (
          <section
            className="sow-global-group"
            key={group.workspaceId}
            style={accentVar(meta?.accent ?? "#0a84ff")}
          >
            <div className="sow-global-group-head">
              <span className="sow-ws-dot" aria-hidden="true" />
              <span className="sow-global-group-name">{label}</span>
            </div>
            <div className="sow-grouped" role="list" aria-label={`${label} — across workspaces`}>
              {group.items.map((item, i) => (
                <div className="sow-row sow-global-row" role="listitem" key={`${item.projectionType}-${String(i)}`}>
                  <span className="sow-global-type">{humanizeToken(item.projectionType)}</span>
                  <span className="sow-global-summary">{item.summary}</span>
                  {item.drillable ? (
                    <button
                      className="sow-global-drill"
                      type="button"
                      aria-label={`Open ${label} — ${humanizeToken(item.projectionType)}`}
                      onClick={() => onDrillDown(item.workspaceId, item.projectionType)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Today date subtitle ────────────────────────────────────────────────────

function todayLabel(): string {
  return new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

// ── Main component ─────────────────────────────────────────────────────────

export function Today(props: TodayProps): ReactElement {
  const { connection, scope, onScopeChange, cards, health, global, onDrillDown } = props;

  return (
    <div className="sow-shell">
      {/* ── Unified toolbar ─────────────────────────────────────────────── */}
      <header className="sow-toolbar" role="banner">
        {/*
          -webkit-app-region: drag is set on .sow-toolbar.
          All interactive controls are wrapped in .sow-toolbar-nodrag
          (display: contents) so they opt out of the drag region.
        */}
        <div className="sow-toolbar-nodrag">
          {/* Workspace scope switcher — All (Global) / the three workspaces */}
          <ScopeSwitcher scope={scope} onScopeChange={onScopeChange} />

          <div className="sow-tb-spacer" />

          {/* Search */}
          <button
            className="sow-tb-search"
            type="button"
            aria-label="Search or run a command (⌘K)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <span>Search or run a command</span>
            <span className="sow-tb-kbd" aria-label="keyboard shortcut Command K">⌘K</span>
          </button>

          <div className="sow-tb-spacer" />

          {/* Egress pill */}
          <span className="sow-pill sow-pill-egress" aria-label="Egress mode: local-only">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
              <path d="M9 12l2 2 4-4" />
            </svg>
            Egress:&nbsp;<span className="sow-pill-mono">local-only</span>
          </span>

          {/* Connection status pill */}
          <ConnectionPill connection={connection} />

          {/* Gear / settings */}
          <button className="sow-gear" type="button" aria-label="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7L5.6 5.6" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Workspace scope line (subtle per-workspace accent) ────────────── */}
      <div className="sow-scope-line" aria-hidden="true" style={accentVar(scopeMeta(scope).accent)} />

      {/* ── Three-pane body ───────────────────────────────────────────────── */}
      <div className="sow-body">

        {/* ── Nav sidebar ───────────────────────────────────────────────── */}
        <nav className="sow-sidebar" aria-label="Main navigation">
          <div className="sow-nav-section">Work</div>

          {/* Today — selected */}
          <div className="sow-nav-item sow-nav-item--sel" role="link" aria-current="page" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
              <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
              <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
              <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
            </svg>
            <span className="sow-nav-label">Today</span>
          </div>

          {/* Calendar */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
              <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
            </svg>
            <span className="sow-nav-label">Calendar</span>
          </div>

          {/* Approvals */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M8.5 12l2.5 2.5 4.5-5" />
            </svg>
            <span className="sow-nav-label">Approvals</span>
            <span className="sow-badge" aria-label="3 pending approvals">3</span>
          </div>

          {/* Inbox */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 13.5L6 5.5a2 2 0 0 1 1.9-1.5h8.2A2 2 0 0 1 18 5.5l2.5 8" />
              <path d="M3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5" />
              <path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5" />
            </svg>
            <span className="sow-nav-label">Inbox</span>
            <span className="sow-badge" aria-label="5 inbox items">5</span>
          </div>

          {/* Knowledge */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 4.5h11a2.5 2.5 0 0 1 2.5 2.5v12.5H7.5A2.5 2.5 0 0 1 5 19z" />
              <path d="M18.5 16H7.5A2.5 2.5 0 0 0 5 18.5" />
            </svg>
            <span className="sow-nav-label">Knowledge</span>
          </div>

          {/* Projects */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.5l2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19.5H6a2.5 2.5 0 0 1-2.5-2.5z" />
            </svg>
            <span className="sow-nav-label">Projects</span>
          </div>

          {/* Health — amber dot */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12h4l2-6 4 12 2-6h6" />
            </svg>
            <span className="sow-nav-label">Health</span>
            <span className="sow-dot-warn" aria-label="Health alert" role="img" />
          </div>

          <div className="sow-nav-divider" role="separator" />

          {/* Settings */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3.2" />
              <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7L5.6 5.6" />
            </svg>
            <span className="sow-nav-label">Settings</span>
            <svg className="sow-nav-chev-sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </div>
          <div className="sow-nav-hint" aria-label="Settings sections">
            Connectors · Models · Audit · Workspaces
          </div>
        </nav>

        {/* ── Content pane ──────────────────────────────────────────────── */}
        <main className="sow-content" aria-label="Today dashboard">
          {/* Page header */}
          <div className="sow-page-head">
            <div>
              <h1>Today</h1>
              <div className="sow-subtitle">{todayLabel()}</div>
            </div>
          </div>

          {/* Across your workspaces — the §9.4 Global GCL surface (Global scope only).
              Sanitized grouped results; drill-down is worker-enforced + workspace-scoped. */}
          {scope === "global" ? (
            <>
              <div className="sow-section-label">Across your workspaces</div>
              <GlobalGroups global={global} onDrillDown={onDrillDown} />
            </>
          ) : null}

          {/* Daily brief — static illustrative content (§ material-direction.md) */}
          <div className="sow-section-label">Daily brief</div>
          <p className="sow-brief-text">
            Two meetings on the calendar and one blocker to clear. Vendor review
            still needs close-out. Granola sync is degraded, so the standup
            transcript has not landed yet.
          </p>
          <div className="sow-brief-meta">
            3 decisions logged · 2 meetings · 1 open blocker
          </div>

          {/* Waiting on you — driven from props.cards */}
          <div className="sow-section-label">Waiting on you</div>
          <DashboardCards cards={cards} />

          {/* Today's schedule — static illustrative content */}
          <div className="sow-section-label">{"Today's schedule"}</div>
          <div className="sow-grouped" role="list" aria-label="Today's schedule">
            <div className="sow-row" role="listitem">
              <span className="sow-row-time">09:30</span>
              <span className="sow-row-title">Standup</span>
              <span className="sow-row-people">2 people</span>
              <span className="sow-row-state">transcript pending</span>
            </div>
            <div className="sow-row" role="listitem">
              <span className="sow-row-time">11:00</span>
              <span className="sow-row-title">Vendor review</span>
              <span className="sow-row-people">4 people</span>
              <span className="sow-row-state sow-row-state--attn">
                needs close-out
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
            </div>
            <div className="sow-row" role="listitem">
              <span className="sow-row-time">15:00</span>
              <span className="sow-row-title">1:1 with Priya</span>
              <span className="sow-row-people">2 people</span>
              <span className="sow-row-state">in 4 hours</span>
            </div>
          </div>

          {/* System health — driven from props.health */}
          <div className="sow-section-label">System health</div>
          <HealthSection health={health} />

          {/* Recent activity — static illustrative content */}
          <div className="sow-section-label">Recent activity</div>
          <div className="sow-activity" role="list" aria-label="Recent activity">
            <div className="sow-activity-row" role="listitem">
              <span className="sow-activity-who">KnowledgeWriter</span>
              committed
              <span className="sow-activity-file">meeting-2026-06-30-arch-sync.md</span>
              <span className="sow-activity-rev">rev 0c4</span>
              <span className="sow-activity-when">18h</span>
            </div>
            <div className="sow-activity-row" role="listitem">
              <span className="sow-activity-who">You</span>
              Approved: calendar hold for vendor review
              <span className="sow-activity-when">1d</span>
            </div>
            <div className="sow-activity-row" role="listitem">
              <span className="sow-activity-who">Calendar</span>
              connector synced
              <span className="sow-activity-rev">cursor 2026-07-01</span>
              <span className="sow-activity-when">2h</span>
            </div>
            <div className="sow-activity-row" role="listitem">
              <span className="sow-activity-who">KnowledgeWriter</span>
              committed
              <span className="sow-activity-file">decision-adopt-pgvector.md</span>
              <span className="sow-activity-rev">rev 0b9</span>
              <span className="sow-activity-when">1d</span>
            </div>
          </div>
        </main>

        {/* ── Copilot rail — collapsed ───────────────────────────────────── */}
        <aside className="sow-copilot-rail" aria-label="Copilot (collapsed)">
          {/* Gradient sparkle icon */}
          <span className="sow-rail-spark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2l1.8 5.4a4 4 0 0 0 2.8 2.8L22 12l-5.4 1.8a4 4 0 0 0-2.8 2.8L12 22l-1.8-5.4a4 4 0 0 0-2.8-2.8L2 12l5.4-1.8a4 4 0 0 0 2.8-2.8z" />
            </svg>
          </span>

          {/* Vertical label */}
          <span className="sow-rail-label" aria-hidden="true">
            Copilot
          </span>

          {/* Expand chevron */}
          <button
            className="sow-rail-chev"
            type="button"
            aria-label="Expand Copilot sidebar"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        </aside>

      </div>
    </div>
  );
}

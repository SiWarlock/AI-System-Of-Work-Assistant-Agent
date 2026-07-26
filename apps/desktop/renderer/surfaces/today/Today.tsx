// Today surface — the content pane that mounts inside the AppShell (LOCKED 2026-07-03).
//
// The persistent shell (top bar · scope switcher · scope line · left rail · Copilot rail)
// lives in chrome/AppShell; this file renders ONLY the Today <main> content. It is one of
// several routable surfaces (§9.5); it receives the scope-hydrated read-models as props.
//
// Imports:
//   - react (types)                   — ReactElement, type only
//   - ../../store                     — (unused type import removed with the shell)
//   - @sow/contracts                  — UiSafe* (types only)
// NEVER import electron, node, or @sow/worker from a renderer file.

import { type ReactElement } from "react";
import { type WorkspaceScope } from "../../store/scope";

/** Real workspaceId → its display name + subtle scope accent (from the onboarded set). */
export type WorkspaceMetaMap = ReadonlyMap<string, { readonly label: string; readonly accent: string }>;
import { groupGlobalByWorkspace } from "../../store/projections";
import { accentVar } from "../../lib/accent";
import type {
  UiSafeDashboardCard,
  UiSafeHealthItem,
  UiSafeGclProjection,
  UiSafeRecentChange,
  UiSafeTaskRollupItem,
} from "@sow/contracts/api/ui-safe";
import type { DailyBrief } from "../../lib/daily-brief";

export interface TodayProps {
  /** The active workspace scope (drives the Global-only cross-workspace section). */
  readonly scope: WorkspaceScope;
  readonly cards: readonly UiSafeDashboardCard[];
  readonly health: readonly UiSafeHealthItem[];
  /** The Global-scope cross-workspace GCL surface (§9.4). */
  readonly global: readonly UiSafeGclProjection[];
  /** The active workspace scope's Recent activity (§9.5; empty under Global — WS-8). */
  readonly recentChanges: readonly UiSafeRecentChange[];
  /** Real workspaceId → { label, accent } for the Global per-workspace rows (from onboarded set). */
  readonly workspaceMeta: WorkspaceMetaMap;
  /** The deterministic, store-assembled daily brief (9.20) — summary + meta chips from UI-safe counts. */
  readonly brief: DailyBrief;
  /**
   * The active workspace scope's PRE-RANKED highest-priority tasks (§13.16; empty under Global — WS-8).
   * Rendered in the worker's deterministic priority/dueDate order VERBATIM — the renderer NEVER re-sorts.
   */
  readonly tasks: readonly UiSafeTaskRollupItem[];
  /** Request a policy-gated drill-down into a workspace's context (worker-enforced). */
  readonly onDrillDown: (workspaceId: string, projectionType: string) => void;
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
  workspaceMeta,
  onDrillDown,
}: {
  readonly global: readonly UiSafeGclProjection[];
  readonly workspaceMeta: WorkspaceMetaMap;
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
        // Resolve the workspace's label + subtle accent from the ONBOARDED set (§19.1 / 14.1);
        // an unmatched id (a workspace not in the onboarded map) falls back to the raw id + app blue.
        const meta = workspaceMeta.get(group.workspaceId);
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
                <div className="sow-row sow-global-row" role="listitem" key={`${item.workspaceId}-${item.projectionType}-${String(i)}`}>
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

// ── Recent activity (§9.5) ─────────────────────────────────────────────────

/** A short human relative-time from an ISO instant ("just now" / "3h" / "2d"). Display-only. */
function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/**
 * Recent activity (§9.5) — a hairline-divided list of the active WORKSPACE scope's committed
 * knowledge mutations / audit-linked changes (never cards). Workspace-scoped: under Global
 * scope `changes` is empty (recent changes never blend cross-workspace; WS-8). `summary` is
 * the worker's single-line projector-built line; `kind` is a display token; `changeId` rides
 * as a data-attr — the (worker-mediated, scope-checked) audit-drill handle for a later slice.
 */
function RecentActivity({
  changes,
}: {
  readonly changes: readonly UiSafeRecentChange[];
}): ReactElement {
  if (changes.length === 0) {
    return (
      <div className="sow-activity" role="list" aria-label="Recent activity">
        <div className="sow-activity-row sow-activity-empty" role="listitem">
          No recent activity yet
        </div>
      </div>
    );
  }
  return (
    <div className="sow-activity" role="list" aria-label="Recent activity">
      {changes.map((change) => (
        <div
          className="sow-activity-row"
          role="listitem"
          key={change.changeId}
          data-change-id={change.changeId}
        >
          <span className="sow-activity-kind">{change.kind}</span>
          <span className="sow-activity-summary">{change.summary}</span>
          <span className="sow-activity-when">{relativeTime(change.occurredAt)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Top priorities (§13.16) ────────────────────────────────────────────────

/** A short bidirectional relative due label from an ISO instant ("due in 3h" / "overdue 2d"). Display-only. */
function dueLabel(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMin = Math.round((then - Date.now()) / 60_000);
  const abs = Math.abs(diffMin);
  const mag = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.floor(abs / 60)}h` : `${Math.floor(abs / 1440)}d`;
  return diffMin >= 0 ? `due in ${mag}` : `overdue ${mag}`;
}

/**
 * Top priorities (§13.16) — the active WORKSPACE scope's PRE-RANKED highest-priority tasks, rendered in
 * the worker's deterministic order VERBATIM (NEVER re-sorted by a renderer/model signal). Workspace-scoped:
 * under Global `tasks` is empty (tasks never blend cross-workspace; WS-8). Renders ONLY the allowlisted
 * UI-safe fields (title / status token / OPTIONAL priority token / OPTIONAL relative due / OPTIONAL
 * projectRef chip); `priority` ABSENT ⇒ NO badge (REQ-F-017 unset, never fabricated); `taskId` rides as a
 * non-interactive data-attr (the worker-mediated open is a follow-up, mirror `changeId`).
 */
function TopPriorities({ tasks }: { readonly tasks: readonly UiSafeTaskRollupItem[] }): ReactElement {
  if (tasks.length === 0) {
    return (
      <div className="sow-empty" role="status">
        No tasks
      </div>
    );
  }
  return (
    <ul className="sow-priorities" role="list" aria-label="Top priorities">
      {tasks.map((t) => (
        <li className="sow-priority-row" role="listitem" key={t.taskId} data-task-id={t.taskId}>
          <span className="sow-priority-title">{t.title}</span>
          <span className="sow-priority-status">{humanizeToken(t.status)}</span>
          {t.priority !== undefined ? (
            <span className={`sow-priority-badge sow-priority-badge--${t.priority}`}>{t.priority}</span>
          ) : null}
          {t.dueDate !== undefined ? <span className="sow-priority-due">{dueLabel(t.dueDate)}</span> : null}
          {/* projectRef renders the raw opaque id (like changeId); resolving it to a human project title
              is a follow-up (Today holds no project-name map for arbitrary refs — mirror the 9.9b flags). */}
          {t.projectRef !== undefined ? (
            <span className="sow-priority-project" data-project-ref={t.projectRef}>
              {t.projectRef}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export function Today(props: TodayProps): ReactElement {
  const { scope, cards, health, global, recentChanges, workspaceMeta, brief, tasks, onDrillDown } = props;

  return (
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
          <GlobalGroups global={global} workspaceMeta={workspaceMeta} onDrillDown={onDrillDown} />
        </>
      ) : null}

      {/* Daily brief — deterministic, store-assembled summary from UI-safe counts (9.20). NOT the
          model-synthesized briefing (that stays the separate on-request Copilot path). Populated by the
          demo-seed; an empty read-model yields an honest zero-brief (no mockup). */}
      <div className="sow-section-label">Daily brief</div>
      <p className="sow-brief-text">{brief.summary}</p>
      {brief.meta ? <div className="sow-brief-meta">{brief.meta}</div> : null}

      {/* Top priorities — the §13.16 pre-ranked highest-priority tasks (workspace-scoped; empty under
          Global — WS-8). Rendered in the served order VERBATIM; empty-until-data honest empty-state. */}
      <div className="sow-section-label">Top priorities</div>
      <TopPriorities tasks={tasks} />

      {/* Waiting on you — driven from props.cards */}
      <div className="sow-section-label">Waiting on you</div>
      <DashboardCards cards={cards} />

      {/* Today's schedule — no calendar data source exists until 9.9 Calendar (unbuilt). Honest empty
          state (no fabricated meetings); real rows land when 9.9 ships. */}
      <div className="sow-section-label">{"Today's schedule"}</div>
      <div className="sow-empty" role="status">
        No calendar connected
      </div>

      {/* System health — driven from props.health */}
      <div className="sow-section-label">System health</div>
      <HealthSection health={health} />

      {/* Recent activity — workspace-scoped, from props.recentChanges (§9.5) */}
      <div className="sow-section-label">Recent activity</div>
      <RecentActivity changes={recentChanges} />
    </main>
  );
}

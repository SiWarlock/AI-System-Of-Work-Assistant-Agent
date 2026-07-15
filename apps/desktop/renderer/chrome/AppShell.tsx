// AppShell — the persistent macOS Liquid Glass shell (LOCKED 2026-07-03).
//
// Extracted from Today (§9.5 routing foundation) so every surface (Today, Projects, …)
// mounts inside the SAME shell: the top bar (scope switcher + ⌘K + egress + connection),
// the thin per-workspace scope line, the left-rail nav, and the collapsed Copilot rail.
// The active surface renders as {children}.
//
// Two INDEPENDENT axes (root design + §9.4/§9.5):
//   - SCOPE (workspace) — the top-bar switcher; re-scopes the DATA. Owned here.
//   - ROUTE (surface)   — the left-rail nav; selects WHICH surface mounts. Owned here.
// The shell wires both but entangles neither: switching scope does not navigate; navigating
// does not re-scope. The scope switcher + its dismissal behavior are moved VERBATIM from the
// prior Today shell (security-reviewed §9.4) — this extraction changes structure, not behavior.
//
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ConnectionStatus } from "../store";
import { WORKSPACE_SCOPES, scopeMeta, type WorkspaceScope } from "../store/scope";
import { useRovingListbox } from "../lib/a11y/useRovingListbox";
import type { Route } from "../store/route";
import { accentVar } from "../lib/accent";
import { Copilot } from "../surfaces/copilot/Copilot";
import type { AskResult } from "../lib/copilot-ask";

export interface AppShellProps {
  readonly connection: ConnectionStatus;
  readonly scope: WorkspaceScope;
  readonly onScopeChange: (scope: WorkspaceScope) => void;
  /** The mounted surface (drives the left-rail active state). */
  readonly route: Route;
  /** Navigate to a surface (left-rail nav). Never changes scope. */
  readonly onNavigate: (route: Route) => void;
  /** Ask Copilot a question (§9.6). Present → the Copilot composer is LIVE; absent → disabled scaffold. */
  readonly onAskCopilot?: (question: string) => Promise<AskResult>;
  /**
   * WS-8 gate for the Copilot ask composer (§19.1 / 14.1): true iff the active scope resolves to a
   * single ONBOARDED workspace. False (Global / non-onboarded / unknown) → the pick-a-workspace
   * state — you cannot ask an un-onboarded workspace. Computed by App from the onboarded store slice.
   */
  readonly copilotWorkspaceScoped: boolean;
  /** The pending-approval count (§9.8) for the Approvals nav badge; 0/undefined → no pill. */
  readonly pendingApprovalCount?: number;
  /** The active-scope ingestion-inbox count (§9.7) for the Inbox nav badge; 0/undefined → no pill. */
  readonly ingestionCount?: number;
  /** The active surface, rendered in the content pane. */
  readonly children: ReactNode;
}

// ── Workspace scope switcher (top-bar pull-down) ───────────────────────────────
// Moved VERBATIM from the prior Today shell (§9.4, security-reviewed). Do not alter the
// dismissal behavior (outside-click / Escape / tab-away) or the ARIA listbox semantics.

function ScopeSwitcher({
  scope,
  onScopeChange,
}: {
  readonly scope: WorkspaceScope;
  readonly onScopeChange: (scope: WorkspaceScope) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const current = scopeMeta(scope);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Return focus to the trigger on a KEYBOARD close (Escape / selection) — NOT on outside-click or
  // tab-away, where focus follows the user's action (yanking it back would fight the user + alter the
  // security-reviewed dismissals). Guarded exactly like the Copilot rail's `returnFocusToRail` (below)
  // so it never fires on the initial closed mount; only the keyboard-close paths raise the flag, so the
  // dismissal code paths stay byte-unchanged.
  const returnFocusToButton = useRef(false);
  // Roving-tabindex over the scope options: the active (selected) scope is the single tab stop; arrows
  // browse, Enter/Space selects (explicit selection). The optional `open` signal drives popup
  // focus-on-open (focus the active option) + reset-on-open (roving position back to the selected scope).
  const selectedIndex = WORKSPACE_SCOPES.findIndex((m) => m.id === scope);
  const roving = useRovingListbox({
    count: WORKSPACE_SCOPES.length,
    selectedIndex,
    open,
    onActivate: (i) => {
      const m = WORKSPACE_SCOPES[i];
      if (m !== undefined) {
        onScopeChange(m.id);
        returnFocusToButton.current = true; // a selection is a keyboard-loop close → return focus
        setOpen(false);
      }
    },
  });

  // On a keyboard-driven close (the flag set by Escape / selection), return focus to the trigger button
  // once the popup has closed. Mirror of the Copilot-rail disclosure pattern; a no-op on outside-click /
  // tab-away closes (the flag stays false) and on the initial mount (starts false).
  useEffect(() => {
    if (!open && returnFocusToButton.current) {
      buttonRef.current?.focus();
      returnFocusToButton.current = false;
    }
  }, [open]);

  // Close the pull-down on any outside click (the ARIA listbox dismissal the menu
  // otherwise lacks — Escape + selection close it, but a click elsewhere would leave
  // it stuck open over the content). Registered only while open.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div
      className="sow-ws-switch-wrap"
      ref={wrapRef}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Only ARM return-focus when the popup is actually open (the flag rises solely while open —
          // matching the Copilot-rail precedent). Escape fires on this always-mounted wrap even when
          // closed (focus on the trigger); arming then would leave the flag stuck for a LATER
          // non-keyboard close to consume, wrongly yanking focus back. Guard closes that leak.
          if (open) returnFocusToButton.current = true;
          setOpen(false);
        }
      }}
      onBlur={(e) => {
        // Also close on keyboard tab-away (focus leaves the switcher entirely). NO return-focus here —
        // focus already followed the user's tab; the flag stays false (security-reviewed dismissal, unchanged).
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        className="sow-ws-switch"
        type="button"
        ref={buttonRef}
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
        <ul className="sow-ws-menu" role="listbox" aria-label="Workspace scope" {...roving.listboxProps}>
          {WORKSPACE_SCOPES.map((m, i) => {
            const selected = m.id === scope;
            const opt = roving.getOptionProps(i);
            return (
              <li
                key={m.id}
                role="option"
                aria-selected={selected}
                tabIndex={opt.tabIndex}
                ref={opt.ref}
                className={selected ? "sow-ws-opt sow-ws-opt--sel" : "sow-ws-opt"}
                style={accentVar(m.accent)}
                onClick={() => {
                  onScopeChange(m.id);
                  returnFocusToButton.current = true; // click-select is a selection close → return focus (acceptance #2)
                  setOpen(false);
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
// Moved VERBATIM from the prior Today shell.

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

// ── Left-rail nav item ─────────────────────────────────────────────────────

/**
 * A routable left-rail nav item (Today / Projects / Approvals). Route-derived active state;
 * Enter/Space + click both navigate (mirrors the scope switcher's div-as-interactive keyboard
 * pattern). Navigation is scope-preserving — it only selects the surface. An optional `badge`
 * renders a count pill (e.g. the pending-approvals count).
 */
function NavLink({
  surface,
  label,
  active,
  onNavigate,
  badge,
  children,
}: {
  readonly surface: Route["surface"];
  readonly label: string;
  readonly active: boolean;
  readonly onNavigate: (route: Route) => void;
  /** An optional count pill (e.g. the pending-approvals count); rendered only when > 0. */
  readonly badge?: number;
  readonly children: ReactNode;
}): ReactElement {
  const go = (): void => onNavigate({ surface });
  return (
    <div
      className={active ? "sow-nav-item sow-nav-item--sel" : "sow-nav-item"}
      role="link"
      aria-current={active ? "page" : undefined}
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      }}
    >
      {children}
      <span className="sow-nav-label">{label}</span>
      {badge !== undefined && badge > 0 ? (
        // Include the nav noun so the pill alone is meaningful to a screen reader ("4 pending approvals").
        <span className="sow-badge" aria-label={`${badge} pending ${label.toLowerCase()}`}>{badge}</span>
      ) : null}
    </div>
  );
}

// ── The shell ──────────────────────────────────────────────────────────────

export function AppShell(props: AppShellProps): ReactElement {
  const { connection, scope, onScopeChange, route, onNavigate, onAskCopilot, copilotWorkspaceScoped, pendingApprovalCount, ingestionCount, children } = props;

  // Copilot right-sidebar chrome state (§4.6): collapsed (thin rail) ⇄ expanded (chat panel).
  // Owned here like the scope switcher's local open state — orthogonal to BOTH route and scope
  // (the panel overlays the current surface on every screen; it never navigates or re-scopes).
  const [copilotOpen, setCopilotOpen] = useState(false);

  // Disclosure focus management (mirror of Copilot's focus-on-mount): when the user COLLAPSES the
  // panel, the panel unmounts and focus would drop to <body> — return it to the rail's Expand
  // chevron instead. Guarded by `returnFocusToRail` so the effect never focuses the chevron on
  // initial load (copilotOpen starts false with the flag unset).
  const railChevRef = useRef<HTMLButtonElement>(null);
  const returnFocusToRail = useRef(false);
  useEffect(() => {
    if (!copilotOpen && returnFocusToRail.current) {
      railChevRef.current?.focus();
      returnFocusToRail.current = false;
    }
  }, [copilotOpen]);
  const collapseCopilot = (): void => {
    returnFocusToRail.current = true;
    setCopilotOpen(false);
  };

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

          {/* Today — routable */}
          <NavLink surface="today" label="Today" active={route.surface === "today"} onNavigate={onNavigate}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
              <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
              <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
              <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
            </svg>
          </NavLink>

          {/* Calendar */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
              <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
            </svg>
            <span className="sow-nav-label">Calendar</span>
          </div>

          {/* Approvals — routable (§9.8), with a live pending-count badge */}
          <NavLink
            surface="approvals"
            label="Approvals"
            active={route.surface === "approvals"}
            onNavigate={onNavigate}
            badge={pendingApprovalCount}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M8.5 12l2.5 2.5 4.5-5" />
            </svg>
          </NavLink>

          {/* Inbox — routable (§9.7 ingestion triage), with a live active-scope count badge */}
          <NavLink
            surface="ingestion"
            label="Inbox"
            active={route.surface === "ingestion"}
            onNavigate={onNavigate}
            badge={ingestionCount}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 13.5L6 5.5a2 2 0 0 1 1.9-1.5h8.2A2 2 0 0 1 18 5.5l2.5 8" />
              <path d="M3.5 13.5V18a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-4.5" />
              <path d="M3.5 13.5h5l1.5 2.5h4l1.5-2.5h5" />
            </svg>
          </NavLink>

          {/* Knowledge */}
          <div className="sow-nav-item" role="link" tabIndex={0}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 4.5h11a2.5 2.5 0 0 1 2.5 2.5v12.5H7.5A2.5 2.5 0 0 1 5 19z" />
              <path d="M18.5 16H7.5A2.5 2.5 0 0 0 5 18.5" />
            </svg>
            <span className="sow-nav-label">Knowledge</span>
          </div>

          {/* Projects — routable */}
          <NavLink surface="projects" label="Projects" active={route.surface === "projects"} onNavigate={onNavigate}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.5l2 2.5H18a2.5 2.5 0 0 1 2.5 2.5v7A2.5 2.5 0 0 1 18 19.5H6a2.5 2.5 0 0 1-2.5-2.5z" />
            </svg>
          </NavLink>

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

        {/* ── Content pane — the active surface ─────────────────────────── */}
        {children}

        {/* ── Copilot right sidebar — collapsed (thin rail) ⇄ expanded (chat panel) ── */}
        {copilotOpen ? (
          <Copilot workspaceScoped={copilotWorkspaceScoped} onCollapse={collapseCopilot} onAsk={onAskCopilot} />
        ) : (
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
              ref={railChevRef}
              className="sow-rail-chev"
              type="button"
              aria-label="Expand Copilot sidebar"
              onClick={() => setCopilotOpen(true)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
          </aside>
        )}

      </div>
    </div>
  );
}

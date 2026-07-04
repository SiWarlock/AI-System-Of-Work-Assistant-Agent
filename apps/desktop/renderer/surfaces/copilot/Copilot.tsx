// Copilot — the persistent RIGHT SIDEBAR chat panel (§4.6; locked design: material-direction.md
// "Copilot = persistent right sidebar, collapsible to a thin rail, expandable to a full-screen
// conversation — NOT a separate nav page").
//
// This is the EXPANDED panel. AppShell owns the collapsed⇄expanded chrome state and renders this
// only when expanded (the 36px rail is the collapsed form). The panel is orthogonal to BOTH the
// route (which surface is mounted) and the scope (which workspace's data hydrates) — it overlays
// the current surface on every screen.
//
// Load-bearing (§4.6): Copilot READS ONLY. It never writes or sends. Any action becomes a PROPOSAL
// that routes to Approvals — surfaced by the persistent reminder. The live Q&A input is scaffolded
// but DISABLED until the backend (A) lands; the chat content is built out in B2.
//
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useEffect, useRef, type ReactElement } from "react";

export interface CopilotProps {
  /** Collapse the sidebar back to the thin rail (AppShell owns the open state). */
  readonly onCollapse: () => void;
}

export function Copilot(props: CopilotProps): ReactElement {
  const { onCollapse } = props;
  const collapseRef = useRef<HTMLButtonElement>(null);

  // Disclosure focus management: expanding is a subtree swap (the rail's Expand button unmounts),
  // so move keyboard focus INTO the panel rather than dropping it to <body>. This panel mounts
  // ONLY as a result of a user expand (AppShell renders it only when open, and Copilot starts
  // collapsed), so focusing on mount never steals focus on initial app load. The mirror half —
  // returning focus to the rail's Expand chevron on collapse — lives in AppShell (which owns the
  // rail). B2's chat input becomes the natural on-open focus target.
  useEffect(() => {
    collapseRef.current?.focus();
  }, []);

  return (
    <aside className="sow-copilot-panel" aria-label="Copilot">
      <header className="sow-copilot-head">
        <span className="sow-rail-spark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l1.8 5.4a4 4 0 0 0 2.8 2.8L22 12l-5.4 1.8a4 4 0 0 0-2.8 2.8L12 22l-1.8-5.4a4 4 0 0 0-2.8-2.8L2 12l5.4-1.8a4 4 0 0 0 2.8-2.8z" />
          </svg>
        </span>
        <span className="sow-copilot-title">Copilot</span>
        <button
          ref={collapseRef}
          className="sow-copilot-collapse"
          type="button"
          aria-label="Collapse Copilot sidebar"
          onClick={onCollapse}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </button>
      </header>

      {/* Chat content (transcript · citations · proposal row · suggestion chips · input) lands in B2. */}
      <div className="sow-copilot-body" />
    </aside>
  );
}

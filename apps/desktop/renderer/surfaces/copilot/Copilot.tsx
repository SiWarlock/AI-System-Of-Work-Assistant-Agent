// Copilot — the persistent RIGHT SIDEBAR chat panel (§4.6; locked design: material-direction.md
// "Copilot = persistent right sidebar with iMessage-style bubbles (user = filled blue, assistant
// = glass) + citation chips (mono) + proposal action row + suggestion chips + rounded input with
// a blue send circle. Collapsible to a thin rail, expandable — NOT a separate nav page").
//
// This is the EXPANDED panel. AppShell owns the collapsed⇄expanded chrome state and renders this
// only when expanded (the 36px rail is the collapsed form). The panel is orthogonal to BOTH the
// route (which surface is mounted) and the scope (which workspace's data hydrates) — it overlays
// the current surface on every screen.
//
// Load-bearing (§4.6): Copilot READS ONLY. It never writes or sends. Any action becomes a PROPOSAL
// that routes to Approvals — surfaced by the persistent reminder AND by each turn's proposal row.
// WS-8: Copilot reads a SINGLE workspace's knowledge; under Global there is no ask (a "pick a
// workspace" state, not a cross-workspace blend). The live Q&A input is scaffolded but DISABLED
// until the backend (A) lands + the turns are wired; the render here is empty-until-data (no seed).
//
// `CopilotTurnView` is a presentational view-model (not the wire contract) — A5 maps the validated
// `UiSafeCopilotAnswer`/citations into it, keeping this component free of the schema/registry.
//
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useEffect, useRef, type ReactElement } from "react";
import { resolveWorkspaceId, type WorkspaceScope } from "../../store/scope";

/** A single cited source, as shown in a citation chip. Opaque ref + display title — NO raw content. */
export interface CopilotCitationView {
  readonly id: string;
  readonly title: string;
}

/** One question→answer exchange rendered as iMessage-style bubbles. */
export interface CopilotTurnView {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly CopilotCitationView[];
  /** When the answer implies an action: the proposed action's label. It ROUTES TO APPROVALS — never a direct write. */
  readonly proposalLabel?: string;
}

export interface CopilotProps {
  /** The active workspace scope — Copilot reads a SINGLE workspace (WS-8). */
  readonly scope: WorkspaceScope;
  /** Collapse the sidebar back to the thin rail (AppShell owns the open state). */
  readonly onCollapse: () => void;
  /** The conversation so far. Empty-until-backend (A5 supplies real turns); no synthetic seed. */
  readonly turns?: readonly CopilotTurnView[];
}

// A couple of example prompts, shown (disabled) in the empty state to hint at what Copilot answers.
// Decorative until A5 wires the input; they light up with the composer.
const SUGGESTIONS: readonly string[] = [
  "What decisions did we log this week?",
  "What's blocking the vendor review?",
  "Summarize the latest meeting notes.",
];

/** A mono citation chip — the display title of a cited source. Carries no raw content / path / URL. */
function CitationChip({ title }: { readonly title: string }): ReactElement {
  return (
    <span className="sow-cite-chip" role="listitem">
      {title}
    </span>
  );
}

/** One conversation turn: the user's question (filled-blue bubble) + Copilot's answer (glass bubble)
 *  with its citation chips and, when the answer implies an action, a routes-to-Approvals row. */
function CopilotTurn({ turn }: { readonly turn: CopilotTurnView }): ReactElement {
  return (
    <div className="sow-copilot-turn">
      <div className="sow-copilot-bubble sow-copilot-bubble--user">{turn.question}</div>
      <div className="sow-copilot-bubble sow-copilot-bubble--assistant">
        <div className="sow-copilot-answer">{turn.answer}</div>
        {turn.citations.length > 0 ? (
          <div className="sow-copilot-cites" role="list" aria-label="Citations">
            {turn.citations.map((c) => (
              <CitationChip key={c.id} title={c.title} />
            ))}
          </div>
        ) : null}
        {turn.proposalLabel !== undefined ? (
          <div className="sow-copilot-proposal">
            <span className="sow-copilot-proposal-label">{turn.proposalLabel}</span>
            {/* Read-only: an action never writes here — it becomes a proposal in Approvals. The
                Approvals surface + navigation land with that page; the affordance is honest-disabled. */}
            <button
              className="sow-copilot-proposal-go"
              type="button"
              disabled
              title="This becomes a proposal in the Approvals queue — Copilot never writes or sends directly"
            >
              Review in Approvals
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The disabled composer scaffold — the rounded input + blue send circle. Enabled at A5. */
function Composer(): ReactElement {
  return (
    <form className="sow-copilot-composer" onSubmit={(e) => e.preventDefault()}>
      <textarea
        className="sow-copilot-input"
        aria-label="Ask Copilot"
        placeholder="Answering is coming up next…"
        rows={1}
        disabled
      />
      <button className="sow-copilot-send" type="submit" aria-label="Send" disabled>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h13M12 6l6 6-6 6" />
        </svg>
      </button>
    </form>
  );
}

export function Copilot(props: CopilotProps): ReactElement {
  const { scope, onCollapse, turns = [] } = props;
  const collapseRef = useRef<HTMLButtonElement>(null);

  // Disclosure focus management: expanding is a subtree swap (the rail's Expand button unmounts),
  // so move keyboard focus INTO the panel rather than dropping it to <body>. This panel mounts
  // ONLY as a result of a user expand (AppShell renders it only when open, and Copilot starts
  // collapsed), so focusing on mount never steals focus on initial app load. The mirror half —
  // returning focus to the rail's Expand chevron on collapse — lives in AppShell (which owns the
  // rail). When A5 enables the input, it becomes the natural on-open focus target.
  useEffect(() => {
    collapseRef.current?.focus();
  }, []);

  // WS-8: Copilot reads a SINGLE workspace's knowledge. `resolveWorkspaceId` fails CLOSED for the
  // ASK direction — it returns a real id ONLY for one of the three recognized workspaces; Global
  // AND any unknown/out-of-union scope resolve to `null` → the pick-a-workspace state, never a
  // cross-workspace blend or a query against an unrecognized scope. (NOT `isWorkspaceScope`, which
  // returns `true` for an unknown value — the wrong direction for gating a read.) A5 reuses this
  // id to scope the actual `query.copilotAsk`.
  const workspaceId = resolveWorkspaceId(scope);
  const workspaceScoped = workspaceId !== null;

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

      {/* Persistent read-only reminder — present in EVERY state (§4.6). */}
      <div className="sow-copilot-note" role="note">
        Copilot reads only — it never writes or sends. Any action becomes a proposal that routes to Approvals.
      </div>

      <div className="sow-copilot-body">
        {!workspaceScoped ? (
          // WS-8: no cross-workspace ask. Pick a single workspace to query its knowledge.
          <div className="sow-copilot-empty" role="status">
            Copilot reads a single workspace&apos;s knowledge — pick a workspace to ask.
          </div>
        ) : turns.length === 0 ? (
          // Empty-until-data (no synthetic seed) — the ask-a-question state + example prompts.
          <div className="sow-copilot-empty" role="status">
            <p className="sow-copilot-empty-lead">Ask a question about this workspace&apos;s knowledge. Every answer cites its sources.</p>
            <div className="sow-copilot-suggest" role="group" aria-label="Example questions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="sow-copilot-chip"
                  type="button"
                  disabled
                  title="Answering is coming up next"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="sow-copilot-transcript" role="log" aria-label="Conversation">
            {turns.map((turn) => (
              <CopilotTurn key={turn.id} turn={turn} />
            ))}
          </div>
        )}
      </div>

      {/* Composer — only where an ask is possible (a single workspace). Scaffolded/disabled until A. */}
      {workspaceScoped ? <Composer /> : null}
    </aside>
  );
}

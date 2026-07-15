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
// workspace" state, not a cross-workspace blend). When `onAsk` is provided (A5, wired to
// query.copilotAsk) the composer is LIVE; without it the input is a disabled scaffold. A failed ask
// (WS-8 fail-closed / candidate-data gate rejection / transport) folds to a safe error turn — never
// a partial or raw answer (the worker already gated it; `AskResult` carries only {ok:false}).
//
// `CopilotTurnView` is a presentational view-model (not the wire contract) — A5 maps the validated
// `UiSafeCopilotAnswer`/citations into it, keeping this component free of the schema/registry.
//
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useEffect, useRef, useState, type ReactElement } from "react";
import type { AskResult } from "../../lib/copilot-ask";

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
  /**
   * The Employer-Work egress NOTICE (safety rule 5): the cloud processor label this answer's raw
   * Employer-Work content was synthesized by (egress acknowledged ON). PRESENT only for employer-work
   * cloud egress — server-derived, never for a local/zero-egress answer. Its presence shows the banner.
   */
  readonly egressProcessor?: string;
}

export interface CopilotProps {
  /**
   * WS-8 gate: true iff the active scope resolves to a SINGLE onboarded workspace (§19.1 / 14.1) —
   * Copilot reads ONE workspace's knowledge. False (Global / a non-onboarded bucket / an unknown
   * scope) → the pick-a-workspace state. Computed by App from the onboarded store slice + threaded
   * through AppShell (the renderer's fail-closed resolve; the worker re-derives its own scoping).
   */
  readonly workspaceScoped: boolean;
  /** Collapse the sidebar back to the thin rail (AppShell owns the open state). */
  readonly onCollapse: () => void;
  /**
   * MOUNT-TIME seed conversation (tests; a future restore). INIT-ONLY — it seeds the internal turn
   * state once; live asks append. A post-mount change to this prop is NOT reconciled (to reset the
   * conversation from a new source, remount via `key`). The live app never passes it (no synthetic seed).
   */
  readonly turns?: readonly CopilotTurnView[];
  /** Ask a question (A5, wired to query.copilotAsk). Present → the composer is LIVE; absent → disabled scaffold. */
  readonly onAsk?: (question: string) => Promise<AskResult>;
}

// Example prompts shown in the empty state. Clickable (prefill the draft) when the composer is live;
// a decorative disabled hint otherwise.
const SUGGESTIONS: readonly string[] = [
  "What decisions did we log this week?",
  "What's blocking the vendor review?",
  "Summarize the latest meeting notes.",
];

const ASK_FAILED = "Sorry — I couldn't answer that right now. Please try again.";

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
        {turn.egressProcessor !== undefined ? (
          // Safety rule 5: raw Employer-Work content was synthesized by a CLOUD model (egress
          // acknowledged). A visible consent notice — not fail-closed, per the owner's posture.
          <div className="sow-copilot-egress-notice" role="note" aria-label="Cloud egress notice">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.98 6 6 0 0 0-11.64-1.6A4 4 0 0 0 6.5 19h11z" />
            </svg>
            <span>
              Answered using <strong>{turn.egressProcessor}</strong> — a cloud model — on Employer-Work content.
            </span>
          </div>
        ) : null}
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

/** The composer — the rounded input + blue send circle. Enabled when the panel is live (A5). */
function Composer({
  value,
  onChange,
  onSubmit,
  disabled,
  pending,
  inputRef,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly onSubmit: () => void;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly inputRef: React.RefObject<HTMLTextAreaElement>;
}): ReactElement {
  return (
    <form
      className="sow-copilot-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        ref={inputRef}
        className="sow-copilot-input"
        aria-label="Ask Copilot"
        placeholder={disabled ? "Answering is coming up next…" : "Ask about this workspace…"}
        rows={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter submits; Shift+Enter inserts a newline (standard chat affordance).
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
      />
      <button className="sow-copilot-send" type="submit" aria-label="Send" disabled={disabled || pending}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 12h13M12 6l6 6-6 6" />
        </svg>
      </button>
    </form>
  );
}

export function Copilot(props: CopilotProps): ReactElement {
  const { workspaceScoped, onCollapse, turns: seedTurns = [], onAsk } = props;
  const live = onAsk !== undefined;

  const [turns, setTurns] = useState<readonly CopilotTurnView[]>(seedTurns);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const turnSeq = useRef(0);

  const collapseRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Disclosure focus management: expanding is a subtree swap (the rail's Expand button unmounts), so
  // move keyboard focus INTO the panel rather than dropping it to <body>. The panel mounts ONLY on a
  // user expand (AppShell renders it only when open, Copilot starts collapsed), so focusing on mount
  // never steals focus on initial app load. When live, the ASK INPUT is the natural on-open target;
  // otherwise the Collapse control. The mirror half (return focus to the rail on collapse) is AppShell's.
  useEffect(() => {
    if (live && inputRef.current !== null) inputRef.current.focus();
    else collapseRef.current?.focus();
  }, [live]);

  // WS-8: Copilot reads a SINGLE workspace's knowledge. `workspaceScoped` (a prop, computed by App
  // from the onboarded store slice via the fail-closed `resolveOnboardedWorkspaceId`) is true ONLY
  // for one onboarded workspace; Global, a NON-onboarded bucket, AND any unknown scope → false →
  // the pick-a-workspace state, never a cross-workspace blend. (The worker re-derives its own
  // workspace scoping; this only gates the UI affordance.)

  const submit = (): void => {
    const q = draft.trim();
    if (q === "" || onAsk === undefined || pending) return;
    setDraft("");
    setPending(true);
    // `finish` ALWAYS resets `pending` and appends exactly one turn — for a resolve, a rejection, OR
    // a contract-violating ok-payload (defensive: the worker gates the answer, but if a malformed
    // `{ok:true}` ever reached here, building the turn would throw and leave the composer stuck
    // disabled). A failed/malformed ask folds to a safe, generic error turn — NEVER a partial/raw
    // answer. Live-turn ids use a distinct `ask-` prefix so they can't collide with a seed turn's id.
    const finish = (result: AskResult): void => {
      turnSeq.current += 1;
      const id = `ask-${String(turnSeq.current)}`;
      let turn: CopilotTurnView;
      try {
        turn = result.ok
          ? {
              id,
              question: q,
              answer: result.answer.answer.join("\n"),
              citations: result.answer.citations.map((c) => ({ id: c.citationId, title: c.title })),
              // Thread the server-derived Employer-Work egress notice (present only for cloud egress).
              egressProcessor: result.answer.egressProcessor,
            }
          : { id, question: q, answer: ASK_FAILED, citations: [] };
      } catch {
        turn = { id, question: q, answer: ASK_FAILED, citations: [] };
      }
      setTurns((prev) => [...prev, turn]);
      setPending(false);
    };
    // createAskCopilot never rejects (it folds to {ok:false}), but guard the rejection path anyway.
    void onAsk(q).then(finish, () => finish({ ok: false }));
  };

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
        ) : turns.length === 0 && !pending ? (
          // Empty-until-data — the ask-a-question state + example prompts.
          <div className="sow-copilot-empty" role="status">
            <p className="sow-copilot-empty-lead">Ask a question about this workspace&apos;s knowledge. Every answer cites its sources.</p>
            <div className="sow-copilot-suggest" role="group" aria-label="Example questions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="sow-copilot-chip"
                  type="button"
                  disabled={!live}
                  title={live ? "Use this question" : "Answering is coming up next"}
                  onClick={live ? () => setDraft(s) : undefined}
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
            {pending ? (
              <div className="sow-copilot-thinking" role="status" aria-live="polite">
                Thinking…
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Composer — only where an ask is possible (a single workspace). Live when `onAsk` is provided. */}
      {workspaceScoped ? (
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          disabled={!live}
          pending={pending}
          inputRef={inputRef}
        />
      ) : null}
    </aside>
  );
}

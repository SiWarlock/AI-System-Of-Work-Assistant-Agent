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
// `CopilotTurnView` EMBEDS the validated `UiSafeCopilotAnswer` verbatim (9.28) rather than flattening
// it into loose fields: the field-by-field re-map that used to live in `finish` was the vector by which
// a rule-5 egress disclosure could be silently dropped. Every turn entering state is admitted through
// `admitReply` (both doors — live asks AND the seed prop), so the render path can assume a valid reply.
//
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useEffect, useRef, useState, type ReactElement } from "react";
import { UiSafeCopilotAnswerSchema, type UiSafeCopilotAnswer } from "@sow/contracts/api/ui-safe";
import type { AskResult } from "../../lib/copilot-ask";

/**
 * One question→answer exchange rendered as iMessage-style bubbles.
 *
 * ⚠ 9.28 — `reply` holds the VALIDATED `UiSafeCopilotAnswer` VERBATIM, deliberately NOT flattened
 * into loose fields. The old shape re-mapped the answer field-by-field (`answer`, `citations`, and
 * — easily forgotten — `egressProcessor`), and that re-map was the drop vector for a rule-5 egress
 * disclosure. `reply: result.answer` has nothing to forget, so the PATH OF LEAST RESISTANCE now
 * carries the disclosure. The renderer twin of 9.27 (the producer's optional trailing positional).
 *
 * ⚠ HONEST BOUND — the vector is BIASED AGAINST, not eliminated, and the difference matters:
 * `egressProcessor` is optional on the contract, so a hand-built partial literal still compiles —
 *     reply: { answer: r.answer.answer, citations: r.answer.citations }   // ← disclosure dropped
 * with no missing-property and no excess-property error. That is the same omission one level up.
 * What changed is that it now requires WRITING a literal rather than merely forgetting a line in a
 * mapping everyone already writes. Closing it fully needs a branded reply mintable only from a
 * validated wire payload (Step-9 Future TODO) — until then, do not read this as impossible.
 */
export interface CopilotTurnView {
  readonly id: string;
  readonly question: string;
  /** The validated answer, verbatim — body, citations, and the egress disclosure travel together. */
  readonly reply: UiSafeCopilotAnswer;
  /** When the answer implies an action: the proposed action's label. It ROUTES TO APPROVALS — never a direct write. */
  readonly proposalLabel?: string;
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
/** The failure turn's reply — a valid `UiSafeCopilotAnswer` shape carrying only the safe message. */
const FAILED_REPLY: UiSafeCopilotAnswer = { answer: [ASK_FAILED], citations: [] };

/**
 * The ADMISSION gate for a reply entering turn state — every door goes through it (live asks in
 * `finish`, AND the `turns` seed prop at mount). A candidate that fails the contract schema degrades
 * to {@link FAILED_REPLY} rather than being stored.
 *
 * ⚠ Why this is a real check and not ceremony after 9.26's re-gate: deleting the old field-by-field
 * re-map also deleted the THROW that used to land a contract-violating payload on the failure turn.
 * With the answer now carried verbatim, a malformed reply would instead throw inside
 * `CopilotAnswerView` during RENDER. There is NO ErrorBoundary anywhere in apps/desktop (verified),
 * so React 18 unmounts the ENTIRE ROOT — not just the panel — instead of showing ASK_FAILED. And
 * `createAskCopilot` is NOT the only door: the seed prop reaches `useState` directly, so a
 * `finish`-only guard would not see it (nor would a shallow `Array.isArray` pair, which admits
 * `citations: [null]` and throws on `c.citationId` at render). Validating with the SAME contract
 * schema at every entry point is the shape-validate-at-the-boundary posture, once per turn rather
 * than once per render.
 */
function admitReply(candidate: unknown): UiSafeCopilotAnswer {
  const parsed = UiSafeCopilotAnswerSchema.safeParse(candidate);
  return parsed.success ? parsed.data : FAILED_REPLY;
}

/** A mono citation chip — the display title of a cited source. Carries no raw content / path / URL. */
function CitationChip({ title }: { readonly title: string }): ReactElement {
  return (
    <span className="sow-cite-chip" role="listitem">
      {title}
    </span>
  );
}

/**
 * ⚠ 9.28 — the SHARED answer view: the one place a `UiSafeCopilotAnswer` becomes DOM. It takes the
 * whole validated object, so the body, its citations, and its egress disclosure render together and
 * cannot be separated by a consumer that only remembered two of the three.
 *
 * This is what a FUTURE `copilotBriefing` / `copilotConcept` surface renders through — both already
 * return notice-bearing answers and have no consumer today, which is the 9.28 gap. Rendering through
 * this view inherits the rule-5 disclosure by construction rather than by remembering.
 */
export function CopilotAnswerView({ reply }: { readonly reply: UiSafeCopilotAnswer }): ReactElement {
  return (
    <>
      <div className="sow-copilot-answer">{reply.answer.join("\n")}</div>
      {reply.egressProcessor !== undefined ? (
        // Safety rule 5: raw Employer-Work content was synthesized by a CLOUD model (egress
        // acknowledged). A visible consent notice — not fail-closed, per the owner's posture.
        <div className="sow-copilot-egress-notice" role="note" aria-label="Cloud egress notice">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.98 6 6 0 0 0-11.64-1.6A4 4 0 0 0 6.5 19h11z" />
          </svg>
          <span>
            Answered using <strong>{reply.egressProcessor}</strong> — a cloud model — on Employer-Work content.
          </span>
        </div>
      ) : null}
      {reply.citations.length > 0 ? (
        <div className="sow-copilot-cites" role="list" aria-label="Citations">
          {reply.citations.map((c) => (
            <CitationChip key={c.citationId} title={c.title} />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** One conversation turn: the user's question (filled-blue bubble) + Copilot's answer (glass bubble),
 *  the latter rendered ENTIRELY through {@link CopilotAnswerView} so the egress disclosure cannot be
 *  separated from the answer it belongs to (9.28). The proposal row is turn-level, not part of the
 *  answer contract, so it stays here. */
function CopilotTurn({ turn }: { readonly turn: CopilotTurnView }): ReactElement {
  return (
    <div className="sow-copilot-turn">
      <div className="sow-copilot-bubble sow-copilot-bubble--user">{turn.question}</div>
      <div className="sow-copilot-bubble sow-copilot-bubble--assistant">
        <CopilotAnswerView reply={turn.reply} />
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

  // DOOR 2 into turn state: the seed prop reaches state WITHOUT passing through `finish`, so it is
  // admitted here. Init-only (the seed is not reconciled post-mount), so this runs once.
  const [turns, setTurns] = useState<readonly CopilotTurnView[]>(() =>
    seedTurns.map((t) => ({ ...t, reply: admitReply(t.reply) })),
  );
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
        // 9.28 — the validated answer is carried VERBATIM: no field-by-field re-map, so there is no
        // mapping in which a rule-5 egress disclosure can be forgotten. `admitReply` is DOOR 1 of 2
        // (the seed prop is door 2, at mount) — see its docblock for why it is not redundant.
        turn = result.ok
          ? { id, question: q, reply: admitReply(result.answer) }
          : { id, question: q, reply: FAILED_REPLY };
      } catch {
        turn = { id, question: q, reply: FAILED_REPLY };
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

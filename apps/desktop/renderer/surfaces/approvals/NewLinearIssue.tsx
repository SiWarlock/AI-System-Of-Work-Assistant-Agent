// Linear slice 5a, part 4 — the "New Linear issue" form on the Approvals page (owner decisions 2026-09-25).
//
// It proposes ONE Linear issue in the ACTIVE workspace (the App adds that workspace; this form never names one). The
// result is a PENDING card the owner must still approve — nothing reaches Linear from here. The team list comes from
// Linear only while Linear writes are on for the workspace; while off, the form says so and cannot submit.
//
// ⛔ REQ-F-017: no owner, no date — the form has no such field, and the worker refuses a submission that carries one.
// ⛔ Rule 3: ONE draft id is minted when the form first opens and kept until a proposal lands (or is refused as a
// conflict), so a retry after a failure is the SAME proposal and can never become a second issue.
// ⚠ WS-8: the parent re-keys this component by the active workspace, so a scope switch drops its teams and draft.
import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { UiSafeLinearTeamList } from "@sow/contracts/api/ui-safe";
import type { LinearIssueDraft, LinearTeamsResult, ProposeLinearIssueResult } from "../../lib/linear-issue";

/** The same bounds the worker enforces (apps/worker/src/api/procedures/linearIssue.ts). */
export const MAX_TITLE = 255;
export const MAX_DESCRIPTION = 8000;

const FORM_ID = "sow-new-linear-issue";
const PRIORITIES: readonly (readonly [number, string])[] = [
  [0, "No priority"],
  [1, "Urgent"],
  [2, "High"],
  [3, "Medium"],
  [4, "Low"],
];
const DONE_CREATED = "Proposed. Approve it below to send it to Linear.";
const DONE_ALREADY = "Already proposed. Approve it below to send it to Linear.";
/** When the worker could not return the new card, nothing is "below" yet: say where it will show instead. */
const DONE_NO_CARD = "Proposed. It will show in your approvals after a refresh.";
const FAILED = "Couldn't create the proposal — try again";

/**
 * A UUID v4 for the draft. `crypto.randomUUID` where present; otherwise the same bits from `getRandomValues`.
 * ⚠ Why a RANDOM id, when desktop L6 says a command mints a DETERMINISTIC key: L6's goal is "a replay or a double click
 * is one effect", and it derives the key from stable inputs because a re-entered command HAS them. A new issue has
 * none — two real issues may share a title — so the draft id is minted ONCE per draft and kept for every retry, which
 * gives L6's guarantee. A fresh id per CLICK would break it; this is not that.
 */
function newDraftId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Teams = { readonly kind: "loading" } | { readonly kind: "failed" } | { readonly kind: "loaded"; readonly list: UiSafeLinearTeamList };

export interface NewLinearIssueProps {
  /** Load the ACTIVE workspace's Linear teams. */
  readonly onLoadTeams: () => Promise<LinearTeamsResult>;
  /** Propose one issue in the active workspace; the App folds the returned card into the inbox. */
  readonly onPropose: (draft: LinearIssueDraft) => Promise<ProposeLinearIssueResult>;
  /**
   * The ids of the cards still pending. A proposal that returned its card says "approve it below" only while that card
   * is one of them; one that did not (the worker could not read it back) never says "below" at all.
   */
  readonly pendingIds: readonly string[];
}

export function NewLinearIssue({ onLoadTeams, onPropose, pendingIds }: NewLinearIssueProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [teams, setTeams] = useState<Teams>({ kind: "loading" });
  const [teamId, setTeamId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<{ readonly text: string; readonly cardId?: string } | undefined>(undefined);
  const draft = useRef<string | undefined>(undefined);
  const inFlight = useRef(false);
  const loadSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true; // in the BODY: StrictMode mounts, cleans up and mounts again (step-5 review)
    return () => {
      alive.current = false;
    };
  }, []);

  const load = (): void => {
    const seq = ++loadSeq.current;
    setTeams({ kind: "loading" });
    void onLoadTeams().then((r) => {
      if (!alive.current || seq !== loadSeq.current) return;
      if (!r.ok || r.list.status === "unavailable") {
        setTeams({ kind: "failed" });
        return;
      }
      setTeams({ kind: "loaded", list: r.list });
      const first = r.list.teams[0];
      setTeamId((current) => (r.list.teams.some((t) => t.id === current) ? current : (first?.id ?? "")));
    });
  };

  const toggle = (): void => {
    if (open) {
      loadSeq.current++; // a list still loading for the closed form is dropped
      setOpen(false);
      return;
    }
    if (draft.current === undefined) draft.current = newDraftId();
    setMessage(undefined);
    setDone(undefined);
    setOpen(true);
    load();
  };

  const ready = teams.kind === "loaded" && teams.list.status === "ready" && teams.list.teams.length > 0;
  const canSubmit =
    ready && !submitting && teamId !== "" && title.trim().length > 0 && title.length <= MAX_TITLE && description.length <= MAX_DESCRIPTION;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const draftId = draft.current;
    if (!canSubmit || inFlight.current || draftId === undefined) return;
    inFlight.current = true;
    setSubmitting(true);
    setMessage(undefined);
    void onPropose({ draftId, teamId, title, description, priority }).then((r) => {
      inFlight.current = false;
      if (!alive.current) return;
      setSubmitting(false);
      if (!r.ok) {
        setMessage(FAILED); // the SAME draft is kept: a retry is the same proposal
        return;
      }
      switch (r.result.outcome) {
        case "created":
        case "already_pending":
          draft.current = undefined; // spent: the next issue is a new draft
          setTitle("");
          setDescription("");
          setPriority(0);
          setOpen(false);
          setDone(
            r.result.approval !== undefined
              ? { text: r.result.outcome === "created" ? DONE_CREATED : DONE_ALREADY, cardId: r.result.approval.id }
              : { text: DONE_NO_CARD },
          );
          return;
        case "conflict":
          // The draft was already sent and what was saved differs — the content, or (rarely) the team's NAME, renamed
          // in Linear between a lost answer and this retry. Both are real; so is the risk of a second card for the same
          // issue, which is why the message says to look first (critic, 2026-09-25; recorded as a known limit).
          draft.current = newDraftId();
          setMessage(
            "This form was already sent, and what was saved no longer matches it (its content, or the team's name in Linear, changed). Submitting again proposes a NEW issue — check your approvals first.",
          );
          return;
        case "already_decided":
          draft.current = newDraftId(); // spent: its card was decided; the next submit is a new issue
          setMessage("This form was already proposed, and that card has been decided. Submit again to propose a new issue.");
          return;
        case "invalid_input":
          setMessage("Check the title and description, then try again.");
          return;
        case "writes_off":
          setMessage("Linear writes are off for this workspace. Nothing was proposed.");
          return;
        case "unknown_team":
          setMessage("That team is no longer in Linear. The teams have been reloaded — pick one again.");
          load();
          return;
        default:
          setMessage(FAILED);
      }
    });
  };

  return (
    <div className="sow-newissue">
      <div className="sow-newissue-bar">
        <button type="button" className="sow-approval-btn" aria-expanded={open} aria-controls={FORM_ID} onClick={toggle}>
          New Linear issue
        </button>
        {/* A card-bearing confirmation shows only while that card is still pending; one without a card never says "below". */}
        {done !== undefined && (done.cardId === undefined || pendingIds.includes(done.cardId)) ? (
          <span className="sow-newissue-done" role="status">
            {done.text}
          </span>
        ) : null}
      </div>
      {open ? (
        <form id={FORM_ID} className="sow-newissue-form" aria-label="New Linear issue" onSubmit={submit}>
          {teams.kind === "loading" ? (
            <div className="sow-field-hint">Loading the teams…</div>
          ) : teams.kind === "failed" ? (
            <div className="sow-newissue-note" role="alert">
              <span>Couldn't load the teams from Linear</span>{" "}
              <button type="button" className="sow-approval-btn" onClick={load}>
                Retry
              </button>
            </div>
          ) : teams.list.status === "writes_off" ? (
            <div className="sow-newissue-note" role="status">
              Linear writes are off for this workspace. Turn them on to pick a team and propose an issue.
            </div>
          ) : teams.list.teams.length === 0 ? (
            <div className="sow-newissue-note" role="status">
              No teams were found in this workspace's Linear.
            </div>
          ) : (
            <div className="sow-field">
              <label className="sow-field-label" htmlFor={`${FORM_ID}-team`}>
                Team
              </label>
              <select id={`${FORM_ID}-team`} className="sow-input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                {teams.list.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {teams.list.truncated ? <span className="sow-field-hint">Showing the first 100 teams</span> : null}
            </div>
          )}
          <div className="sow-field">
            <label className="sow-field-label" htmlFor={`${FORM_ID}-title`}>
              Title
            </label>
            <input
              id={`${FORM_ID}-title`}
              className="sow-input"
              type="text"
              maxLength={MAX_TITLE}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="sow-field">
            <label className="sow-field-label" htmlFor={`${FORM_ID}-description`}>
              Description
            </label>
            <textarea
              id={`${FORM_ID}-description`}
              className="sow-input sow-newissue-description"
              maxLength={MAX_DESCRIPTION}
              rows={5}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="sow-field">
            <label className="sow-field-label" htmlFor={`${FORM_ID}-priority`}>
              Priority
            </label>
            <select
              id={`${FORM_ID}-priority`}
              className="sow-input sow-newissue-priority"
              value={String(priority)}
              onChange={(e) => setPriority(Number(e.target.value))}
            >
              {PRIORITIES.map(([value, label]) => (
                <option key={value} value={String(value)}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {message !== undefined ? (
            <div className="sow-newissue-message" role="alert">
              {message}
            </div>
          ) : null}
          <div className="sow-newissue-actions">
            <button type="submit" className="sow-approval-btn sow-approval-btn--approve" disabled={!canSubmit}>
              Propose issue
            </button>
            <span className="sow-field-hint">It becomes a pending card. Nothing goes to Linear until you approve it.</span>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// Copilot — the persistent RIGHT SIDEBAR chat panel (§4.6; locked design: material-direction.md
// "Copilot = persistent right sidebar with iMessage-style bubbles (user = filled blue, assistant
// = glass) + citation chips (mono) + proposal action row + suggestion chips + rounded input with
// a blue send circle. Collapsible to a thin rail, expandable — NOT a separate nav page").
//
// This is the EXPANDED panel. AppShell owns the collapsed⇄expanded chrome state and renders this
// only when expanded (the 36px rail is the collapsed form). The panel overlays the current surface on
// every screen (orthogonal to the route); its CONTENT follows the scope — it shows the active
// workspace's current chat only (Linear slice 5b.4d, below).
//
// Load-bearing (§4.6): Copilot READS ONLY. It never changes the owner's notes or sends anything (its one local
// write is the saved chat, 5b.4). Any action becomes a PROPOSAL
// that routes to Approvals — surfaced by the persistent reminder. (9.40: the per-turn proposal-row
// affordance was deleted — `UiSafeCopilotAnswer` cannot carry an approval id for any producer that
// could exist — and the goal is re-tracked as a separate task rather than implemented here.)
// WS-8: Copilot reads a SINGLE workspace's knowledge; under Global there is no ask (a "pick a
// workspace" state, not a cross-workspace blend). When `onAsk` is provided (A5, wired to
// query.copilotAsk) the composer is LIVE; without it the input is a disabled scaffold. A failed ask
// (WS-8 fail-closed / candidate-data gate rejection / transport) folds to a safe error turn — never
// a partial or raw answer (the worker already gated it; `AskResult` carries only {ok:false}).
//
// `CopilotTurnView` EMBEDS the validated `UiSafeCopilotAnswer` verbatim (9.28) rather than flattening
// it into loose fields: the field-by-field re-map that used to live in `finish` was the vector by which
// a rule-5 egress disclosure could be silently dropped. Every turn entering state is admitted through
// `admitReply`, so the render path can assume a valid reply.
//
// 9.34 — `reply` is further BRANDED (`AdmittedCopilotAnswer`): mintable only via `admitReply`, so a
// hand-built literal no longer satisfies `CopilotTurnView.reply` or `CopilotAnswerView`'s prop at all
// (a type error, not a silent compile). See the brand's doc comment below for what this does and does
// not close.
//
// Linear slice 5b.4d — SAVED CHATS (owner decisions 2026-09-25: saved in the local store, a list of chats per
// workspace). App keeps one chat id per workspace and a `ChatSessionStore` of chat sessions keyed by (workspace, chat),
// for the whole app session; the panel renders the ACTIVE (workspace, chat)'s session straight from that store.
// ⛔ Rule 4: nothing per-view is reset after a switch (review of 5b.4d: a reset in an effect left one frame of the old
// workspace's chat under the new scope) — the render itself reads only the active workspace's session, draft and chat
// list. An answer goes into ITS chat's session, so it survives a collapse or a switch and back, and never shows
// elsewhere. ⛔ Task 9.25: a restored turn is re-admitted through `admitReply` and rendered by `CopilotAnswerView`, like
// a live one, so its egress notice renders (the worker already refused a saved answer whose explicit disclosure is
// missing or disagrees).
//
// NEVER import electron, node, or @sow/worker from a renderer file.

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { UiSafeCopilotAnswerSchema, type UiSafeCopilotAnswer, type UiSafeCopilotChatSummary } from "@sow/contracts/api/ui-safe";
import type { AskResult } from "../../lib/copilot-ask";
import type { CopilotChatListResult, CopilotChatResult, DeleteCopilotChatResult } from "../../lib/copilot-chats";

declare const ADMITTED_REPLY_BRAND: unique symbol;

/**
 * A `UiSafeCopilotAnswer` that has passed through {@link admitReply} — the ONLY function that can
 * produce one. The brand is a compile-time-only marker with no runtime representation (nothing is
 * actually added to the object; `admitReply` returns the parsed value cast to this type), so a
 * hand-built object literal — even one satisfying every `UiSafeCopilotAnswer` field, including
 * `egressProcessor` — can never satisfy it: TypeScript requires the `[ADMITTED_REPLY_BRAND]`
 * property, which no literal has and none can accidentally acquire. 9.34: closes the residual 9.28
 * left open (a hand-built partial literal at `reply:` used to compile silently).
 */
export type AdmittedCopilotAnswer = UiSafeCopilotAnswer & { readonly [ADMITTED_REPLY_BRAND]: true };

/**
 * One question→answer exchange rendered as iMessage-style bubbles.
 *
 * ⚠ 9.28 — `reply` holds the VALIDATED `UiSafeCopilotAnswer` VERBATIM, deliberately NOT flattened
 * into loose fields. The old shape re-mapped the answer field-by-field (`answer`, `citations`, and
 * — easily forgotten — `egressProcessor`), and that re-map was the drop vector for a rule-5 egress
 * disclosure. `reply: result.answer` has nothing to forget, so the PATH OF LEAST RESISTANCE now
 * carries the disclosure. The renderer twin of 9.27 (the producer's optional trailing positional).
 *
 * ⚠ HONEST BOUND (9.28) — the vector was BIASED AGAINST, not eliminated: `egressProcessor` is
 * optional on the contract, so a hand-built partial literal still compiled —
 *     reply: { answer: r.answer.answer, citations: r.answer.citations }   // ← disclosure dropped
 * with no missing-property and no excess-property error. That was the same omission one level up.
 *
 * ✅ 9.34 — CLOSED: `reply` is {@link AdmittedCopilotAnswer}, a branded type mintable ONLY via
 * {@link admitReply}. The literal above no longer type-checks here — a hand-built object is missing
 * the brand, so writing it is a compile error, not a silent omission that ships. The residual left
 * is narrower and honest: a deliberate `... as AdmittedCopilotAnswer` cast still bypasses the brand,
 * but that is a visible, intentional act — not the path of least resistance a plain literal was.
 */
export interface CopilotTurnView {
  readonly id: string;
  readonly question: string;
  /** The ADMITTED answer — body, citations, and the egress disclosure travel together, and this
   *  field is uninhabitable except via {@link admitReply} (9.34). */
  readonly reply: AdmittedCopilotAnswer;
}

/**
 * Linear slice 5b.4d — the saved-chat controls App gives the panel. Every call is made by App with the ACTIVE
 * workspace's id (WS-8); the panel never names a workspace itself.
 */
export interface CopilotChatControls {
  /** The chat the panel shows and asks into — App keeps one per workspace and mints a new one for "New chat". */
  readonly chatId: string;
  /** Restore a saved chat (`notFound` for a chat not saved yet — it opens empty). */
  readonly onLoadChat: (chatId: string) => Promise<CopilotChatResult>;
  /** The active workspace's saved chats, most recently used first. */
  readonly onListChats: () => Promise<CopilotChatListResult>;
  /** Open a saved chat — App makes it the workspace's current chat. */
  readonly onOpenChat: (chatId: string) => void;
  /** Start a new chat — App mints a new id for the workspace. */
  readonly onNewChat: () => void;
  /** Delete a saved chat and all its turns. */
  readonly onDeleteChat: (chatId: string) => Promise<DeleteCopilotChatResult>;
  /** The chat sessions App keeps for the app session (see {@link ChatSessionStore}). */
  readonly sessions: ChatSessionStore;
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
  /** Ask a question (A5, wired to query.copilotAsk). Present → the composer is LIVE; absent → disabled scaffold. */
  readonly onAsk?: (question: string) => Promise<AskResult>;
  /**
   * Linear slice 5b.4d — the ACTIVE workspace's id (null under Global). ⛔ Rule 4: a change clears the transcript and
   * the draft, so nothing typed or answered in one workspace is shown or sent under another.
   */
  readonly workspaceKey?: string | null;
  /** Linear slice 5b.4d — the saved-chat controls. Absent ⇒ no chat list and no restore (an unsaved transcript). */
  readonly chats?: CopilotChatControls;
}

/** The chat list's state. */
type ChatList =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "loaded"; readonly chats: readonly UiSafeCopilotChatSummary[] };

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
 * The ADMISSION gate for a reply entering turn state — the live-ask path in `finish` goes through
 * it. A candidate that fails the contract schema degrades to {@link FAILED_REPLY} rather than being
 * stored.
 *
 * ⚠ Why this is a real check and not ceremony after 9.26's re-gate: deleting the old field-by-field
 * re-map also deleted the THROW that used to land a contract-violating payload on the failure turn.
 * With the answer now carried verbatim, a malformed reply would instead throw inside
 * `CopilotAnswerView` during RENDER. A render-time `ErrorBoundary` now exists (9.35,
 * `chrome/ErrorBoundary.tsx`, wired at `main.tsx` + `chrome/AppShell.tsx`) and WOULD catch this —
 * but it would blank the whole panel (or the whole app, at the root site) for one turn's worth of
 * bad data. Validating HERE degrades exactly that one turn to ASK_FAILED instead, leaving the rest
 * of the conversation and the panel itself intact — still strictly better recovery than
 * catch-after-throw, which is why this gate stays even with a boundary now in place. A shallow
 * `Array.isArray` pair would still admit `citations: [null]` and throw on `c.citationId` at render —
 * validating with the full contract schema is what actually closes that.
 *
 * ⚠ 9.34 — the SOLE minting function for {@link AdmittedCopilotAnswer}. Exported so a future
 * consumer (a `copilotBriefing`/`copilotConcept` surface, or a test rendering {@link CopilotAnswerView}
 * directly) can admit its own candidate data rather than being tempted to cast past the brand.
 */
export function admitReply(candidate: unknown): AdmittedCopilotAnswer {
  const parsed = UiSafeCopilotAnswerSchema.safeParse(candidate);
  return (parsed.success ? parsed.data : FAILED_REPLY) as AdmittedCopilotAnswer;
}

/** The branded failure reply, minted once — `FAILED_REPLY` already satisfies the contract schema,
 *  so this always succeeds; avoids re-parsing it at every failure-turn construction. */
const ADMITTED_FAILED_REPLY: AdmittedCopilotAnswer = admitReply(FAILED_REPLY);

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
export function CopilotAnswerView({ reply }: { readonly reply: AdmittedCopilotAnswer }): ReactElement {
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
 *  separated from the answer it belongs to (9.28). */
function CopilotTurn({ turn }: { readonly turn: CopilotTurnView }): ReactElement {
  return (
    <div className="sow-copilot-turn">
      <div className="sow-copilot-bubble sow-copilot-bubble--user">{turn.question}</div>
      <div className="sow-copilot-bubble sow-copilot-bubble--assistant">
        <CopilotAnswerView reply={turn.reply} />
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

/** One chat's in-app state. App keeps a {@link ChatSessionStore} for the whole app session, so a chat's turns and
 *  its in-flight answer survive a collapse, a scope switch and a switch back (review of 5b.4d, 2026-09-25). */
export interface ChatSession {
  readonly turns: readonly CopilotTurnView[];
  /** An ask is in flight for this chat. */
  readonly pending: boolean;
  /** "loading": the saved chat is being restored; "failed": it could not be; "ready": ask away. */
  readonly status: "loading" | "ready" | "failed";
  /** The restored chat holds older turns than these. */
  readonly truncated: boolean;
}

/** The chat sessions, keyed by {@link chatSessionKey}. A tiny external store (`useSyncExternalStore`). */
export interface ChatSessionStore {
  readonly get: (key: string) => ChatSession | undefined;
  readonly update: (key: string, fn: (s: ChatSession | undefined) => ChatSession) => void;
  readonly remove: (key: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createChatSessionStore(): ChatSessionStore {
  const sessions = new Map<string, ChatSession>();
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const l of [...listeners]) l();
  };
  return {
    get: (key) => sessions.get(key),
    update: (key, fn) => {
      sessions.set(key, fn(sessions.get(key)));
      emit();
    },
    remove: (key) => {
      if (sessions.delete(key)) emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** ⛔ Rule 4: a session is ONE workspace's chat — keyed by (workspace, chat), never by the chat id alone. */
export function chatSessionKey(workspaceKey: string | null, chatId: string | null): string {
  return JSON.stringify([workspaceKey, chatId]);
}

const READY: ChatSession = { turns: [], pending: false, status: "ready", truncated: false };
const LOADING: ChatSession = { turns: [], pending: false, status: "loading", truncated: false };

/** Live-turn ids — unique across the app (a restored turn's id carries its chat). */
let askSeq = 0;

/** A live answer as a turn — through `admitReply`, the sole minter; a failed ask is an explicit failure turn (9.24). */
function turnFromResult(question: string, result: AskResult): CopilotTurnView {
  askSeq += 1;
  const id = `ask-${String(askSeq)}`;
  try {
    // 9.28 — the validated answer is carried VERBATIM: no field-by-field re-map, so there is no mapping in which a
    // rule-5 egress disclosure can be forgotten. `admitReply` gates this path — see its docblock.
    return result.ok ? { id, question, reply: admitReply(result.answer) } : { id, question, reply: ADMITTED_FAILED_REPLY };
  } catch {
    return { id, question, reply: ADMITTED_FAILED_REPLY };
  }
}

type ListView = { readonly workspace: string | null; readonly list: ChatList };
const CLOSED: ChatList = { kind: "closed" };

export function Copilot(props: CopilotProps): ReactElement {
  const { workspaceScoped, onCollapse, onAsk, workspaceKey = null, chats } = props;
  const live = onAsk !== undefined;
  const chatId = chats?.chatId ?? null;

  // The sessions: App's store when there are saved chats; otherwise this panel's own (an unsaved transcript, still
  // one per workspace). ⛔ Rule 4: what renders is read FROM THE STORE for THIS render's (workspace, chat) — there is
  // no per-view state to reset after a switch, so no frame can show another workspace's chat.
  const ownStore = useRef<ChatSessionStore | null>(null);
  if (ownStore.current === null) ownStore.current = createChatSessionStore();
  const store = chats?.sessions ?? ownStore.current;
  const key = chatSessionKey(workspaceKey, chatId);
  const stored = useSyncExternalStore(store.subscribe, () => store.get(key));
  const session: ChatSession = stored ?? (chats !== undefined ? LOADING : READY);
  const { turns, pending, status, truncated } = session;

  // The draft and the chat list belong to a WORKSPACE: read only when the workspace matches (derived, not reset by an
  // effect — rule 4), so text typed or titles listed under one workspace never show or act under another.
  const [draft, setDraftState] = useState<{ readonly workspace: string | null; readonly text: string }>({ workspace: workspaceKey, text: "" });
  const draftText = draft.workspace === workspaceKey ? draft.text : "";
  const setDraft = (text: string): void => setDraftState({ workspace: workspaceKey, text });
  const [listView, setListView] = useState<ListView>({ workspace: workspaceKey, list: CLOSED });
  const list: ChatList = listView.workspace === workspaceKey ? listView.list : CLOSED;
  const [deleteFailed, setDeleteFailed] = useState<{ readonly workspace: string | null; readonly chatId: string } | null>(null);
  const workspaceRef = useRef(workspaceKey);
  workspaceRef.current = workspaceKey;
  const listOpenRef = useRef(false);
  listOpenRef.current = list.kind !== "closed";
  const listId = useId();

  const collapseRef = useRef<HTMLButtonElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Disclosure focus management: expanding is a subtree swap (the rail's Expand button unmounts), so
  // move keyboard focus INTO the panel rather than dropping it to <body>. The panel mounts ONLY on a
  // user expand (AppShell renders it only when open, Copilot starts collapsed), so focusing on mount
  // never steals focus on initial app load. When live, the ASK INPUT is the natural on-open target;
  // otherwise the Collapse control. The mirror half (return focus to the rail on collapse) is AppShell's.
  // (The input is never disabled while a chat loads — only Send waits — so this focus holds.)
  useEffect(() => {
    if (live && inputRef.current !== null) inputRef.current.focus();
    else collapseRef.current?.focus();
  }, [live]);

  // WS-8: Copilot reads a SINGLE workspace's knowledge. `workspaceScoped` (a prop, computed by App
  // from the onboarded store slice via the fail-closed `resolveOnboardedWorkspaceId`) is true ONLY
  // for one onboarded workspace; Global, a NON-onboarded bucket, AND any unknown scope → false →
  // the pick-a-workspace state, never a cross-workspace blend. (The worker re-derives its own
  // workspace scoping; this only gates the UI affordance.)

  /** Restore a saved chat into its session — once per chat per app session (the store keeps it after that). */
  const load = (): void => {
    if (chats === undefined || chatId === null) return;
    const k = key;
    const id = chatId;
    store.update(k, (s) => ({ ...(s ?? READY), status: "loading" }));
    void chats.onLoadChat(id).then(
      (r) =>
        store.update(k, (s) => {
          const base = s ?? READY;
          if (!r.ok) return { ...base, status: r.notFound ? "ready" : "failed" };
          // ⛔ 9.25: each restored answer is re-admitted — its egress notice renders exactly as on a live answer.
          const restored = r.chat.turns.map((t, i): CopilotTurnView => ({ id: `saved-${id}-${String(i)}`, question: t.question, reply: admitReply(t.answer) }));
          return { ...base, status: "ready", truncated: r.chat.truncated, turns: [...restored, ...base.turns] };
        }),
      () => store.update(k, (s) => ({ ...(s ?? READY), status: "failed" })),
    );
  };
  // A chat with no session yet is restored (StrictMode-safe: `load` records "loading" before it asks).
  useEffect(() => {
    if (chats !== undefined && chatId !== null && store.get(key) === undefined) load();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshList = (): void => {
    if (chats === undefined) return;
    const ws = workspaceKey;
    setListView({ workspace: ws, list: { kind: "loading" } });
    void chats.onListChats().then(
      (r) =>
        // Applied only while THAT workspace's list is still open — a late result never reopens a closed list.
        setListView((cur) =>
          cur.workspace === ws && cur.list.kind !== "closed" ? { workspace: ws, list: r.ok ? { kind: "loaded", chats: r.chats } : { kind: "failed" } } : cur,
        ),
      () => setListView((cur) => (cur.workspace === ws && cur.list.kind !== "closed" ? { workspace: ws, list: { kind: "failed" } } : cur)),
    );
  };
  const toggleList = (): void => {
    if (list.kind === "closed") refreshList();
    else setListView({ workspace: workspaceKey, list: CLOSED });
  };
  const closeListAndFocusInput = (): void => {
    setListView({ workspace: workspaceKey, list: CLOSED });
    inputRef.current?.focus();
  };
  const deleteChat = (id: string): void => {
    if (chats === undefined) return;
    const ws = workspaceKey;
    const current = chatId;
    const c = chats;
    setDeleteFailed(null);
    void c.onDeleteChat(id).then((r) => {
      if (r.ok) store.remove(chatSessionKey(ws, id));
      if (workspaceRef.current !== ws) return; // the owner moved on: touch nothing under another workspace
      if (!r.ok) {
        setDeleteFailed({ workspace: ws, chatId: id });
        return;
      }
      if (id === current) c.onNewChat(); // the open chat is gone — start a new one
      refreshList();
      toggleRef.current?.focus();
    });
  };

  const submit = (): void => {
    const q = draftText.trim();
    if (q === "" || onAsk === undefined || pending || status !== "ready") return;
    setDraft("");
    const k = key;
    const ws = workspaceKey;
    store.update(k, (s) => ({ ...(s ?? READY), pending: true }));
    // The answer goes into ITS chat's session — shown there whenever that chat is on screen, never anywhere else.
    // A failed ask is an explicit failure turn (9.24), never a silent one.
    const finish = (result: AskResult): void => {
      const turn = turnFromResult(q, result);
      store.update(k, (s) => ({ ...(s ?? READY), pending: false, turns: [...(s?.turns ?? []), turn] }));
      if (result.ok && workspaceRef.current === ws && listOpenRef.current) refreshList(); // a first answer adds the chat
    };
    // createAskCopilot never rejects (it folds to {ok:false}), but guard the rejection path anyway.
    void onAsk(q).then(finish, () => finish({ ok: false }));
  };

  const deleteFailedHere = deleteFailed !== null && deleteFailed.workspace === workspaceKey ? deleteFailed.chatId : null;

  return (
    <aside className="sow-copilot-panel" aria-label="Copilot">
      <header className="sow-copilot-head">
        <span className="sow-rail-spark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l1.8 5.4a4 4 0 0 0 2.8 2.8L22 12l-5.4 1.8a4 4 0 0 0-2.8 2.8L12 22l-1.8-5.4a4 4 0 0 0-2.8-2.8L2 12l5.4-1.8a4 4 0 0 0 2.8-2.8z" />
          </svg>
        </span>
        <span className="sow-copilot-title">Copilot</span>
        {chats !== undefined && workspaceScoped ? (
          <button
            ref={toggleRef}
            className="sow-copilot-chats-toggle"
            type="button"
            aria-label="Chats"
            aria-expanded={list.kind !== "closed"}
            aria-controls={listId}
            onClick={toggleList}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
          </button>
        ) : null}
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

      {/* Persistent reminder — present in EVERY state (§4.6). */}
      <div className="sow-copilot-note" role="note">
        Copilot reads only — it never changes your notes or sends anything. Any action becomes a proposal that routes to Approvals.
      </div>

      <div className="sow-copilot-body">
        {workspaceScoped && chats !== undefined && list.kind !== "closed" ? (
          <div className="sow-copilot-chats" id={listId} role="region" aria-label="Saved chats">
            <button
              className="sow-copilot-newchat"
              type="button"
              onClick={() => {
                closeListAndFocusInput();
                chats.onNewChat();
              }}
            >
              New chat
            </button>
            <p className="sow-copilot-chats-note">Chats are saved on this Mac, for this workspace only.</p>
            {deleteFailedHere !== null ? (
              <p className="sow-copilot-chats-note" role="alert">
                Could not delete that chat. Try again.
              </p>
            ) : null}
            {list.kind === "loading" ? (
              <p className="sow-copilot-chats-note" role="status">Loading chats…</p>
            ) : list.kind === "failed" ? (
              <p className="sow-copilot-chats-note" role="status">Could not load your chats.</p>
            ) : list.chats.length === 0 ? (
              <p className="sow-copilot-chats-note" role="status">No saved chats yet.</p>
            ) : (
              <ul className="sow-copilot-chatlist">
                {list.chats.map((c) => {
                  // A chat with an answer in flight cannot be deleted: the worker would save that answer into it and
                  // bring the chat back (review of 5b.4d, measured).
                  const busy = store.get(chatSessionKey(workspaceKey, c.chatId))?.pending === true;
                  return (
                    <li key={c.chatId} className="sow-copilot-chat-item">
                      <button
                        className="sow-copilot-chat-open"
                        type="button"
                        aria-current={c.chatId === chatId ? "true" : undefined}
                        onClick={() => {
                          closeListAndFocusInput();
                          chats.onOpenChat(c.chatId);
                        }}
                      >
                        {c.title}
                      </button>
                      <button
                        className="sow-copilot-chat-delete"
                        type="button"
                        aria-label={`Delete chat: ${c.title}`}
                        disabled={busy}
                        title={busy ? "Wait for the answer, then delete" : undefined}
                        onClick={() => deleteChat(c.chatId)}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : !workspaceScoped ? (
          // WS-8: no cross-workspace ask. Pick a single workspace to query its knowledge.
          <div className="sow-copilot-empty" role="status">
            Copilot reads a single workspace&apos;s knowledge — pick a workspace to ask.
          </div>
        ) : status === "loading" ? (
          <div className="sow-copilot-empty" role="status">
            Loading this chat…
          </div>
        ) : status === "failed" ? (
          <div className="sow-copilot-empty" role="status">
            <p className="sow-copilot-empty-lead">Could not load this chat.</p>
            <button className="sow-copilot-chip" type="button" onClick={load}>
              Try again
            </button>
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
            {truncated ? (
              <p className="sow-copilot-chats-note" role="status">
                Older messages in this chat are not shown.
              </p>
            ) : null}
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

      {/* Composer — only where an ask is possible (a single workspace). Live when `onAsk` is provided; Send waits while
          an answer is in flight or the chat is loading or failed to load. */}
      {workspaceScoped ? (
        <Composer
          value={draftText}
          onChange={setDraft}
          onSubmit={submit}
          disabled={!live}
          pending={pending || status !== "ready"}
          inputRef={inputRef}
        />
      ) : null}
    </aside>
  );
}

// spec(§12/§18.1/§5.4) — EVAL-1 corpus entry schemas (tasks 12.2/12.3).
//
// The shared data contract for the EVAL-1 corpora: what a labeled meeting
// transcript, a retrieval query, an injection vector, and a leakage case each
// look like. The corpus-authoring workflow produces entries of these shapes; the
// corpus tests (and the later 12.16/12.17 e2e suites) consume them. Kept
// self-contained (test data, not a frozen contract) but shaped to what the
// meeting-closeout no-inference validator + leakage/injection gates assert.
//
// Floors are the HARD §20.1/A7 sizes — the corpus-loader rejects below-floor.

export type Workspace = "employer-work" | "personal-business" | "personal-life";
export type Sensitivity = "public" | "internal" | "confidential";

/** The EVAL-1 floors (A7 / §20.1). Enforced by `loadCorpus`. */
export const CORPUS_FLOORS = {
  meetingCloseout: 20,
  retrieval: 30,
  injection: 6, // 5 PRD §16.1 vectors + the cross-workspace exfiltration vector
  leakage: 15,
} as const;

// ── meeting-closeout ─────────────────────────────────────────────────────────
/** `"TBD"` sentinel — an unstated owner/date the assistant must NOT infer (REQ-F-017). */
export type OwnerOrTbd = string;
export type DateOrTbd = string;

export interface MeetingGoldTask {
  readonly title: string;
  /** Gold owner, or `"TBD"` when the transcript never states one (no-inference). */
  readonly owner: OwnerOrTbd;
  /** Gold due date (ISO), or `"TBD"` when unstated. */
  readonly due: DateOrTbd;
  /** Quote/marker in the transcript that grounds this task (evidence-ref). */
  readonly evidenceRef: string;
}

export interface MeetingGold {
  readonly workspace: Workspace;
  readonly project: string;
  readonly decisions: readonly string[];
  readonly tasks: readonly MeetingGoldTask[];
  readonly notes: readonly string[];
  /** True iff any owner/due is `"TBD"` — the run must route to clarification, not invent. */
  readonly requiresClarification: boolean;
}

export interface MeetingCorpusEntry {
  readonly id: string;
  readonly sensitivity: Sensitivity;
  readonly transcript: string;
  readonly gold: MeetingGold;
  /** Marks a fixture whose purpose is the REQ-F-017 no-inference/TBD path. */
  readonly noInference: boolean;
}

// ── retrieval ────────────────────────────────────────────────────────────────
export interface RetrievalCorpusEntry {
  readonly id: string;
  readonly workspace: Workspace;
  readonly query: string;
  /** Stable ids of the docs that SHOULD be retrieved (gold relevant set). */
  readonly goldDocIds: readonly string[];
  /** Expected citation strings the answer should ground on. */
  readonly goldCitations: readonly string[];
}

// ── prompt-injection ─────────────────────────────────────────────────────────
export type InjectionVector =
  | "transcript"
  | "calendar_description"
  | "web_docs"
  | "notebooklm_drive"
  | "markdown_note"
  | "cross_workspace_exfil";

export type InjectionExpectedOutcome =
  | "rejected_at_admission" // ING-7: job declaring a mutating tool on untrusted content
  | "read_only_no_side_effect" // §16.1: empty/read-only toolPolicy; no external write/send
  | "plan_only_no_autoapply"; // KN-5: any change emitted as KnowledgeMutationPlan, not applied

export interface InjectionCorpusEntry {
  readonly id: string;
  readonly vector: InjectionVector;
  /** The untrusted content carrying the injection. */
  readonly payload: string;
  /** What the payload tries to make the agent do (the declared attack). */
  readonly declaredAttempt: string;
  /** The governance outcome that MUST hold (asserted rejected, not merely absent). */
  readonly expectedOutcome: InjectionExpectedOutcome;
}

// ── workspace leakage ────────────────────────────────────────────────────────
export interface LeakageCorpusEntry {
  readonly id: string;
  readonly sourceWorkspace: "employer-work";
  readonly targetWorkspace: "personal-business" | "personal-life" | "global";
  /** Raw Employer-Work content that must never surface cross-workspace absent a link. */
  readonly rawEmployerContent: string;
  /** The cross-workspace probe (query/output) under which leakage is measured. */
  readonly probe: string;
  /** Gold: zero raw employer sentences may appear (WS-4/WS-7). Always 0. */
  readonly expectedLeakedSentences: 0;
}

export type CorpusKind = "meeting-closeout" | "retrieval" | "injection" | "leakage";

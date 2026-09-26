// @sow/worker — the Copilot's own LINEAR path: the `propose_linear_issue` tool (Linear slice 5b.3a).
//
// OWNER DECISIONS (2026-09-25):
//   • B — the Copilot files Linear cards itself. Each card still needs the owner's Approve; nothing is sent from here.
//   • TEAM — the owner names it (exact match, ignoring case). If they don't, the tool answers with the workspace's team
//     NAMES so the Copilot can suggest one for the owner to confirm or redirect. ⛔ This is an OWNER-AUTHORIZED
//     EXCEPTION TO SAFETY RULE 6 (ING-7: an agent that reads imported content must be read-only): Linear team names
//     are imported content and this job holds a write-capable tool. It is kept NARROW — team NAMES only (never ids),
//     one line each, at most 100 — and it is bounded by the human gate: every card still needs the owner's Approve.
//   • ASSIGNEE — "you, or who you name": the key's own user by default; a named person is matched EXACTLY against the
//     Linear members, in the worker. No member list is ever sent to the model.
//   • PRIORITY and DUE DATE — only if the owner stated them (the prompt says so; the card shows them before Approve).
//
// ⛔ The worker builds the WHOLE payload from resolved values, and the KEYS from the content (`{workspace, content}`,
// fixed operation). The model supplies content only — never a key, an id or an extra field — so a "create" can never
// be aimed at an existing issue and become an UPDATE (rule 3). The card's actor is `LINEAR_COPILOT_ACTOR` (set by the
// sink's config), which is what lets its Details show the team, the assignee and the due date.
import { isOk, LINEAR_DESCRIPTION_MAX, isCalendarDate, collapseToSummaryLine } from "@sow/contracts";
import type { Approval, WorkspaceId } from "@sow/contracts";
import type { ApprovalRepository } from "@sow/db";
import { sha256Hex } from "@sow/domain";
import { proposeCopilotAction, type CopilotProposeSink, type CopilotProposeToolResult } from "./copilotPropose";
import type { ArmedFor, LinearTeamsOutcome, LinearPeople } from "../../composition/backends";

/** The SDK tool name the model sees (as `mcp__copilot__propose_linear_issue`). */
export const COPILOT_LINEAR_PROPOSE_TOOL_NAME = "propose_linear_issue";

/** The operation folded into the keys — fixed; never the model's. */
const OPERATION = "linear.create_issue";
const MAX_TITLE = 255;
const MAX_NAME = 200;
/** The most team names one answer lists (the rule-6 exception is bounded). */
const MAX_LISTED_TEAMS = 100;

export interface CopilotLinearProposeDeps {
  /** SERVER-BOUND — the job's own workspace, never a model field. */
  readonly workspaceId: WorkspaceId;
  readonly armedFor: ArmedFor;
  readonly listLinearTeams: (workspaceId: string) => Promise<LinearTeamsOutcome>;
  readonly linearPeople: LinearPeople;
  /** Read back a card on a re-proposal, so the answer says honestly whether it is still pending. */
  readonly approvals: ApprovalRepository;
  /** The approvals sink, built with `actor: LINEAR_COPILOT_ACTOR`. */
  readonly sink: CopilotProposeSink;
}

interface LinearIntent {
  readonly title: string;
  readonly description: string;
  readonly team?: string;
  readonly assignee?: string;
  readonly priority?: number;
  readonly dueDate?: string;
}

const FIELDS: ReadonlySet<string> = new Set(["title", "description", "team", "assignee", "priority", "dueDate"]);
const LINE_BREAK = /[\r\n\u000B\u000C\u0085\u2028\u2029]/;

function optionalName(v: unknown): string | undefined | null {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || v.length > MAX_NAME || LINE_BREAK.test(v)) return null;
  return v.trim().length === 0 ? undefined : v.trim();
}

/** The model's args, strictly: the six fields and nothing else. `null` ⇒ malformed. */
function parse(raw: unknown): LinearIntent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  if (Object.keys(src).some((k) => !FIELDS.has(k))) return null;
  const { title, description, priority, dueDate } = src;
  if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_TITLE || LINE_BREAK.test(title)) return null;
  if (typeof description !== "string" || description.length > LINEAR_DESCRIPTION_MAX) return null;
  if (priority !== undefined && (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4)) return null;
  if (dueDate !== undefined && !isCalendarDate(dueDate)) return null;
  const team = optionalName(src["team"]);
  const assignee = optionalName(src["assignee"]);
  if (team === null || assignee === null) return null;
  return {
    title: title.trim(),
    description,
    ...(team !== undefined ? { team } : {}),
    ...(assignee !== undefined ? { assignee } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
  };
}

function refuse(code: string, detail = ""): CopilotProposeToolResult {
  return { content: [{ type: "text", text: `Could not record the proposal (${code}). ${detail}No action was taken.` }], isError: true };
}

/**
 * The team NAMES the owner may choose from — ⛔ the rule-6 exception (owner, 2026-09-25): names only, never ids, each
 * collapsed onto one line, at most {@link MAX_LISTED_TEAMS}.
 */
function teamNames(teams: readonly { readonly name: string }[]): string {
  const names = teams
    .slice(0, MAX_LISTED_TEAMS)
    .map((t) => collapseToSummaryLine(t.name))
    .filter((n) => n.length > 0);
  return names.map((n) => `"${n}"`).join(", ");
}

const norm = (s: string): string => s.trim().toLowerCase();

async function readBack(approvals: ApprovalRepository, ref: string): Promise<Approval | undefined> {
  try {
    const got = await approvals.get(ref as Approval["id"]);
    return isOk(got) ? got.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Handle a `propose_linear_issue` call. Fail-safe (never throws) and redaction-safe: the model sees a bounded code, the
 * team NAMES under the rule-6 exception, and the names of the resolved team and assignee — never ids, keys or raw
 * content it did not already send.
 */
export async function handleCopilotLinearProposeToolCall(rawArgs: unknown, deps: CopilotLinearProposeDeps): Promise<CopilotProposeToolResult> {
  try {
    const ws = String(deps.workspaceId);
    const intent = parse(rawArgs);
    if (intent === null) return refuse("COPILOT_LINEAR_MALFORMED");
    if (!deps.armedFor("linear", ws)) return refuse("COPILOT_LINEAR_WRITES_OFF", "Linear writes are not on for this workspace. ");

    const teams = await deps.listLinearTeams(ws);
    if (!teams.ok) {
      return teams.reason === "not_armed_for_workspace"
        ? refuse("COPILOT_LINEAR_WRITES_OFF", "Linear writes are not on for this workspace. ")
        : refuse("COPILOT_LINEAR_TEAMS_UNAVAILABLE");
    }
    const listed = teamNames(teams.teams);
    if (intent.team === undefined) {
      return refuse(
        "COPILOT_LINEAR_TEAM_REQUIRED",
        `No team was named. This workspace's Linear teams are: ${listed}. Suggest one to the owner and ask them to confirm or pick another, then call ${COPILOT_LINEAR_PROPOSE_TOOL_NAME} again with "team" set to that exact name. `,
      );
    }
    const matches = teams.teams.filter((t) => norm(t.name) === norm(intent.team ?? ""));
    if (matches.length === 0) return refuse("COPILOT_LINEAR_TEAM_NOT_FOUND", `The teams are: ${listed}. `);
    if (matches.length > 1) return refuse("COPILOT_LINEAR_TEAM_AMBIGUOUS", `The teams are: ${listed}. `);
    const team = matches[0] as { id: string; name: string };

    const who = intent.assignee === undefined ? await deps.linearPeople.viewer(ws) : await deps.linearPeople.findMember(ws, intent.assignee);
    if (!who.ok) {
      const reason = who.reason;
      if (reason === "not_found") return refuse("COPILOT_LINEAR_ASSIGNEE_NOT_FOUND", "Ask the owner for the person's exact name or email. ");
      if (reason === "ambiguous") return refuse("COPILOT_LINEAR_ASSIGNEE_AMBIGUOUS", "Ask the owner for the person's email. ");
      if (reason === "too_many_members") return refuse("COPILOT_LINEAR_ASSIGNEE_TOO_MANY", "Ask the owner for the person's exact email. ");
      if (reason === "not_armed_for_workspace") return refuse("COPILOT_LINEAR_WRITES_OFF", "Linear writes are not on for this workspace. ");
      return refuse("COPILOT_LINEAR_ASSIGNEE_UNAVAILABLE");
    }

    // The whole payload, from resolved values only.
    const payload: Record<string, unknown> = {
      teamId: team.id,
      teamName: team.name,
      title: intent.title,
      description: intent.description,
      assigneeId: who.user.id,
      assigneeName: who.user.name,
      ...(intent.priority !== undefined ? { priority: intent.priority } : {}),
      ...(intent.dueDate !== undefined ? { dueDate: intent.dueDate } : {}),
    };
    // Keys from the CONTENT (rule 3): the same issue is one card; any change is a new card; never an existing issue.
    const content = sha256Hex(
      JSON.stringify([team.id, intent.title, intent.description, intent.priority ?? null, who.user.id, intent.dueDate ?? null]),
    );
    const proposed = await proposeCopilotAction({
      intent: { targetSystem: "linear", operation: OPERATION, identity: { workspace: ws, content }, payload },
      workspaceId: deps.workspaceId,
      sink: deps.sink,
    });
    if (!proposed.ok) return refuse(proposed.error.cause?.code ?? proposed.error.kind);

    const { approvalRef, created } = proposed.value;
    const where = `in team "${collapseToSummaryLine(team.name)}", assigned to ${collapseToSummaryLine(who.user.name)}`;
    if (created) {
      return {
        content: [
          {
            type: "text",
            text: `Recorded a PENDING approval (${approvalRef}) for a Linear issue ${where}. Nothing has been sent — the owner must approve it in the Approvals inbox first.`,
          },
        ],
      };
    }
    const card = await readBack(deps.approvals, approvalRef);
    const state =
      card === undefined
        ? `That issue was proposed before (${approvalRef}), but its state could not be confirmed — check the Approvals inbox.`
        : card.status === "pending"
          ? `That issue is ALREADY pending approval (${approvalRef}) — no duplicate was created.`
          : `That issue was proposed before and its card is already decided (${approvalRef}) — nothing new was recorded.`;
    return { content: [{ type: "text", text: state }] };
  } catch {
    return refuse("COPILOT_LINEAR_FAULT");
  }
}

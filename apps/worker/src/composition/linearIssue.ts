// @sow/worker — the real LinearIssuePort: the Linear issue FORM on the Approvals page. Linear slice 5a, part 3.
//
// Owner decisions (2026-09-25):
//   • The form proposes a Linear issue in the ACTIVE workspace (the renderer asks with the active scope's id).
//   • Its team list is read from Linear ONLY when Linear writes are on for that workspace. So `armedFor("linear", ws)`
//     is checked BEFORE the team lister is touched — writes off ⇒ no Linear call and no key read, said as a VALUE.
//
// A proposal rides the EXISTING path — `proposeCopilotAction` → the approvals sink — so the card and its saved action
// + envelope are exactly what the Approvals screen already dispatches through the Tool Gateway (rule 3). Every Linear
// write still needs the owner's Approve; this creates a PENDING card, nothing more.
//
// ⛔ Rule 4: the team is resolved HERE from the list this worker read from that workspace's Linear; a team id the form
// sent that is not in it is refused. The team NAME saved on the action is that list's, never the form's.
// ⛔ Rule 3 keys: neither key builder folds a workspace, so the identity carries it — `{ workspace, draft }`, where the
// draft id is minted by the form on open. A double submit is one card; two issues never collide, even with one title.
// ⛔ REQ-F-017: the payload carries no owner and no date (and the Linear sender would drop them anyway).
import { ok, err, failure, isOk } from "@sow/contracts";
import type { FailureVariant, Result, UiSafeLinearProposalResult, UiSafeLinearTeamList, WorkspaceId, Approval } from "@sow/contracts";
import type { ApprovalRepository, WorkspaceConfigRepository } from "@sow/db";
import type { LinearIssuePort, LinearProposalInput, LinearTeamsInput } from "../api/procedures/linearIssue";
import { proposeCopilotAction, type CopilotProposeSink } from "../api/procedures/copilotPropose";
import { toUiSafeLinearProposalResult, toUiSafeLinearTeamList } from "../api/projections/uiSafe";
import type { ArmedFor, LinearTeamsOutcome } from "./backends";

/** The actor recorded on a card the owner proposed from the form — never the Copilot's `copilot-agent`. */
export const LINEAR_FORM_ACTOR = "owner-form";

/** The operation label folded into the idempotency key (lowercase dotted, like `todoist.create_task`). */
export const LINEAR_CREATE_OPERATION = "linear.create_issue";

export interface LinearIssuePortDeps {
  readonly workspaceConfig: WorkspaceConfigRepository;
  readonly approvals: ApprovalRepository;
  readonly armedFor: ArmedFor;
  /** The gate's team lister (`backends.listLinearTeams`) — refuses, with no network, unless Linear writes are armed. */
  readonly listLinearTeams: (workspaceId: string) => Promise<LinearTeamsOutcome>;
  /** The approvals sink, built with `actor: LINEAR_FORM_ACTOR`. */
  readonly sink: CopilotProposeSink;
}

const UNKNOWN_WORKSPACE: Result<never, FailureVariant> = err(
  failure("validation_rejected", "unknown workspace", { cause: { code: "LINEAR_ISSUE_UNKNOWN_WORKSPACE" } }),
);

/** The sink's refusals that mean "this form was already submitted with different content". */
const CONFLICT_CODES: ReadonlySet<string> = new Set(["COPILOT_PROPOSE_PAYLOAD_CONFLICT", "COPILOT_PROPOSE_SAVED_FOR_OTHER_CARD"]);
/** The derivation's refusals — the form's content could not become a valid action. */
const INVALID_CODES: ReadonlySet<string> = new Set([
  "COPILOT_PROPOSE_MALFORMED",
  "COPILOT_PROPOSE_BAD_TARGET",
  "COPILOT_PROPOSE_BAD_OPERATION",
  "COPILOT_PROPOSE_EMPTY_IDENTITY",
  "COPILOT_PROPOSE_PAYLOAD_TOO_LARGE",
  "COPILOT_PROPOSE_SCHEMA_REJECTED",
]);

async function workspaceKnown(deps: LinearIssuePortDeps, workspaceId: string): Promise<boolean> {
  try {
    return isOk(await deps.workspaceConfig.get(workspaceId as WorkspaceId));
  } catch {
    return false;
  }
}

async function readBack(deps: LinearIssuePortDeps, approvalRef: string): Promise<Approval | undefined> {
  try {
    const got = await deps.approvals.get(approvalRef as Approval["id"]);
    return isOk(got) ? got.value : undefined;
  } catch {
    return undefined;
  }
}

export function createLinearIssuePort(deps: LinearIssuePortDeps): LinearIssuePort {
  return {
    async teams(input: LinearTeamsInput): Promise<Result<UiSafeLinearTeamList, FailureVariant>> {
      if (!(await workspaceKnown(deps, input.workspaceId))) return UNKNOWN_WORKSPACE;
      // ⛔ BEFORE the lister: writes off ⇒ no Linear call, no key read.
      if (!deps.armedFor("linear", input.workspaceId)) return ok(toUiSafeLinearTeamList({ status: "writes_off", teams: [], truncated: false }));
      const read = await deps.listLinearTeams(input.workspaceId);
      if (read.ok) return ok(toUiSafeLinearTeamList({ status: "ready", teams: read.teams, truncated: read.hasMore }));
      const status = read.reason === "not_armed_for_workspace" ? "writes_off" : "unavailable";
      return ok(toUiSafeLinearTeamList({ status, teams: [], truncated: false }));
    },

    async propose(input: LinearProposalInput): Promise<Result<UiSafeLinearProposalResult, FailureVariant>> {
      const ws = input.workspaceId;
      if (!(await workspaceKnown(deps, ws))) return UNKNOWN_WORKSPACE;
      if (!deps.armedFor("linear", ws)) return ok({ outcome: "writes_off" });
      const read = await deps.listLinearTeams(ws);
      if (!read.ok) return ok({ outcome: read.reason === "not_armed_for_workspace" ? "writes_off" : "unavailable" });
      const team = read.teams.find((t) => t.id === input.teamId);
      if (team === undefined) return ok({ outcome: "unknown_team" });

      const proposed = await proposeCopilotAction({
        intent: {
          targetSystem: "linear",
          operation: LINEAR_CREATE_OPERATION,
          identity: { workspace: ws, draft: input.draftId },
          payload: {
            teamId: team.id,
            teamName: team.name,
            title: input.title.trim(),
            description: input.description,
            priority: input.priority,
          },
        },
        workspaceId: ws as WorkspaceId,
        sink: deps.sink,
      });
      if (!proposed.ok) {
        const code = proposed.error.cause?.code ?? "";
        if (CONFLICT_CODES.has(code)) return ok({ outcome: "conflict" });
        if (INVALID_CODES.has(code)) return ok({ outcome: "invalid_input" });
        return ok({ outcome: "unavailable" });
      }
      const outcome = proposed.value.created ? "created" : "already_pending";
      const card = await readBack(deps, proposed.value.approvalRef);
      return ok(toUiSafeLinearProposalResult(card !== undefined ? { outcome, approval: card } : { outcome }));
    },
  };
}

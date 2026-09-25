// @sow/worker — the Linear issue FORM's surface on the Approvals page: the active workspace's Linear teams, and
// proposing an issue. Linear slice 5a, part 3.
//
// Owner decisions (2026-09-25): the form lives on the Approvals page; its team list is read from Linear ONLY when
// Linear writes are on for the workspace. The port (composition/linearIssue.ts) enforces both and turns the form
// into a PENDING card through the existing propose path — every Linear write still needs the owner's Approve. This
// router authenticates, validates the form at the boundary, and re-checks every output against its UI-safe contract.
//
// ⭐ A bad field is DATA (`outcome: "invalid_input"`), not a thrown error: a form must be able to say what happened,
// and a thrown parser error reaches the renderer as a content-free internal error (grounding 2026-09-25).
// ⛔ REQ-F-017 — the form carries no owner and no date. An input that carries either is refused, not dropped.
import { ok, err, failure } from "@sow/contracts";
import type { FailureVariant, Result, UiSafeLinearProposalResult, UiSafeLinearTeamList } from "@sow/contracts";
import { UiSafeLinearProposalResultSchema, UiSafeLinearTeamListSchema } from "@sow/contracts";
import { router, publicProcedure, authedResolver } from "../router";

/** The longest title the form sends. The form enforces the same bound. */
export const MAX_LINEAR_TITLE = 255;
/** The longest description the form sends — below the 16 KiB propose bound once serialized, in the usual case. */
export const MAX_LINEAR_DESCRIPTION = 8000;

export interface LinearTeamsInput {
  readonly workspaceId: string;
}

/** One form submission. `draftId` is minted by the form when it OPENS, so a double submit is one proposal. */
export interface LinearProposalInput {
  readonly workspaceId: string;
  readonly draftId: string;
  readonly teamId: string;
  readonly title: string;
  readonly description: string;
  /** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  readonly priority: number;
}

/** The form's port. The composition root binds the real one; a test injects a fake. Never throws. */
export interface LinearIssuePort {
  readonly teams: (input: LinearTeamsInput) => Promise<Result<UiSafeLinearTeamList, FailureVariant>>;
  readonly propose: (input: LinearProposalInput) => Promise<Result<UiSafeLinearProposalResult, FailureVariant>>;
}

const unavailable = (): Result<never, FailureVariant> =>
  err(failure("degraded_unavailable", "linear issue form not bound", { cause: { code: "LINEAR_ISSUE_UNAVAILABLE" } }));

/** The port bound when nothing real is available: every call fails closed, nothing is ever faked. */
export const UNAVAILABLE_LINEAR_ISSUE_PORT: LinearIssuePort = {
  teams: async () => unavailable(),
  propose: async () => unavailable(),
};

const UNSERVABLE = (): Result<never, FailureVariant> =>
  err(failure("validation_rejected", "linear issue output failed its contract", { cause: { code: "LINEAR_ISSUE_UNSERVABLE" } }));

/** Re-check an ok output against its contract; a producer bug becomes a typed error, never a leak. */
function checked<T>(res: Result<T, FailureVariant>, valid: (v: T) => boolean): Result<T, FailureVariant> {
  if (!res.ok) return res;
  return valid(res.value) ? res : UNSERVABLE();
}

const passthroughInput = (raw: unknown): unknown => raw;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The same line-terminator family the UI-safe single-line gate refuses (CR, LF, VT, FF, NEL, LS, PS).
const LINE_BREAK = /[\r\n\u000B\u000C\u0085\u2028\u2029]/;
const PROPOSAL_FIELDS: ReadonlySet<string> = new Set(["workspaceId", "draftId", "teamId", "title", "description", "priority"]);

function boundedId(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && !LINE_BREAK.test(v);
}

/** The form, validated. `null` ⇒ `invalid_input`. Strict: an unexpected key (an owner, a date) refuses the whole form. */
export function parseLinearProposal(raw: unknown): LinearProposalInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const src = raw as Record<string, unknown>;
  if (Object.keys(src).some((k) => !PROPOSAL_FIELDS.has(k))) return null;
  const { workspaceId, draftId, teamId, title, description, priority } = src;
  if (!boundedId(workspaceId, 128) || !boundedId(teamId, 64)) return null;
  if (typeof draftId !== "string" || !UUID.test(draftId)) return null;
  if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_LINEAR_TITLE || LINE_BREAK.test(title)) return null;
  if (typeof description !== "string" || description.length > MAX_LINEAR_DESCRIPTION) return null;
  if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 4) return null;
  return { workspaceId, draftId, teamId, title, description, priority };
}

function parseTeams(raw: unknown): LinearTeamsInput | null {
  if (typeof raw !== "object" || raw === null) return null;
  const workspaceId = (raw as Record<string, unknown>)["workspaceId"];
  return boundedId(workspaceId, 128) ? { workspaceId } : null;
}

export interface LinearIssueRouterDeps {
  readonly linearIssue: LinearIssuePort;
}

export function buildLinearIssueRouter(deps: LinearIssueRouterDeps) {
  const { linearIssue } = deps;
  return router({
    teams: publicProcedure.input(passthroughInput).query(
      authedResolver<unknown, UiSafeLinearTeamList>(async (_ctx, raw) => {
        const input = parseTeams(raw);
        if (input === null) {
          return err(failure("validation_rejected", "invalid teams input", { cause: { code: "LINEAR_ISSUE_INPUT" } }));
        }
        return checked(await linearIssue.teams(input), (v) => UiSafeLinearTeamListSchema.safeParse(v).success);
      }),
    ),
    propose: publicProcedure.input(passthroughInput).mutation(
      authedResolver<unknown, UiSafeLinearProposalResult>(async (_ctx, raw) => {
        const input = parseLinearProposal(raw);
        if (input === null) return ok({ outcome: "invalid_input" });
        return checked(await linearIssue.propose(input), (v) => UiSafeLinearProposalResultSchema.safeParse(v).success);
      }),
    ),
  });
}

export type LinearIssueRouter = ReturnType<typeof buildLinearIssueRouter>;

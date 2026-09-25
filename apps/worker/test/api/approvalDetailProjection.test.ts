// The UI-safe projection of an approval's details and of a "Send now" result. Linear slice 3+4, step 4c.
//
// ⛔ This projector is the ONE place an external action's own content (its title and description) becomes
// renderer-visible. It copies NAMED fields only — never a spread — so anything else on its source (the raw payload,
// a team id, an assignee, a due date, a key) cannot ride out. The workspace check that decides WHETHER to serve
// details at all lives in the port (step 4d); this file pins the SHAPE.
import { describe, it, expect } from "vitest";
import type { Approval } from "@sow/contracts";
import {
  UiSafeApprovalDetailSchema,
  UiSafeSendNowResultSchema,
  UiSafeLinearTeamListSchema,
  UiSafeLinearProposalResultSchema,
  UI_SAFE_ALLOWLIST,
} from "@sow/contracts";
import {
  toUiSafeApprovalDetail,
  toUiSafeSendNowResult,
  toUiSafeLinearTeamList,
  toUiSafeLinearProposalResult,
  type ApprovalDetailSource,
} from "../../src/api/projections/uiSafe";

const NL = String.fromCharCode(0x0a);

describe("toUiSafeApprovalDetail", () => {
  const base: ApprovalDetailSource = {
    approvalId: "idem_abc",
    sendState: "writes_off",
    targetSystem: "linear",
    title: "Fix the login bug",
    description: ["Steps:", "", "1. open the app", "2. sign in"].join(NL),
  };

  it("positive control: the title, the description lines and the system do appear, and the result is contract-valid", () => {
    const out = toUiSafeApprovalDetail(base);
    expect(out).toEqual({
      approvalId: "idem_abc",
      sendState: "writes_off",
      targetSystem: "linear",
      title: "Fix the login bug",
      descriptionLines: ["Steps:", "1. open the app", "2. sign in"],
    });
    expect(UiSafeApprovalDetailSchema.safeParse(out).success).toBe(true);
  });

  it("⛔ copies only allowlisted names: payload, team, assignee, due date, workspace and keys never cross", () => {
    const tainted = {
      ...base,
      payload: { teamId: "team-SECRET", assigneeId: "user-1" },
      teamId: "team-SECRET",
      assigneeId: "user-1",
      dueDate: "2026-12-01",
      workspaceId: "employer-work",
      idempotencyKey: "idem:x",
      tokenRef: "keychain://connector-write.employer-work/linear",
    } as ApprovalDetailSource;
    const out = toUiSafeApprovalDetail(tainted);
    for (const k of Object.keys(out)) expect(UI_SAFE_ALLOWLIST.approvalDetail as readonly string[]).toContain(k);
    const json = JSON.stringify(out);
    for (const s of ["team-SECRET", "user-1", "2026-12-01", "keychain://", "idem:x", "employer-work"]) expect(json).not.toContain(s);
  });

  it("⛔ a REFUSED state carries no content at all, even if the source has some (it is not provably this card's)", () => {
    const out = toUiSafeApprovalDetail({ ...base, sendState: "refused", refusal: "payload_mismatch" });
    expect(out).toEqual({ approvalId: "idem_abc", sendState: "refused", refusal: "payload_mismatch", targetSystem: "linear" });
  });

  it("collapses a multi-line title to one line, and flags a truncated description", () => {
    const long = Array.from({ length: 45 }, (_, i) => `line ${i}`).join(NL);
    const out = toUiSafeApprovalDetail({ ...base, title: `two${NL}lines`, description: long });
    expect(out.title).toBe("two lines");
    expect(out.descriptionLines).toHaveLength(40);
    expect(out.descriptionTruncated).toBe(true);
    expect(UiSafeApprovalDetailSchema.safeParse(out).success).toBe(true);
  });

  it("drops a system outside the enum, and non-string or blank title/description", () => {
    const out = toUiSafeApprovalDetail({ ...base, targetSystem: "gmail", title: 42, description: "   " });
    expect(out).toEqual({ approvalId: "idem_abc", sendState: "writes_off" });
  });
});

describe("toUiSafeSendNowResult", () => {
  it("copies the id, the state and the refusal only", () => {
    const out = toUiSafeSendNowResult({ approvalId: "idem_abc", sendState: "refused", refusal: "workspace_mismatch", ...({ payload: "x" } as object) });
    expect(out).toEqual({ approvalId: "idem_abc", sendState: "refused", refusal: "workspace_mismatch" });
    expect(UiSafeSendNowResultSchema.safeParse(out).success).toBe(true);
  });
});

// Linear slice 5a — the team NAME on a card's details, the team list and a proposal's result.
describe("toUiSafeApprovalDetail — the team name (Linear slice 5a)", () => {
  const base: ApprovalDetailSource = { approvalId: "idem_abc", sendState: "writes_off", targetSystem: "linear", title: "T" };

  it("shows the team NAME, collapsed to one line — never the team id", () => {
    const out = toUiSafeApprovalDetail({ ...base, teamName: `Core${NL}Platform`, ...({ teamId: "team-SECRET" } as object) });
    expect(out.teamName).toBe("Core Platform");
    expect(JSON.stringify(out)).not.toContain("team-SECRET");
    expect(UiSafeApprovalDetailSchema.safeParse(out).success).toBe(true);
  });

  it("drops a blank or non-string team name", () => {
    expect(toUiSafeApprovalDetail({ ...base, teamName: "   " }).teamName).toBeUndefined();
    expect(toUiSafeApprovalDetail({ ...base, teamName: 7 }).teamName).toBeUndefined();
  });

  it("⛔ a REFUSED detail carries no team name either", () => {
    expect(toUiSafeApprovalDetail({ ...base, sendState: "refused", refusal: "payload_mismatch", teamName: "Core" }).teamName).toBeUndefined();
  });
});

describe("toUiSafeLinearTeamList", () => {
  it("copies each team's id and name only, collapsed to one line, and keeps the status and truncation", () => {
    const out = toUiSafeLinearTeamList({
      status: "ready",
      teams: [
        { id: "t1", name: `Core${NL}Platform`, ...({ key: "CORE", token: "lin_api_SECRET" } as object) },
        { id: "t2", name: "Mobile" },
      ],
      truncated: true,
    });
    expect(out).toEqual({ status: "ready", teams: [{ id: "t1", name: "Core Platform" }, { id: "t2", name: "Mobile" }], truncated: true });
    expect(UiSafeLinearTeamListSchema.safeParse(out).success).toBe(true);
  });

  it("drops a team with no id or no name rather than failing the whole list", () => {
    const out = toUiSafeLinearTeamList({ status: "ready", teams: [{ id: "", name: "x" }, { id: "t", name: "  " }, { id: "ok", name: "Ok" }], truncated: false });
    expect(out.teams).toEqual([{ id: "ok", name: "Ok" }]);
  });

  it("drops a team whose id breaks the contract's id bound (over 64, or a line break) — the rest of the list survives", () => {
    const out = toUiSafeLinearTeamList({
      status: "ready",
      teams: [{ id: "x".repeat(65), name: "Long" }, { id: `t${String.fromCharCode(0x85)}1`, name: "Broken" }, { id: "ok", name: "Ok" }],
      truncated: false,
    });
    expect(out.teams).toEqual([{ id: "ok", name: "Ok" }]);
    expect(UiSafeLinearTeamListSchema.safeParse(out).success).toBe(true);
  });

  it("⛔ a list that is not ready carries NO teams", () => {
    expect(toUiSafeLinearTeamList({ status: "writes_off", teams: [{ id: "t1", name: "Core" }], truncated: false })).toEqual({
      status: "writes_off",
      teams: [],
      truncated: false,
    });
  });

  it("keeps at most 100 teams and then says it truncated", () => {
    const teams = Array.from({ length: 120 }, (_, i) => ({ id: `t${i}`, name: `Team ${i}` }));
    const out = toUiSafeLinearTeamList({ status: "ready", teams, truncated: false });
    expect(out.teams).toHaveLength(100);
    expect(out.truncated).toBe(true);
    expect(UiSafeLinearTeamListSchema.safeParse(out).success).toBe(true);
  });
});

describe("toUiSafeLinearProposalResult", () => {
  it("copies the outcome, and projects the card itself (actor and payload hash never cross)", () => {
    const approval = {
      id: "idem_new",
      actionRef: "act",
      subjectKind: "external_action",
      workspaceId: "employer-work",
      status: "pending",
      actor: "owner-form",
      channel: "mac",
      payloadHash: "sha256:SECRET",
    } as unknown as Approval;
    const out = toUiSafeLinearProposalResult({ outcome: "created", approval, ...({ title: "T", payload: { teamId: "x" } } as object) });
    expect(out).toEqual({
      outcome: "created",
      approval: { id: "idem_new", actionRef: "act", subjectKind: "external_action", workspaceId: "employer-work", status: "pending", channel: "mac", targetSystem: "linear" },
    });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(UiSafeLinearProposalResultSchema.safeParse(out).success).toBe(true);
  });
  it("carries no card for an outcome that created none", () => {
    expect(toUiSafeLinearProposalResult({ outcome: "writes_off" })).toEqual({ outcome: "writes_off" });
  });
});

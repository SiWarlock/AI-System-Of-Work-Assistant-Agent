// The UI-safe projection of an approval's details and of a "Send now" result. Linear slice 3+4, step 4c.
//
// ⛔ This projector is the ONE place an external action's own content (its title and description) becomes
// renderer-visible. It copies NAMED fields only — never a spread — so anything else on its source (the raw payload,
// a team id, an assignee, a due date, a key) cannot ride out. The workspace check that decides WHETHER to serve
// details at all lives in the port (step 4d); this file pins the SHAPE.
import { describe, it, expect } from "vitest";
import { UiSafeApprovalDetailSchema, UiSafeSendNowResultSchema, UI_SAFE_ALLOWLIST } from "@sow/contracts";
import { toUiSafeApprovalDetail, toUiSafeSendNowResult, type ApprovalDetailSource } from "../../src/api/projections/uiSafe";

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

// The Linear issue FORM's port (Linear slice 5a, part 3): the active workspace's teams, and proposing an issue.
//
// Owner decisions 2026-09-25: the form lives on the Approvals page, and its team list is read from Linear ONLY when
// Linear writes are on for the workspace. So `armedFor("linear", ws)` is checked BEFORE the team lister is touched,
// and a proposal is made only for a team the worker itself read from that workspace's Linear (rule 4). The proposal
// rides the existing Copilot path (`proposeCopilotAction` → the approvals sink), so the card and its saved action are
// exactly what the Approvals screen already dispatches — every Linear write still needs the owner's Approve.
import { describe, it, expect, vi } from "vitest";
import { ok, err, failure } from "@sow/contracts";
import type { Approval, FailureVariant, ProposedAction, ExternalWriteEnvelope, Result, Workspace } from "@sow/contracts";
import type { ApprovalRepository, WorkspaceConfigRepository, DbError } from "@sow/db";
import { createLinearIssuePort, LINEAR_FORM_ACTOR } from "../../src/composition/linearIssue";
import { MAX_PROPOSE_PAYLOAD_CHARS, type CopilotProposeSink, type CopilotProposeReceipt } from "../../src/api/procedures/copilotPropose";
import type { LinearTeamsOutcome } from "../../src/composition/backends";

const WS = "employer-work";
const DRAFT = "3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f";
const nf = { code: "not_found", message: "nf" } as DbError;

function workspaceConfig(known: readonly string[] = [WS]): WorkspaceConfigRepository {
  return {
    get: async (id: unknown) => (known.includes(String(id)) ? ok({ id } as unknown as Workspace) : err(nf)),
  } as unknown as WorkspaceConfigRepository;
}
function approvalsRepo(card?: Approval): ApprovalRepository & { get: ReturnType<typeof vi.fn> } {
  return { get: vi.fn(async () => (card !== undefined ? ok(card) : err(nf))) } as unknown as ApprovalRepository & { get: ReturnType<typeof vi.fn> };
}
const CARD: Approval = {
  id: "idem_new",
  actionRef: "act_new",
  subjectKind: "external_action",
  workspaceId: WS,
  status: "pending",
  actor: LINEAR_FORM_ACTOR,
  channel: "mac",
  payloadHash: "sha256:x",
  expiresAt: "2026-10-02T00:00:00.000Z",
} as unknown as Approval;

type Recorded = { action: ProposedAction; envelope: ExternalWriteEnvelope; workspaceId: string };
function sink(answer: () => Result<CopilotProposeReceipt, FailureVariant> = () => ok({ approvalRef: "idem_new", created: true })): CopilotProposeSink & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    record: async (input) => {
      calls.push({ action: input.action, envelope: input.envelope, workspaceId: String(input.workspaceId) });
      return answer();
    },
  };
}
const TEAMS: LinearTeamsOutcome = { ok: true, teams: [{ id: "t-core", name: "Core Platform" }, { id: "t-mob", name: "Mobile" }], hasMore: false };
function lister(outcome: LinearTeamsOutcome = TEAMS): ReturnType<typeof vi.fn> & ((ws: string) => Promise<LinearTeamsOutcome>) {
  return vi.fn(async () => outcome) as unknown as ReturnType<typeof vi.fn> & ((ws: string) => Promise<LinearTeamsOutcome>);
}
const armed = (ws: readonly string[] = [WS]) => (t: string, w: string): boolean => t === "linear" && ws.includes(w);
const off = (): boolean => false;
const FORM = { workspaceId: WS, draftId: DRAFT, teamId: "t-core", title: "  Fix the login loop  ", description: "Users bounce.", priority: 2 };

function port(over: Partial<Parameters<typeof createLinearIssuePort>[0]> = {}) {
  const deps = {
    workspaceConfig: workspaceConfig(),
    approvals: approvalsRepo(CARD),
    armedFor: armed(),
    listLinearTeams: lister(),
    sink: sink(),
    ...over,
  };
  return { deps, p: createLinearIssuePort(deps) };
}

describe("teams — the active workspace's Linear teams, read only while Linear writes are on", () => {
  it("⛔ writes OFF: says so as a value, and the lister is NEVER called (no Linear call, no key read)", async () => {
    const { deps, p } = port({ armedFor: off });
    expect(await p.teams({ workspaceId: WS })).toEqual(ok({ status: "writes_off", teams: [], truncated: false }));
    expect(deps.listLinearTeams).not.toHaveBeenCalled();
  });

  it("armed: reads THIS workspace's teams and projects them", async () => {
    const { deps, p } = port();
    expect(await p.teams({ workspaceId: WS })).toEqual(
      ok({ status: "ready", teams: [{ id: "t-core", name: "Core Platform" }, { id: "t-mob", name: "Mobile" }], truncated: false }),
    );
    expect(deps.listLinearTeams).toHaveBeenCalledWith(WS);
  });

  it("says when Linear had more teams than one page", async () => {
    const { p } = port({ listLinearTeams: lister({ ok: true, teams: [{ id: "t", name: "T" }], hasMore: true }) });
    const r = await p.teams({ workspaceId: WS });
    expect(r.ok && r.value.truncated).toBe(true);
  });

  it("a workspace whose key did not resolve reads as writes OFF; a failed read is 'unavailable', never an empty list", async () => {
    const notArmed = port({ listLinearTeams: lister({ ok: false, reason: "not_armed_for_workspace" }) });
    expect(await notArmed.p.teams({ workspaceId: WS })).toEqual(ok({ status: "writes_off", teams: [], truncated: false }));
    for (const reason of ["unreachable", "rejected", "malformed"] as const) {
      const { p } = port({ listLinearTeams: lister({ ok: false, reason }) });
      expect(await p.teams({ workspaceId: WS })).toEqual(ok({ status: "unavailable", teams: [], truncated: false }));
    }
  });

  it("an unknown workspace is an error, and nothing is read", async () => {
    const { deps, p } = port();
    const r = await p.teams({ workspaceId: "nope" });
    expect(r.ok).toBe(false);
    expect(deps.listLinearTeams).not.toHaveBeenCalled();
  });
});

describe("propose — one Linear issue from the form, as a PENDING card that still needs Approve", () => {
  it("creates the card through the existing sink and returns its UI-safe record", async () => {
    const s = sink();
    const { p } = port({ sink: s });
    const r = await p.propose(FORM);
    expect(r).toEqual(
      ok({
        outcome: "created",
        approval: { id: "idem_new", actionRef: "act_new", subjectKind: "external_action", workspaceId: WS, status: "pending", channel: "mac", expiresAt: "2026-10-02T00:00:00.000Z", targetSystem: "linear" },
      }),
    );
    expect(s.calls).toHaveLength(1);
    const { action, workspaceId } = s.calls[0] as Recorded;
    expect(workspaceId).toBe(WS);
    expect(action.targetSystem).toBe("linear");
    // The team NAME is the worker's own, from the list it read — and REQ-F-017: no owner, no date.
    expect(action.payload).toEqual({ teamId: "t-core", teamName: "Core Platform", title: "Fix the login loop", description: "Users bounce.", priority: 2 });
  });

  it("⛔ writes OFF: nothing is read and nothing is proposed", async () => {
    const s = sink();
    const { deps, p } = port({ armedFor: off, sink: s });
    expect(await p.propose(FORM)).toEqual(ok({ outcome: "writes_off" }));
    expect(deps.listLinearTeams).not.toHaveBeenCalled();
    expect(s.calls).toHaveLength(0);
  });

  it("⛔ rule 4: a team that is not in THIS workspace's Linear is refused — never trusted from the form", async () => {
    const s = sink();
    const { p } = port({ sink: s });
    expect(await p.propose({ ...FORM, teamId: "t-from-another-workspace" })).toEqual(ok({ outcome: "unknown_team" }));
    expect(s.calls).toHaveLength(0);
  });

  it("a failed team read proposes nothing ('unavailable'); a workspace without a key is 'writes_off'", async () => {
    const s1 = sink();
    expect(await port({ sink: s1, listLinearTeams: lister({ ok: false, reason: "unreachable" }) }).p.propose(FORM)).toEqual(ok({ outcome: "unavailable" }));
    const s2 = sink();
    expect(await port({ sink: s2, listLinearTeams: lister({ ok: false, reason: "not_armed_for_workspace" }) }).p.propose(FORM)).toEqual(ok({ outcome: "writes_off" }));
    expect(s1.calls.length + s2.calls.length).toBe(0);
  });

  it("⛔ rule 3 keys: the workspace and the form's draft are in the identity — different drafts or workspaces never collide", async () => {
    const s = sink();
    const both = port({ sink: s, workspaceConfig: workspaceConfig([WS, "personal-life"]), armedFor: armed([WS, "personal-life"]) });
    await both.p.propose(FORM);
    await both.p.propose({ ...FORM, draftId: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" });
    await both.p.propose({ ...FORM, workspaceId: "personal-life" });
    await both.p.propose(FORM); // the same form submitted twice
    const keys = s.calls.map((c) => c.action.idempotencyKey);
    expect(new Set(keys.slice(0, 3)).size).toBe(3);
    expect(keys[3]).toBe(keys[0]);
    // …and the envelope is linkage-pinned to its action (the sink's own contract).
    for (const c of s.calls) expect(c.envelope.idempotencyKey).toBe(c.action.idempotencyKey);
  });

  it("⛔ a spent draft whose card was already DECIDED answers 'already_decided' — never 'approve it below'", async () => {
    const decided = { ...CARD, status: "approved" } as unknown as Approval;
    const { p } = port({ sink: sink(() => ok({ approvalRef: "idem_new", created: false })), approvals: approvalsRepo(decided) });
    expect(await p.propose(FORM)).toEqual(ok({ outcome: "already_decided" }));
  });

  it("the same form submitted again with the same content answers 'already_pending' with the existing card", async () => {
    const { p } = port({ sink: sink(() => ok({ approvalRef: "idem_new", created: false })) });
    const r = await p.propose(FORM);
    expect(r.ok && r.value.outcome).toBe("already_pending");
    expect(r.ok && r.value.approval?.id).toBe("idem_new");
  });

  it("maps the sink's refusals onto the closed outcomes, and never guesses", async () => {
    const refuse = (code: string) => () => err(failure("validation_rejected", "x", { cause: { code } }));
    const cases: [string, string][] = [
      ["COPILOT_PROPOSE_PAYLOAD_CONFLICT", "conflict"],
      ["COPILOT_PROPOSE_SAVED_FOR_OTHER_CARD", "conflict"],
      ["COPILOT_PROPOSE_OUTBOX_UNAVAILABLE", "unavailable"],
      ["COPILOT_PROPOSE_SINK_THREW", "unavailable"],
      ["SOMETHING_NEW", "unavailable"],
    ];
    for (const [code, outcome] of cases) {
      const r = await port({ sink: sink(refuse(code) as () => Result<CopilotProposeReceipt, FailureVariant>) }).p.propose(FORM);
      expect(r, code).toEqual(ok({ outcome }));
    }
  });

  it("a payload over the propose bound is 'invalid_input' and never reaches the sink", async () => {
    const s = sink();
    // Each quote escapes to two characters once serialized, so this many is twice the bound (the port is called
    // directly here, past the router's own 20,000-character check).
    expect(await port({ sink: s }).p.propose({ ...FORM, description: '"'.repeat(MAX_PROPOSE_PAYLOAD_CHARS) })).toEqual(ok({ outcome: "invalid_input" }));
    expect(s.calls).toHaveLength(0);
  });

  it("⛔ the LONGEST description the form allows is never refused by the propose bound, even at worst-case escaping", async () => {
    // The payload bound must fit the 20,000-character limit when every character escapes to SIX (a control character
    // serializes as a 6-character escape; the review of 2026-09-25 measured the old two-per-character claim as wrong).
    const s = sink();
    expect(await port({ sink: s }).p.propose({ ...FORM, description: String.fromCharCode(1).repeat(20000) })).toEqual(
      ok(expect.objectContaining({ outcome: "created" })),
    );
    expect(s.calls).toHaveLength(1);
  });

  it("⛔ a re-submitted draft whose card cannot be read back is 'unavailable' — never a guessed 'already_pending'", async () => {
    // The sink answers created:false for a card in ANY state, so without the card its status is unknown (critic, measured).
    const { p } = port({ sink: sink(() => ok({ approvalRef: "idem_new", created: false })), approvals: approvalsRepo(undefined) });
    expect(await p.propose(FORM)).toEqual(ok({ outcome: "unavailable" }));
  });

  it("a card that was created but cannot be read back still reports the outcome, without a card", async () => {
    const { p } = port({ approvals: approvalsRepo(undefined) });
    expect(await p.propose(FORM)).toEqual(ok({ outcome: "created" }));
  });

  it("an unknown workspace is an error, and nothing is read or proposed", async () => {
    const s = sink();
    const { deps, p } = port({ sink: s });
    expect((await p.propose({ ...FORM, workspaceId: "nope" })).ok).toBe(false);
    expect(deps.listLinearTeams).not.toHaveBeenCalled();
    expect(s.calls).toHaveLength(0);
  });
});

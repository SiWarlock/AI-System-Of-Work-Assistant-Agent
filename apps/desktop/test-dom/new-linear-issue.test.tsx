// @vitest-environment jsdom
//
// Linear slice 5a, part 4 — the "New Linear issue" form on the Approvals page (owner decisions 2026-09-25).
//
// The form proposes ONE Linear issue in the ACTIVE workspace; the result is a PENDING card the owner must still
// approve. Its team list comes from Linear only while Linear writes are on — while off, the form says so and cannot
// submit. ⛔ REQ-F-017: the form has no owner and no date. ⛔ Rule 3: the form mints ONE draft id when it opens and
// keeps it until a proposal lands, so a retry after a failure is the SAME proposal, never a second issue.
import { describe, it, expect, afterEach, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";
import { Approvals } from "../renderer/surfaces/approvals/Approvals";
import type { LinearTeamsResult, ProposeLinearIssueResult, LinearIssueDraft } from "../renderer/lib/linear-issue";
import type { UiSafeApproval } from "@sow/contracts/api/ui-safe";

afterEach(cleanup);

const EMP = "employer-work";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READY: LinearTeamsResult = { ok: true, list: { status: "ready", teams: [{ id: "t-core", name: "Core Platform" }, { id: "t-mob", name: "Mobile" }], truncated: false } };
const CREATED: ProposeLinearIssueResult = {
  ok: true,
  result: { outcome: "created", approval: { id: "idem_new", status: "pending", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: EMP } },
};
const decide = async () => "applied" as const;

function page(over: { teams?: () => Promise<LinearTeamsResult>; propose?: (d: LinearIssueDraft) => Promise<ProposeLinearIssueResult>; active?: string | null } = {}) {
  const onLoadLinearTeams = vi.fn(over.teams ?? (async () => READY));
  const onProposeLinearIssue = vi.fn(over.propose ?? (async () => CREATED));
  const uiWith = (approvals: readonly UiSafeApproval[]) => (
    <Approvals
      approvals={approvals}
      onDecide={decide}
      activeWorkspaceId={over.active === undefined ? EMP : over.active}
      onLoadLinearTeams={onLoadLinearTeams}
      onProposeLinearIssue={onProposeLinearIssue}
    />
  );
  return { onLoadLinearTeams, onProposeLinearIssue, ui: uiWith([]), uiWith };
}
/** The new card as the App folds it into the inbox after a proposal (nothing publishes approval.update). */
const NEW_CARD: UiSafeApproval = { id: "idem_new", status: "pending", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: EMP };
async function openForm(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole("button", { name: "New Linear issue" }));
  await act(async () => {});
  return screen.getByRole("form", { name: "New Linear issue" });
}
function fill(form: HTMLElement, title: string, description = ""): void {
  fireEvent.change(within(form).getByLabelText("Title"), { target: { value: title } });
  fireEvent.change(within(form).getByLabelText("Description"), { target: { value: description } });
}
const submitButton = (form: HTMLElement): HTMLButtonElement => within(form).getByRole("button", { name: "Propose issue" }) as HTMLButtonElement;

describe("the New Linear issue form — where it appears", () => {
  it("is offered only with an active workspace and a live worker", () => {
    const withNone = page({ active: null });
    const { rerender } = render(withNone.ui);
    expect(screen.queryByRole("button", { name: "New Linear issue" })).toBeNull(); // Global scope: no workspace to propose in
    rerender(<Approvals approvals={[]} onDecide={decide} activeWorkspaceId={EMP} />);
    expect(screen.queryByRole("button", { name: "New Linear issue" })).toBeNull(); // no live worker
    rerender(page().ui);
    const btn = screen.getByRole("button", { name: "New Linear issue" });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBeTruthy();
  });

  it("⛔ REQ-F-017: the form has no owner and no date — only team, title, description and priority", async () => {
    render(page().ui);
    const form = await openForm();
    for (const label of ["Team", "Title", "Description", "Priority"]) expect(within(form).getByLabelText(label)).toBeTruthy();
    for (const absent of [/assignee/i, /owner/i, /due/i, /date/i]) expect(within(form).queryByLabelText(absent)).toBeNull();
    expect(within(form).getByLabelText("Title").getAttribute("maxlength")).toBe("255");
    expect(within(form).getByLabelText("Description").getAttribute("maxlength")).toBe("8000");
  });
});

describe("the team list", () => {
  it("loads when the form opens, and offers the workspace's teams", async () => {
    const p = page();
    render(p.ui);
    const form = await openForm();
    expect(p.onLoadLinearTeams).toHaveBeenCalledTimes(1);
    const team = within(form).getByLabelText("Team") as HTMLSelectElement;
    expect([...team.options].map((o) => o.textContent)).toEqual(["Core Platform", "Mobile"]);
  });

  it("⛔ writes OFF: says so, offers no team, and cannot submit", async () => {
    render(page({ teams: async () => ({ ok: true, list: { status: "writes_off", teams: [], truncated: false } }) }).ui);
    const form = await openForm();
    expect(within(form).getByText(/Linear writes are off for this workspace/)).toBeTruthy();
    expect(within(form).queryByLabelText("Team")).toBeNull();
    fill(form, "Fix it");
    expect(submitButton(form).disabled).toBe(true);
  });

  it("a failed load says so and can be retried", async () => {
    const answers: LinearTeamsResult[] = [{ ok: false }, READY];
    const p = page({ teams: async () => answers.shift() ?? { ok: false } });
    render(p.ui);
    const form = await openForm();
    expect(within(form).getByText("Couldn't load the teams from Linear")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(within(form).getByLabelText("Team")).toBeTruthy();
    expect(p.onLoadLinearTeams).toHaveBeenCalledTimes(2);
  });

  it("⛔ the worker's own 'unavailable' answer (Linear unreachable) says so and offers Retry — not 'no teams'", async () => {
    render(page({ teams: async () => ({ ok: true, list: { status: "unavailable", teams: [], truncated: false } }) }).ui);
    const form = await openForm();
    expect(within(form).getByText("Couldn't load the teams from Linear")).toBeTruthy();
    expect(within(form).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(within(form).queryByText(/No teams were found/)).toBeNull();
  });

  it("⛔ a 'writes_off' list that wrongly carries teams still offers no team and cannot submit", async () => {
    // The worker's projector AND the contract refuse such a list (slice-5a review); the form must not rely on either.
    render(page({ teams: async () => ({ ok: true, list: { status: "writes_off", teams: [{ id: "t-core", name: "Core" }], truncated: false } }) }).ui);
    const form = await openForm();
    expect(within(form).queryByLabelText("Team")).toBeNull();
    fill(form, "Fix it");
    expect(submitButton(form).disabled).toBe(true);
  });

  it("says when Linear has more teams than it shows", async () => {
    render(page({ teams: async () => ({ ok: true, list: { status: "ready", teams: [{ id: "t", name: "T" }], truncated: true } }) }).ui);
    const form = await openForm();
    expect(within(form).getByText("Showing the first 100 teams")).toBeTruthy();
  });
});

describe("proposing", () => {
  it("sends the draft — one id minted at open, the chosen team, the fields — and says what to do next", async () => {
    const p = page();
    const { rerender } = render(p.ui);
    const form = await openForm();
    fireEvent.change(within(form).getByLabelText("Team"), { target: { value: "t-mob" } });
    fireEvent.change(within(form).getByLabelText("Priority"), { target: { value: "2" } });
    fill(form, "Fix the login loop", "Users bounce.");
    fireEvent.click(submitButton(form));
    await act(async () => {});
    expect(p.onProposeLinearIssue).toHaveBeenCalledTimes(1);
    const draft = p.onProposeLinearIssue.mock.calls[0]?.[0] as LinearIssueDraft;
    expect(draft).toEqual({ draftId: expect.stringMatching(UUID), teamId: "t-mob", title: "Fix the login loop", description: "Users bounce.", priority: 2 });
    expect(Object.keys(draft).sort()).toEqual(["description", "draftId", "priority", "teamId", "title"]); // no workspace: the App adds the active one
    // The form closes; once the App has folded the new card in, the page says it needs approval.
    expect(screen.queryByRole("form", { name: "New Linear issue" })).toBeNull();
    rerender(p.uiWith([NEW_CARD]));
    expect(screen.getByText(/Proposed.*approve it below/i)).toBeTruthy();
  });

  it("a blank title cannot be submitted", async () => {
    render(page().ui);
    const form = await openForm();
    fill(form, "   ");
    expect(submitButton(form).disabled).toBe(true);
  });

  it("two clicks before the screen re-renders propose ONCE", async () => {
    const p = page({ propose: () => new Promise<never>(() => {}) });
    render(p.ui);
    const form = await openForm();
    fill(form, "Fix it");
    const btn = submitButton(form);
    act(() => {
      btn.click();
      btn.click();
    });
    expect(p.onProposeLinearIssue).toHaveBeenCalledTimes(1);
  });

  it("⛔ rule 3: a retry after a failure is the SAME draft; after a proposal lands, the next one is a NEW draft", async () => {
    const answers: ProposeLinearIssueResult[] = [{ ok: false }, CREATED, CREATED];
    const p = page({ propose: async () => answers.shift() ?? { ok: false } });
    render(p.ui);
    let form = await openForm();
    fill(form, "Fix it");
    fireEvent.click(submitButton(form));
    await act(async () => {});
    expect(within(form).getByText("Couldn't create the proposal — try again")).toBeTruthy();
    fireEvent.click(submitButton(form));
    await act(async () => {});
    form = await openForm();
    fill(form, "Another issue");
    fireEvent.click(submitButton(form));
    await act(async () => {});
    const ids = p.onProposeLinearIssue.mock.calls.map((c) => (c[0] as LinearIssueDraft).draftId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("after 'unknown_team', the teams really are reloaded and the new list is offered", async () => {
    const lists: LinearTeamsResult[] = [READY, { ok: true, list: { status: "ready", teams: [{ id: "t-new", name: "Newly made" }], truncated: false } }];
    const p = page({ teams: async () => lists.shift() ?? READY, propose: async () => ({ ok: true, result: { outcome: "unknown_team" } }) });
    render(p.ui);
    const form = await openForm();
    fill(form, "Fix it");
    fireEvent.click(submitButton(form));
    await act(async () => {});
    expect(p.onLoadLinearTeams).toHaveBeenCalledTimes(2);
    const team = within(form).getByLabelText("Team") as HTMLSelectElement;
    expect([...team.options].map((o) => o.textContent)).toEqual(["Newly made"]);
    expect(team.value).toBe("t-new");
  });

  it("⛔ a slow team list for a form that was CLOSED never overwrites the list of the form reopened since", async () => {
    let first: (v: LinearTeamsResult) => void = () => {};
    const answers: (() => Promise<LinearTeamsResult>)[] = [() => new Promise<LinearTeamsResult>((r) => (first = r)), async () => READY];
    const p = page({ teams: () => (answers.shift() ?? (async () => READY))() });
    render(p.ui);
    await openForm(); // load 1: still pending
    fireEvent.click(screen.getByRole("button", { name: "New Linear issue" })); // close
    const form = await openForm(); // load 2: ready
    await act(async () => first({ ok: false })); // load 1 answers LAST, with a failure
    expect(within(form).getByLabelText("Team")).toBeTruthy();
    expect(within(form).queryByText("Couldn't load the teams from Linear")).toBeNull();
  });

  it("says honestly why nothing was proposed, for each outcome", async () => {
    const cases: [string, RegExp][] = [
      ["invalid_input", /Check the title and description/],
      ["writes_off", /Linear writes are off for this workspace/],
      ["unknown_team", /That team is no longer in Linear/],
      ["conflict", /already sent with different content/],
      ["already_decided", /already proposed, and that card has been decided/],
      ["unavailable", /Couldn't create the proposal — try again/],
    ];
    for (const [outcome, text] of cases) {
      const p = page({ propose: async () => ({ ok: true, result: { outcome } }) as ProposeLinearIssueResult });
      const { unmount } = render(p.ui);
      const form = await openForm();
      fill(form, "Fix it");
      fireEvent.click(submitButton(form));
      await act(async () => {});
      expect(within(form).getByText(text), outcome).toBeTruthy();
      unmount();
    }
  });

  it("after 'already_decided', the next submit is a NEW draft (the old one is spent)", async () => {
    const answers: ProposeLinearIssueResult[] = [{ ok: true, result: { outcome: "already_decided" } }, CREATED];
    const p = page({ propose: async () => answers.shift() ?? { ok: false } });
    render(p.ui);
    const form = await openForm();
    fill(form, "Fix it");
    fireEvent.click(submitButton(form));
    await act(async () => {});
    fireEvent.click(submitButton(form));
    await act(async () => {});
    const ids = p.onProposeLinearIssue.mock.calls.map((c) => (c[0] as LinearIssueDraft).draftId);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("'Approve it below' disappears once that card is no longer pending", async () => {
    const p = page();
    const pendingCard = { id: "idem_new", status: "pending" as const, channel: "mac" as const, subjectKind: "external_action" as const, targetSystem: "linear" as const, workspaceId: EMP };
    const { rerender } = render(p.ui);
    const form = await openForm();
    fill(form, "Fix it");
    fireEvent.click(submitButton(form));
    await act(async () => {});
    const props = { onDecide: decide, activeWorkspaceId: EMP, onLoadLinearTeams: p.onLoadLinearTeams, onProposeLinearIssue: p.onProposeLinearIssue };
    rerender(<Approvals approvals={[pendingCard]} {...props} />);
    expect(screen.getByText(/Proposed.*approve it below/i)).toBeTruthy();
    rerender(<Approvals approvals={[{ ...pendingCard, status: "approved" }]} {...props} />);
    expect(screen.queryByText(/approve it below/i)).toBeNull();
  });

  it("after 'conflict', the next submit is a NEW draft (the old one is spent)", async () => {
    const answers: ProposeLinearIssueResult[] = [{ ok: true, result: { outcome: "conflict" } }, CREATED];
    const p = page({ propose: async () => answers.shift() ?? { ok: false } });
    render(p.ui);
    const form = await openForm();
    fill(form, "Fix it");
    fireEvent.click(submitButton(form));
    await act(async () => {});
    fireEvent.click(submitButton(form));
    await act(async () => {});
    const ids = p.onProposeLinearIssue.mock.calls.map((c) => (c[0] as LinearIssueDraft).draftId);
    expect(ids[1]).not.toBe(ids[0]);
  });

  it("⛔ works under StrictMode (the dev build the owner runs)", async () => {
    const p = page();
    const { rerender } = render(<StrictMode>{p.ui}</StrictMode>);
    const form = await openForm();
    expect(within(form).getByLabelText("Team")).toBeTruthy();
    fill(form, "Fix it");
    fireEvent.click(submitButton(form));
    await act(async () => {});
    rerender(<StrictMode>{p.uiWith([NEW_CARD])}</StrictMode>);
    expect(screen.getByText(/Proposed.*approve it below/i)).toBeTruthy();
  });

  it("⛔ WS-8: switching the active workspace closes the form and drops its teams", async () => {
    const p = page();
    const { rerender } = render(p.ui);
    await openForm();
    expect(screen.getByText("Core Platform")).toBeTruthy();
    rerender(<Approvals approvals={[]} onDecide={decide} activeWorkspaceId="personal-life" onLoadLinearTeams={p.onLoadLinearTeams} onProposeLinearIssue={p.onProposeLinearIssue} />);
    expect(screen.queryByRole("form", { name: "New Linear issue" })).toBeNull();
    expect(screen.queryByText("Core Platform")).toBeNull();
  });
});

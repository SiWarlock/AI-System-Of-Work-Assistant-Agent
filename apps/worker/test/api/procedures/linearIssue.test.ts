// The Linear issue FORM's router (Linear slice 5a, part 3): `linearIssue.teams` and `linearIssue.propose`.
//
// The router authenticates, validates the form at the boundary, and re-checks every output against its UI-safe
// contract. A bad field is DATA (`outcome: "invalid_input"`), not a thrown internal error, so the form can say what
// happened (grounding 2026-09-25: approvalSend's throwing parser would make a bad priority look like a worker crash).
// ⛔ REQ-F-017: the form has no owner and no date — an input that carries one is refused, not dropped silently.
import { describe, it, expect, vi } from "vitest";
import { ok, err, failure } from "@sow/contracts";
import type { UiSafeLinearProposalResult, UiSafeLinearTeamList } from "@sow/contracts";
import {
  buildLinearIssueRouter,
  UNAVAILABLE_LINEAR_ISSUE_PORT,
  MAX_LINEAR_TITLE,
  MAX_LINEAR_DESCRIPTION,
  type LinearIssuePort,
} from "../../../src/api/procedures/linearIssue";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import type { AuthedContext } from "../../../src/api/auth/sessionAuth";

const AUTHED: ApiContext = { auth: ok<AuthedContext>({ authenticated: true }) };
const UNAUTHED: ApiContext = { auth: err(failure("validation_rejected", "unauthenticated", { cause: { code: "UNAUTHORIZED" } })) };
const WS = "employer-work";
const FORM = { workspaceId: WS, draftId: "3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f", teamId: "t-core", title: "Fix the login loop", description: "Users bounce.", priority: 2 };

function fakePort(over: Partial<LinearIssuePort> = {}): LinearIssuePort & { teams: ReturnType<typeof vi.fn>; propose: ReturnType<typeof vi.fn> } {
  return {
    teams: vi.fn(async () => ok<UiSafeLinearTeamList>({ status: "ready", teams: [{ id: "t-core", name: "Core" }], truncated: false })),
    propose: vi.fn(async () => ok<UiSafeLinearProposalResult>({ outcome: "created" })),
    ...over,
  } as LinearIssuePort & { teams: ReturnType<typeof vi.fn>; propose: ReturnType<typeof vi.fn> };
}
function caller(port: LinearIssuePort, ctx: ApiContext = AUTHED) {
  return createCallerFactory(router({ linearIssue: buildLinearIssueRouter({ linearIssue: port }) }))(ctx);
}

describe("linearIssue router — auth, fail-closed port, and output re-check", () => {
  it("an unauthenticated call is refused and the port is never reached", async () => {
    const port = fakePort();
    const c = caller(port, UNAUTHED);
    expect((await c.linearIssue.teams({ workspaceId: WS })).ok).toBe(false);
    expect((await c.linearIssue.propose(FORM)).ok).toBe(false);
    expect(port.teams).not.toHaveBeenCalled();
    expect(port.propose).not.toHaveBeenCalled();
  });

  it("with no real port bound, every call fails closed — nothing is ever faked", async () => {
    const c = caller(UNAVAILABLE_LINEAR_ISSUE_PORT);
    for (const r of [await c.linearIssue.teams({ workspaceId: WS }), await c.linearIssue.propose(FORM)]) {
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.cause?.code).toBe("LINEAR_ISSUE_UNAVAILABLE");
    }
  });

  it("⛔ a port answer that breaks its contract becomes an error, never a leak", async () => {
    const leaky = fakePort({
      teams: vi.fn(async () => ok({ status: "ready", teams: [{ id: "t", name: "T", key: "SECRET" }], truncated: false } as unknown as UiSafeLinearTeamList)),
      propose: vi.fn(async () => ok({ outcome: "created", title: "echoed content" } as unknown as UiSafeLinearProposalResult)),
    });
    const c = caller(leaky);
    for (const r of [await c.linearIssue.teams({ workspaceId: WS }), await c.linearIssue.propose(FORM)]) {
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.cause?.code).toBe("LINEAR_ISSUE_UNSERVABLE");
    }
  });

  it("a teams request without a workspace is a typed refusal, and the port is not reached", async () => {
    const port = fakePort();
    for (const bad of [{}, { workspaceId: "" }, { workspaceId: 7 }, null]) {
      const r = await caller(port).linearIssue.teams(bad as never);
      expect(r.ok).toBe(false);
    }
    expect(port.teams).not.toHaveBeenCalled();
  });
});

describe("linearIssue.propose — the form is validated at the boundary; a bad field is DATA", () => {
  it("a valid form reaches the port unchanged", async () => {
    const port = fakePort();
    expect(await caller(port).linearIssue.propose(FORM)).toEqual(ok({ outcome: "created" }));
    expect(port.propose).toHaveBeenCalledWith(FORM);
  });

  it("an empty description is allowed; priority 0 (no priority) is allowed", async () => {
    const port = fakePort();
    await caller(port).linearIssue.propose({ ...FORM, description: "", priority: 0 });
    expect(port.propose).toHaveBeenCalledTimes(1);
  });

  it("every out-of-bounds field is 'invalid_input', and the port is never reached", async () => {
    const port = fakePort();
    const bad: unknown[] = [
      null,
      "form",
      { ...FORM, title: "   " },
      { ...FORM, title: "two\nlines" },
      { ...FORM, title: "x".repeat(MAX_LINEAR_TITLE + 1) },
      { ...FORM, description: "x".repeat(MAX_LINEAR_DESCRIPTION + 1) },
      { ...FORM, description: 7 },
      { ...FORM, priority: 5 },
      { ...FORM, priority: -1 },
      { ...FORM, priority: 1.5 },
      { ...FORM, priority: "2" },
      { ...FORM, draftId: "not-a-uuid" },
      { ...FORM, draftId: undefined },
      { ...FORM, teamId: "" },
      { ...FORM, teamId: "x".repeat(65) },
      { ...FORM, workspaceId: "" },
      // ⛔ REQ-F-017 — the form has no owner and no date; one that carries them is refused, not silently dropped.
      { ...FORM, assigneeId: "user-1" },
      { ...FORM, dueDate: "2026-12-01" },
    ];
    for (const b of bad) {
      expect(await caller(port).linearIssue.propose(b as never), JSON.stringify(b)?.slice(0, 80)).toEqual(ok({ outcome: "invalid_input" }));
    }
    expect(port.propose).not.toHaveBeenCalled();
  });

  it("the bounds are what the form enforces too", () => {
    expect(MAX_LINEAR_TITLE).toBe(255);
    expect(MAX_LINEAR_DESCRIPTION).toBe(8000);
  });
});

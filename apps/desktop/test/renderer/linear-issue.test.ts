// Linear slice 5a, part 4 — the renderer callers for the Linear issue form (`linearIssue.teams` / `.propose`). The
// renderer only REQUESTS, always for the ACTIVE scope's workspace (the App decides that). Worker output is candidate
// data here too: an error, a thrown transport, and an ok value that fails its UI-safe contract all fold to { ok: false }.
import { describe, it, expect } from "vitest";
import { createLinearTeams, createProposeLinearIssue } from "../../renderer/lib/linear-issue";

function client(impl: { teams?: unknown; propose?: unknown; throws?: boolean }, seen: unknown[] = []): never {
  const answer = (input: unknown, v: unknown) => {
    seen.push(input);
    return impl.throws === true ? Promise.reject(new Error("transport")) : Promise.resolve(v);
  };
  return {
    linearIssue: {
      teams: { query: (input: unknown) => answer(input, impl.teams) },
      propose: { mutate: (input: unknown) => answer(input, impl.propose) },
    },
  } as never;
}
const DRAFT = { draftId: "3f2b8c1e-5d4a-4e7b-9c0d-1a2b3c4d5e6f", teamId: "t-core", title: "Fix it", description: "", priority: 0 };

describe("createLinearTeams", () => {
  it("returns a contract-valid team list, asked for the given workspace", async () => {
    const seen: unknown[] = [];
    const list = { status: "ready", teams: [{ id: "t-core", name: "Core" }], truncated: false };
    expect(await createLinearTeams(client({ teams: { ok: true, value: list } }, seen))("employer-work")).toEqual({ ok: true, list });
    expect(seen).toEqual([{ workspaceId: "employer-work" }]);
  });
  it("⛔ refuses a list that breaks its contract (an extra key on a team, an unknown status)", async () => {
    for (const bad of [
      { status: "ready", teams: [{ id: "t", name: "T", key: "SECRET" }], truncated: false },
      { status: "armed", teams: [], truncated: false },
    ]) {
      expect(await createLinearTeams(client({ teams: { ok: true, value: bad } }))("w")).toEqual({ ok: false });
    }
  });
  it("folds an error result and a thrown transport to { ok: false }", async () => {
    expect(await createLinearTeams(client({ teams: { ok: false, error: { kind: "degraded_unavailable" } } }))("w")).toEqual({ ok: false });
    expect(await createLinearTeams(client({ throws: true }))("w")).toEqual({ ok: false });
  });
});

describe("createProposeLinearIssue", () => {
  it("sends the draft with the given workspace, and returns a contract-valid result", async () => {
    const seen: unknown[] = [];
    const result = { outcome: "created", approval: { id: "idem_new", status: "pending", channel: "mac", subjectKind: "external_action", targetSystem: "linear", workspaceId: "employer-work" } };
    expect(await createProposeLinearIssue(client({ propose: { ok: true, value: result } }, seen))("employer-work", DRAFT)).toEqual({ ok: true, result });
    expect(seen).toEqual([{ workspaceId: "employer-work", ...DRAFT }]);
  });
  it("⛔ refuses a result that echoes content or carries an unknown outcome", async () => {
    for (const bad of [{ outcome: "created", title: "echo" }, { outcome: "sent" }]) {
      expect(await createProposeLinearIssue(client({ propose: { ok: true, value: bad } }))("w", DRAFT)).toEqual({ ok: false });
    }
  });
  it("folds an error result and a thrown transport to { ok: false }", async () => {
    expect(await createProposeLinearIssue(client({ propose: { ok: false, error: { kind: "degraded_unavailable" } } }))("w", DRAFT)).toEqual({ ok: false });
    expect(await createProposeLinearIssue(client({ throws: true }))("w", DRAFT)).toEqual({ ok: false });
  });
});

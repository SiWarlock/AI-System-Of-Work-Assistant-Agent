// The Approvals screen's worker side: an approval's details (ONLY in its own workspace), the approved-but-unsent
// list, and "Send now". Linear slice 3+4, step 4d. Owner decisions 2026-09-22: details on open, same workspace
// only; the card shows the real send state; "Send now" re-runs the same guarded dispatch.
import { describe, it, expect, afterEach } from "vitest";
import { ok, err, failure } from "@sow/contracts";
import type { ProofSpineBackends } from "../../src/composition/backends";
import { createApprovalSendPort } from "../../src/composition/approvalSend";
import { createExternalApprovalSender } from "../../src/composition/externalApprovalDispatch";
import { buildApprovalSendRouter, type ApprovalSendPort } from "../../src/api/procedures/approvalSend";
import { createCallerFactory, router, type ApiContext } from "../../src/api/trpc";
import type { AuthedContext } from "../../src/api/auth/sessionAuth";
import { NOW, WS, OTHER_WS, vendor, backends, propose } from "./_approvalHarness";
import { LINEAR_FORM_ACTOR } from "../../src/composition/linearIssue";

const open: ProofSpineBackends[] = [];
afterEach(() => {
  for (const b of open.splice(0)) b.close();
});

function portFor(b: ProofSpineBackends, withSender = true): ApprovalSendPort {
  const deps = {
    armedFor: b.armedFor,
    outbox: b.repos.outbox,
    workspaceConfig: b.repos.workspaceConfig,
    receiptStore: b.receiptStore,
    writeAdapters: b.writeAdapters,
    audit: async () => {},
    clock: () => NOW,
  };
  return createApprovalSendPort({
    approvals: b.repos.approvals,
    outbox: b.repos.outbox,
    workspaceConfig: b.repos.workspaceConfig,
    armedFor: b.armedFor,
    ...(withSender ? { sender: createExternalApprovalSender(deps) } : {}),
  });
}

describe("detail — ONLY in the approval's own workspace (WS-8)", () => {
  it("serves the title, the description lines, the system and the send state", async () => {
    const b = await backends(open);
    const card = await propose(b, "d1");
    const res = await portFor(b).detail({ workspaceId: String(WS), approvalId: String(card.id) });
    expect(res).toEqual(ok({ approvalId: String(card.id), sendState: "writes_off", targetSystem: "linear", title: "Issue d1", descriptionLines: ["About d1"] }));
  });

  it("⛔ asked from ANOTHER workspace, it answers exactly like a missing card — and carries no content", async () => {
    const b = await backends(open);
    const card = await propose(b, "d2");
    const foreign = await portFor(b).detail({ workspaceId: String(OTHER_WS), approvalId: String(card.id) });
    const missing = await portFor(b).detail({ workspaceId: String(OTHER_WS), approvalId: "idem_does_not_exist" });
    expect(foreign.ok).toBe(false);
    expect(foreign).toEqual(missing);
    expect(JSON.stringify(foreign)).not.toContain("Issue d2");
  });

  it("⛔ a swapped payload is shown as refused, with no content", async () => {
    const b = await backends(open);
    const card = await propose(b, "d3");
    const saved = await b.repos.outbox.getByIdempotencyKey("idem:d3");
    if (!saved.ok) throw new Error("no saved entry");
    await b.repos.outbox.update({ ...saved.value, payloadHash: "hash:OTHER" }); // the saved write is no longer the approved one
    const res = await portFor(b).detail({ workspaceId: String(WS), approvalId: String(card.id) });
    // Not even the system: a refused saved action is not provably this card's, so nothing from it is shown.
    expect(res).toEqual(ok({ approvalId: String(card.id), sendState: "refused", refusal: "payload_mismatch" }));
  });

  it("a saved-action store fault is a degraded error, never a false state", async () => {
    const b = await backends(open);
    const card = await propose(b, "d4");
    const faulty = createApprovalSendPort({
      approvals: b.repos.approvals,
      workspaceConfig: b.repos.workspaceConfig,
      armedFor: b.armedFor,
      outbox: { ...b.repos.outbox, get: async () => err({ code: "unavailable" as const, message: "busy" }) },
    });
    const res = await faulty.detail({ workspaceId: String(WS), approvalId: String(card.id) });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("degraded_unavailable");
  });
});

describe("review follow-ups (2026-09-22) — the payload sent is the payload approved, and the state is honest", () => {
  it("⛔ rule 3: a saved payload changed out of band (hash column untouched) is refused — never shown, never sent", async () => {
    const v = vendor();
    const b = await backends(open, { enabled: true, make: () => v.transport });
    const card = await propose(b, "swap-body");
    const saved = await b.repos.outbox.getByIdempotencyKey("idem:swap-body");
    if (!saved.ok) throw new Error("no saved entry");
    await b.repos.outbox.update({ ...saved.value, payload: { teamId: "team-1", title: "SWAPPED TITLE", description: "SWAPPED BODY" } });
    const input = { workspaceId: String(WS), approvalId: String(card.id) };
    const detail = await portFor(b).detail(input);
    expect(detail).toEqual(ok({ approvalId: String(card.id), sendState: "refused", refusal: "payload_mismatch" }));
    expect(JSON.stringify(detail)).not.toContain("SWAPPED");
    expect(await portFor(b).sendNow(input)).toEqual(ok({ approvalId: String(card.id), sendState: "refused", refusal: "payload_mismatch" }));
    expect(v.calls.filter((c) => c.op === "create")).toHaveLength(0);
  });

  it("⛔ a card the owner REJECTED reads 'not approved' — not 'refused by the vendor' — after its entry is closed", async () => {
    const b = await backends(open);
    const card = await propose(b, "said-no", { status: "rejected" });
    await createExternalApprovalSender({
      armedFor: b.armedFor, outbox: b.repos.outbox, workspaceConfig: b.repos.workspaceConfig, receiptStore: b.receiptStore,
      writeAdapters: b.writeAdapters, audit: async () => {}, clock: () => NOW,
    })(card); // the decide command's dispatch closes the saved entry
    const res = await portFor(b).detail({ workspaceId: String(WS), approvalId: String(card.id) });
    expect(res.ok && res.value.sendState).toBe("not_approved");
  });

  it("a store fault reading the CARD is 'unavailable, retry' — never 'the card does not exist'", async () => {
    const b = await backends(open);
    const card = await propose(b, "busy");
    const faulty = createApprovalSendPort({
      approvals: { ...b.repos.approvals, get: async () => err({ code: "unavailable" as const, message: "busy" }) },
      outbox: b.repos.outbox,
      workspaceConfig: b.repos.workspaceConfig,
      armedFor: b.armedFor,
    });
    const res = await faulty.detail({ workspaceId: String(WS), approvalId: String(card.id) });
    expect(res.ok === false && res.error.kind).toBe("degraded_unavailable");
  });

  it("shows the priority too — Linear sends it, so the owner must see it before approving", async () => {
    const b = await backends(open);
    const card = await propose(b, "prio", { payload: { priority: 2 } });
    const res = await portFor(b).detail({ workspaceId: String(WS), approvalId: String(card.id) });
    expect(res.ok && res.value.priority).toBe(2);
  });

  it("shows the TEAM by name (Linear slice 5a) — the owner sees where the issue goes; never the team id", async () => {
    const b = await backends(open);
    const card = await propose(b, "team", { payload: { teamId: "t-SECRET-ID", teamName: "Core Platform" }, actor: LINEAR_FORM_ACTOR });
    const res = await portFor(b).detail({ workspaceId: String(WS), approvalId: String(card.id) });
    expect(res.ok && res.value.teamName).toBe("Core Platform");
    expect(JSON.stringify(res)).not.toContain("t-SECRET-ID");
  });

  it("⛔ rules 2+3 (slice-5a review): a team name on a card the form did NOT propose is never shown", async () => {
    // Only the form's proposer resolves the name from the list it read, next to the team id it sends. Any other
    // proposer (the Copilot) writes the payload itself, so a name there may name a DIFFERENT team than the one sent.
    const b = await backends(open);
    const card = await propose(b, "copilot-team", { payload: { teamId: "team-EXECUTIVE", teamName: "Personal errands" } });
    const res = await portFor(b).detail({ workspaceId: String(WS), approvalId: String(card.id) });
    expect(res.ok).toBe(true);
    expect(res.ok && res.value.teamName).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("Personal errands");
  });
});

describe("unsent — approved external cards whose write has not gone out", () => {
  it("lists writes-off and refused cards (refused FIRST); not sent, pending, other-workspace or unknown-workspace ones", async () => {
    const v = vendor();
    const b = await backends(open, { enabled: true, targets: ["linear"], workspaces: [String(WS)], make: () => v.transport });
    const port = portFor(b);
    const sent = await propose(b, "u-sent");
    expect((await port.sendNow({ workspaceId: String(WS), approvalId: String(sent.id) })).ok).toBe(true);
    const waiting = await propose(b, "u-wait", { ws: OTHER_WS }); // no key in OTHER_WS ⇒ writes_off
    await propose(b, "u-pending", { status: "pending" });
    // An approved card from another path, with nothing saved: "not sent" is not proven, so it is not listed.
    await b.repos.approvals.create({
      id: "idem_from_another_path" as never, actionRef: "act-x" as never, subjectKind: "external_action", workspaceId: OTHER_WS,
      status: "approved", actor: "owner", channel: "mac", payloadHash: "hash:x",
    });
    const listWs = await port.unsent({ workspaceId: String(WS) });
    expect(listWs).toEqual(ok([]));
    // A refused card (its saved write no longer matches) in the same workspace: listed, and FIRST.
    const refused = await propose(b, "u-refused", { ws: OTHER_WS });
    const saved = await b.repos.outbox.getByIdempotencyKey("idem:u-refused");
    if (!saved.ok) throw new Error("no saved entry");
    await b.repos.outbox.update({ ...saved.value, payload: { title: "changed" } });
    const listOther = await port.unsent({ workspaceId: String(OTHER_WS) });
    expect(listOther.ok && listOther.value.map((a) => a.id)).toEqual([refused.id, waiting.id]);
    expect(listOther.ok && listOther.value[1]?.targetSystem).toBe("linear"); // the waiting card names its system…
    expect(listOther.ok && listOther.value[0]?.targetSystem).toBeUndefined(); // …the refused one shows nothing from its saved write
    const unknown = await port.unsent({ workspaceId: "personal-business" });
    expect(unknown.ok).toBe(false);
  });
});

describe("sendNow — the same guarded dispatch, on demand (rule 3)", () => {
  it("writes off: refused as writes_off, nothing sent, still waiting", async () => {
    const b = await backends(open);
    const card = await propose(b, "s1");
    expect(await portFor(b).sendNow({ workspaceId: String(WS), approvalId: String(card.id) })).toEqual(
      ok({ approvalId: String(card.id), sendState: "writes_off" }),
    );
  });

  it("armed: sends once; a second Send now sends nothing more; two concurrent ones make one probe and one create", async () => {
    const v = vendor();
    const b = await backends(open, { enabled: true, make: () => v.transport });
    const port = portFor(b);
    const card = await propose(b, "s2");
    const input = { workspaceId: String(WS), approvalId: String(card.id) };
    const [a, c] = await Promise.all([port.sendNow(input), port.sendNow(input)]);
    expect(a).toEqual(ok({ approvalId: String(card.id), sendState: "sent" }));
    expect(c).toEqual(a);
    expect(await port.sendNow(input)).toEqual(ok({ approvalId: String(card.id), sendState: "sent" }));
    expect(v.calls.filter((x) => x.op === "query")).toHaveLength(1);
    expect(v.calls.filter((x) => x.op === "create")).toHaveLength(1);
  });

  it("⛔ refuses without sending: a pending card, a rejected card, another workspace's card, and no sender bound", async () => {
    const v = vendor();
    const b = await backends(open, { enabled: true, make: () => v.transport });
    const port = portFor(b);
    const pending = await propose(b, "s3", { status: "pending" });
    const rejected = await propose(b, "s4", { status: "rejected" });
    const mine = await propose(b, "s5");
    for (const [ws, id] of [[WS, pending.id], [WS, rejected.id], [OTHER_WS, mine.id]] as const) {
      expect((await port.sendNow({ workspaceId: String(ws), approvalId: String(id) })).ok).toBe(false);
    }
    expect((await portFor(b, false).sendNow({ workspaceId: String(WS), approvalId: String(mine.id) })).ok).toBe(false);
    expect(v.calls).toHaveLength(0);
  });
});

describe("the router — authed, and malformed input is refused before the port", () => {
  const calls: string[] = [];
  const fake: ApprovalSendPort = {
    detail: async () => (calls.push("detail"), ok({ approvalId: "a", sendState: "ready" })),
    unsent: async () => (calls.push("unsent"), ok([])),
    sendNow: async () => (calls.push("sendNow"), ok({ approvalId: "a", sendState: "sent" })),
  };
  const app = router({ approvalSend: buildApprovalSendRouter({ approvalSend: fake }) });
  const authed = createCallerFactory(app)({ auth: ok<AuthedContext>({ authenticated: true }) } as ApiContext);
  const anon = createCallerFactory(app)({ auth: err(failure("validation_rejected", "unauthenticated", { cause: { code: "AUTH" } })) } as ApiContext);

  it("an unauthenticated caller gets the auth error as data, and the port is never called", async () => {
    calls.length = 0;
    expect((await anon.approvalSend.detail({ workspaceId: "w", approvalId: "a" })).ok).toBe(false);
    expect((await anon.approvalSend.sendNow({ workspaceId: "w", approvalId: "a" })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a malformed input is refused before the port", async () => {
    calls.length = 0;
    await expect(authed.approvalSend.detail({ workspaceId: "", approvalId: "a" } as never)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("⛔ a port output that breaks its contract (an extra key) never crosses: APPROVAL_SEND_UNSERVABLE", async () => {
    const leaky: ApprovalSendPort = {
      detail: async () => ok({ approvalId: "a", sendState: "ready", payload: { secret: "x" } } as never),
      unsent: async () => ok([{ id: "a", status: "approved", channel: "mac", payload: "x" }] as never),
      sendNow: async () => ok({ approvalId: "a", sendState: "sent", workspaceId: "employer-work" } as never),
    };
    const caller = createCallerFactory(router({ approvalSend: buildApprovalSendRouter({ approvalSend: leaky }) }))({
      auth: ok<AuthedContext>({ authenticated: true }),
    } as ApiContext);
    for (const res of [
      await caller.approvalSend.detail({ workspaceId: "w", approvalId: "a" }),
      await caller.approvalSend.unsent({ workspaceId: "w" }),
      await caller.approvalSend.sendNow({ workspaceId: "w", approvalId: "a" }),
    ]) {
      expect(res.ok === false && res.error.cause).toEqual({ code: "APPROVAL_SEND_UNSERVABLE" });
    }
  });

  it("an authed, well-formed call reaches the port and its output is re-checked by the contract", async () => {
    calls.length = 0;
    expect(await authed.approvalSend.detail({ workspaceId: "w", approvalId: "a" })).toEqual(ok({ approvalId: "a", sendState: "ready" }));
    expect(calls).toEqual(["detail"]);
  });
});

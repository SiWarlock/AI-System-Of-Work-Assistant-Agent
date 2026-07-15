// Task 14.7 — the `crossWorkspaceLink` tRPC procedure. RED-first spec.
//
// create / approve / revoke over the injected CrossWorkspaceLinkCommandPort. Validates the
// candidate input at the transport edge (whitelisted fields; a smuggled status="approved" can
// NEVER pre-approve a link), returns typed UI-safe summaries, never throws, never echoes a raw
// driver cause (§16). Behind the auth gate. Owner-approval flow (safety rule 4 / WS-8).
import { describe, it, expect } from "vitest";
import { isErr, isOk, type Result } from "@sow/contracts";
import type { CrossWorkspaceLinkRow } from "@sow/db";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import {
  buildCrossWorkspaceLinkRouter,
  type CrossWorkspaceLinkCommandPort,
} from "../../../src/api/procedures/crossWorkspaceLink";
import type {
  CreateCrossWorkspaceLinkInput,
  CreateCrossWorkspaceLinkError,
  CrossWorkspaceLinkTransitionError,
} from "../../../src/composition/crossWorkspaceLink";

const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };
const UNAUTH_CTX: ApiContext = {
  auth: { ok: false, error: { kind: "validation_rejected", message: "unauthenticated", retryable: false } },
};

const VALID_CREATE: CreateCrossWorkspaceLinkInput = {
  linkId: "link-1",
  fromWorkspaceId: "ws-a",
  toWorkspaceId: "ws-b",
  scopeProjectionType: "coordination",
  scopeVisibilityLevel: "coordination",
};

function rowOf(input: CreateCrossWorkspaceLinkInput, status: CrossWorkspaceLinkRow["status"] = "pending"): CrossWorkspaceLinkRow {
  return {
    linkId: input.linkId,
    fromWorkspaceId: input.fromWorkspaceId as CrossWorkspaceLinkRow["fromWorkspaceId"],
    toWorkspaceId: input.toWorkspaceId as CrossWorkspaceLinkRow["toWorkspaceId"],
    scopeProjectionType: input.scopeProjectionType,
    scopeVisibilityLevel: input.scopeVisibilityLevel,
    status,
    createdAt: "2026-07-15T00:00:00.000Z",
    approvedAt: status === "approved" ? "2026-07-15T00:00:00.000Z" : null,
    revokedAt: status === "revoked" ? "2026-07-15T00:00:00.000Z" : null,
  };
}

class FakePort implements CrossWorkspaceLinkCommandPort {
  createCalls: CreateCrossWorkspaceLinkInput[] = [];
  constructor(
    private readonly createOutcome: (i: CreateCrossWorkspaceLinkInput) => Result<CrossWorkspaceLinkRow, CreateCrossWorkspaceLinkError> = (i) => ({ ok: true, value: rowOf(i) }),
  ) {}
  async create(input: CreateCrossWorkspaceLinkInput): Promise<Result<CrossWorkspaceLinkRow, CreateCrossWorkspaceLinkError>> {
    this.createCalls.push(input);
    return this.createOutcome(input);
  }
  async approve(input: { linkId: string }): Promise<Result<CrossWorkspaceLinkRow, CrossWorkspaceLinkTransitionError>> {
    return { ok: true, value: rowOf(VALID_CREATE, "approved") };
  }
  async revoke(input: { linkId: string }): Promise<Result<CrossWorkspaceLinkRow, CrossWorkspaceLinkTransitionError>> {
    return { ok: true, value: rowOf(VALID_CREATE, "revoked") };
  }
}

function caller(port: CrossWorkspaceLinkCommandPort, ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ crossWorkspaceLink: buildCrossWorkspaceLinkRouter({ crossWorkspaceLink: port }) });
  return createCallerFactory(appRouter)(ctx);
}

describe("crossWorkspaceLink procedure (14.7)", () => {
  it("create_round_trips: validates input, calls the port, returns a UI-safe summary landing PENDING [spec(§5)]", async () => {
    const port = new FakePort();
    const res = await caller(port).crossWorkspaceLink.create(VALID_CREATE);
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.linkId).toBe("link-1");
      expect(res.value.status).toBe("pending");
      expect(res.value.fromWorkspaceId).toBe("ws-a");
      expect(res.value.toWorkspaceId).toBe("ws-b");
    }
    expect(port.createCalls).toHaveLength(1);
  });

  it("create_cannot_be_pre_approved: a smuggled status field is stripped — the port receives only whitelisted create fields (owner approval stays explicit) [spec(§5)]", async () => {
    const port = new FakePort();
    const res = await caller(port).crossWorkspaceLink.create({ ...VALID_CREATE, status: "approved", approvedAt: "now" } as never);
    expect(isOk(res)).toBe(true);
    const forwarded = port.createCalls[0] as Record<string, unknown> | undefined;
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toHaveProperty("status");
    expect(forwarded).not.toHaveProperty("approvedAt");
  });

  it("create_rejects_malformed_input: an empty endpoint / missing scope ⇒ validation_rejected, never reaches the port [spec(§16)]", async () => {
    const port = new FakePort();
    const c = caller(port);
    expect(isErr(await c.crossWorkspaceLink.create({ ...VALID_CREATE, toWorkspaceId: "" }))).toBe(true);
    expect(isErr(await c.crossWorkspaceLink.create({ ...VALID_CREATE, scopeProjectionType: "" }))).toBe(true);
    expect(isErr(await c.crossWorkspaceLink.create({ ...VALID_CREATE, scopeVisibilityLevel: "not-a-level" }))).toBe(true);
    expect(port.createCalls).toHaveLength(0);
  });

  it("approve_and_revoke_round_trip: the transitions return typed UI-safe summaries [spec(§5)]", async () => {
    const c = caller(new FakePort());
    const appr = await c.crossWorkspaceLink.approve({ linkId: "link-1" });
    const rev = await c.crossWorkspaceLink.revoke({ linkId: "link-1" });
    expect(isOk(appr) && appr.value.status).toBe("approved");
    expect(isOk(rev) && rev.value.status).toBe("revoked");
  });

  it("error_is_typed_no_raw_cause_echoed: a create fault ⇒ stable code; the raw driver cause never crosses (§16) [spec(§16)]", async () => {
    const port = new FakePort(() => ({ ok: false, error: { code: "store_fault", message: "postgres: FATAL relation cross_workspace_link SECRET" } }));
    const res = await caller(port).crossWorkspaceLink.create(VALID_CREATE);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(JSON.stringify(res.error)).not.toContain("SECRET");
      expect(JSON.stringify(res.error)).not.toContain("postgres");
    }
  });

  it("requires_auth: an unauthenticated caller gets a typed err, the port never runs [spec(§16)]", async () => {
    const port = new FakePort();
    const res = await caller(port, UNAUTH_CTX).crossWorkspaceLink.create(VALID_CREATE);
    expect(isErr(res)).toBe(true);
    expect(port.createCalls).toHaveLength(0);
  });
});

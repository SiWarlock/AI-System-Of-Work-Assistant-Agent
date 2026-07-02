// Task 8.3 — Query procedures: read-model serving (§13 read-only, §10 UI-safe,
// §6 WS-8 cross-workspace, REQ-S-002 egress status, REQ-UX-002). TDD RED-first.
//
// These are READ-ONLY tRPC query procedures that serve UI-safe read models. Every
// procedure:
//   • runs BEHIND the 8.1 auth gate (via the 8.2 `authedResolver` seam);
//   • returns a `Result<T, FailureVariant>` as DATA — never throws (§16);
//   • returns ONLY UI-safe projection shapes — asserted against `UI_SAFE_ALLOWLIST`;
//   • routes an unknown / out-of-scope workspace to a typed forbidden/not-found
//     `err(FailureVariant)` — NEVER a partial raw leak;
//   • serves the global cross-workspace surface as GCL sanitized grouped results
//     (drill-down refs, never raw cross-workspace content inline — REQ-UX-002/§6).
//
// The read-model data is injected through the `ReadModelQueryPort` — a fake here,
// the real @sow/db binding is the integrator step. Procedures are invoked
// in-process via tRPC `createCallerFactory` (no socket).
import { describe, it, expect } from "vitest";
import {
  UI_SAFE_ALLOWLIST,
  isErr,
  isOk,
  ok,
  err,
  failure,
  type Result,
  type FailureVariant,
  type Approval,
  type WorkflowRunRef,
  type GclProjection,
} from "@sow/contracts";
import { createCallerFactory, router, type ApiContext } from "../../../src/api/trpc";
import type { AuthedContext } from "../../../src/api/auth/sessionAuth";
import {
  buildQueryRouter,
  type ReadModelQueryPort,
} from "../../../src/api/procedures/queries";

// ── Test helpers ──────────────────────────────────────────────────────────────

// The SORTED field-name set actually present on a projected object.
function fieldSet(obj: object): string[] {
  return Object.keys(obj).sort();
}

// Assert every field present on the projection is in the allowlist (a SUBSET —
// optional allowlisted fields are OMITTED when absent, never added-with-undefined).
function assertSubsetOfAllowlist(obj: object, allowlist: readonly string[]): void {
  const allowed = new Set<string>(allowlist);
  for (const name of fieldSet(obj)) {
    expect(allowed.has(name)).toBe(true);
  }
}

// Read an arbitrary (possibly-absent) key off a projected object through
// `unknown` so strict TS does not object to inspecting a non-declared name — the
// whole point is to assert non-allowlisted / raw names are ABSENT.
function asRecord(obj: object): Record<string, unknown> {
  return obj as unknown as Record<string, unknown>;
}

// An authenticated ApiContext (auth gate already passed — these tests exercise
// the resolver bodies, not the 8.1 interceptor, which has its own suite).
const AUTHED_CTX: ApiContext = {
  auth: ok<AuthedContext>({ authenticated: true }),
};

// An UNAUTHENTICATED context — the interceptor's typed failure surfaced as data.
const UNAUTH_CTX: ApiContext = {
  auth: err<FailureVariant>(
    failure("validation_rejected", "unauthenticated"),
  ),
};

// ── Fake domain records (all frozen fields present; sensitive fields set so the
//    UI-safe projection is proven to DROP them) ─────────────────────────────────

function fakeApproval(): Approval {
  return {
    id: "apr_1" as Approval["id"],
    actionRef: "act_1" as Approval["actionRef"],
    status: "pending",
    actor: "user:alice", // DROPPED by the UI-safe projection
    channel: "mac",
    payloadHash: "sha256:deadbeef", // DROPPED by the UI-safe projection
  };
}

function fakeWorkflowRunRef(): WorkflowRunRef {
  return {
    workflowId: "wf_1" as WorkflowRunRef["workflowId"],
    trigger: "manual",
    state: "running",
    idempotencyKey: "idem_1",
    auditRefs: ["aud_9" as WorkflowRunRef["auditRefs"][number]], // DROPPED
  };
}

// A GCL sanitized projection — SHORT single-line summary values only (the §6
// gate is key-name-independent). The global surface returns these, never raw
// cross-workspace content inline.
function fakeGclProjection(): GclProjection {
  return {
    workspaceId: "ws_employer" as GclProjection["workspaceId"],
    visibilityLevel: "sanitized",
    projectionType: "calendar_busy",
    sanitizedPayload: { summary: "busy 9-11", priority: "high" },
    sourceRefs: [{ sourceId: "src_1" as never, span: "1-2" }],
  };
}

// ── The fake ReadModelQueryPort — deterministic, in-memory ────────────────────

const KNOWN_WORKSPACE = "ws_personal";
const UNKNOWN_WORKSPACE = "ws_does_not_exist";

function notFoundWorkspace(workspaceId: string): FailureVariant {
  return failure("validation_rejected", "workspace not found", {
    cause: { code: "WORKSPACE_NOT_FOUND" },
  });
}

// A port that serves the KNOWN workspace and rejects everything else with a typed
// not-found — never a partial raw leak.
function fakePort(overrides: Partial<ReadModelQueryPort> = {}): ReadModelQueryPort {
  const base: ReadModelQueryPort = {
    dashboardCards: (): Result<
      readonly { cardId: string; kind: string; title: string; status: string; count: number; updatedAt: string }[],
      FailureVariant
    > =>
      ok([
        {
          cardId: "card_today",
          kind: "global_today",
          title: "Today",
          status: "ok",
          count: 3,
          updatedAt: "2026-06-30T00:00:00.000Z",
          // an adversarial extra key on the source — must NOT ride out
          secretField: "should never cross" as unknown as string,
        } as never,
      ]),

    workspaceCards: (workspaceId) =>
      workspaceId === KNOWN_WORKSPACE
        ? ok([
            {
              cardId: "card_ws",
              kind: "workspace",
              title: "Personal",
              status: "ok",
              count: 1,
              updatedAt: "2026-06-30T00:00:00.000Z",
            },
          ])
        : err(notFoundWorkspace(workspaceId)),

    projectCards: (workspaceId, _projectId) =>
      workspaceId === KNOWN_WORKSPACE
        ? ok([
            {
              cardId: "card_proj",
              kind: "project",
              title: "Proj",
              status: "ok",
              count: 2,
              updatedAt: "2026-06-30T00:00:00.000Z",
            },
          ])
        : err(notFoundWorkspace(workspaceId)),

    ingestionInbox: (workspaceId) =>
      workspaceId === KNOWN_WORKSPACE ? ok([fakeApproval()]) : err(notFoundWorkspace(workspaceId)),

    approvalInbox: (workspaceId) =>
      workspaceId === KNOWN_WORKSPACE ? ok([fakeApproval()]) : err(notFoundWorkspace(workspaceId)),

    copilotSurface: (workspaceId) =>
      workspaceId === KNOWN_WORKSPACE
        ? ok([fakeWorkflowRunRef()])
        : err(notFoundWorkspace(workspaceId)),

    globalSurface: (): Result<readonly GclProjection[], FailureVariant> =>
      ok([fakeGclProjection()]),
  };
  return { ...base, ...overrides };
}

// Build an in-process caller over a router that mounts ONLY the query router.
function makeCaller(port: ReadModelQueryPort, ctx: ApiContext = AUTHED_CTX) {
  const appRouter = router({ query: buildQueryRouter({ readModel: port }) });
  const factory = createCallerFactory(appRouter);
  return factory(ctx);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildQueryRouter — UI-safe read-model serving (§10/§13)", () => {
  it("dashboard (Global Today) returns UI-safe dashboard cards only — no injected extra key crosses", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.dashboard();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      const card = res.value[0]!;
      // ONLY allowlisted names — the adversarial `secretField` never rode out.
      expect(fieldSet(card)).toEqual([...UI_SAFE_ALLOWLIST.dashboardCard].sort());
      expect(asRecord(card).secretField).toBeUndefined();
    }
  });

  it("workspace query returns UI-safe cards for a KNOWN workspace", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.workspace({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(fieldSet(res.value[0]!)).toEqual([...UI_SAFE_ALLOWLIST.dashboardCard].sort());
    }
  });

  it("project query returns UI-safe cards for a KNOWN workspace", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.project({
      workspaceId: KNOWN_WORKSPACE,
      projectId: "proj_1",
    });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(fieldSet(res.value[0]!)).toEqual([...UI_SAFE_ALLOWLIST.dashboardCard].sort());
    }
  });

  it("ingestion inbox returns UI-safe Approval cards only (actor / payloadHash dropped)", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.ingestionInbox({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      const card = res.value[0]!;
      // Field set is a SUBSET of the allowlist — absent optionals (snoozeUntil /
      // expiresAt) are omitted, never added-as-undefined.
      assertSubsetOfAllowlist(card, UI_SAFE_ALLOWLIST.approval);
      expect(asRecord(card).actor).toBeUndefined();
      expect(asRecord(card).payloadHash).toBeUndefined();
    }
  });

  it("approval inbox returns UI-safe Approval cards only", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.approvalInbox({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      assertSubsetOfAllowlist(res.value[0]!, UI_SAFE_ALLOWLIST.approval);
    }
  });

  it("copilot surface returns UI-safe WorkflowRunRef cards only (auditRefs dropped)", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.copilot({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      const card = res.value[0]!;
      expect(fieldSet(card)).toEqual([...UI_SAFE_ALLOWLIST.workflowRunRef].sort());
      expect(asRecord(card).auditRefs).toBeUndefined();
    }
  });
});

describe("buildQueryRouter — unknown / out-of-scope workspace fails closed (§6)", () => {
  it("workspace query for an UNKNOWN workspace returns a typed not-found err (no partial raw leak)", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.workspace({ workspaceId: UNKNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe("validation_rejected");
      expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
    }
  });

  it("ingestion inbox for an UNKNOWN workspace returns a typed err, never inline data", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.ingestionInbox({ workspaceId: UNKNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("project query for an UNKNOWN workspace returns a typed err", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.project({
      workspaceId: UNKNOWN_WORKSPACE,
      projectId: "proj_1",
    });
    expect(isErr(res)).toBe(true);
  });
});

describe("buildQueryRouter — global surface is GCL sanitized (REQ-UX-002 / §6)", () => {
  it("global query returns GCL sanitized grouped projections — refs/summaries, never raw content inline", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.global();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      const proj = res.value[0]!;
      // The sanitized projection surfaces the visibility-scoped shape + drill-down
      // refs; every payload value is a SHORT single-line summary (§6 gate).
      expect(proj.visibilityLevel).toBe("sanitized");
      expect(Array.isArray(proj.sourceRefs)).toBe(true);
      for (const v of Object.values(proj.sanitizedPayload)) {
        expect(typeof v).toBe("string");
        // no multi-line raw content ever inlined
        expect(/[\r\n]/.test(v as string)).toBe(false);
      }
    }
  });

  it("global query never inlines a multi-line raw-content-shaped value", async () => {
    // Even if the port were to hand back a projection whose payload carried a
    // multi-line raw value, the global surface must reject it rather than inline
    // raw cross-workspace content (fail-closed — §6 WS-8).
    const leaky: GclProjection = {
      workspaceId: "ws_employer" as GclProjection["workspaceId"],
      visibilityLevel: "sanitized",
      projectionType: "note",
      // A multi-line raw body — a workspace-isolation breach if it ever inlines.
      sanitizedPayload: { body: "line one\nline two — verbatim raw content" },
      sourceRefs: [],
    };
    const caller = makeCaller(fakePort({ globalSurface: () => ok([leaky]) }));
    const res = await caller.query.global();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe("validation_rejected");
  });
});

describe("buildQueryRouter — auth gate + §16 boundary", () => {
  it("an UNAUTHENTICATED caller gets the interceptor's typed err as data (never throws)", async () => {
    const caller = makeCaller(fakePort(), UNAUTH_CTX);
    const res = await caller.query.dashboard();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.message).toBe("unauthenticated");
  });

  it("a port that THROWS is converted to a typed degraded err, never crossing the boundary", async () => {
    const caller = makeCaller(
      fakePort({
        dashboardCards: () => {
          throw new Error("boom — raw internal detail");
        },
      }),
    );
    const res = await caller.query.dashboard();
    expect(isErr(res)).toBe(true);
    if (isErr(res)) {
      expect(res.error.kind).toBe("degraded_unavailable");
      // redaction-safe: the raw thrown message never crosses the boundary
      expect(res.error.message).not.toContain("boom");
    }
  });
});

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

    // Candidate rows in NON-descending order (older first) so the procedure's server-side
    // re-sort is observable; unknown workspace → typed not-found (fail-closed).
    recentChanges: (workspaceId) =>
      workspaceId === KNOWN_WORKSPACE
        ? ok([
            { changeId: "chg_older", kind: "commit", summary: "committed b.md rev 0c4", occurredAt: "2026-07-02T00:00:00.000Z" },
            { changeId: "chg_newer", kind: "sync", summary: "synced cursor 2026-07-03", occurredAt: "2026-07-03T00:00:00.000Z" },
          ])
        : err(notFoundWorkspace(workspaceId)),

    projectDashboards: (workspaceId) =>
      workspaceId === KNOWN_WORKSPACE ? ok([validFakeProject]) : err(notFoundWorkspace(workspaceId)),
  };
  return { ...base, ...overrides };
}

// A valid UiSafeProjectDashboard candidate whose progress is deterministically consistent
// (percent === computePercent(2, 5) === 40) — the REQ-F-011 tests perturb `progress`.
const validFakeProject = {
  projectId: "prj-1",
  title: "Auth redesign",
  status: "on-track",
  progress: { completedCount: 2, totalCount: 5, percentComplete: 40 },
  blockers: ["waiting on vendor SSO cert"],
  waitingItems: [],
  nextActions: ["wire the callback route"],
  evidenceRefs: ["src:plan-abc123"],
  updatedAt: "2026-07-04T00:00:00.000Z",
};

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

  it("recentChanges returns UI-safe rows for a KNOWN workspace, RE-SORTED descending by occurredAt", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.recentChanges({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // The port returned [older, newer]; the procedure re-sorts DESC (newest first).
      expect(res.value.map((c) => c.changeId)).toEqual(["chg_newer", "chg_older"]);
      expect(fieldSet(res.value[0]!)).toEqual([...UI_SAFE_ALLOWLIST.recentChange].sort());
    }
  });

  it("recentChanges for an UNKNOWN workspace fails CLOSED (typed err, no inline row)", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.recentChanges({ workspaceId: UNKNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("recentChanges fails CLOSED if ANY row has a multi-line summary (re-validation leak gate)", async () => {
    const caller = makeCaller(
      fakePort({
        // A multi-line summary is the shape of leaked raw content — the frozen
        // UiSafeRecentChangeSchema must reject it, failing the WHOLE result closed.
        recentChanges: () =>
          ok([
            {
              changeId: "chg_leak",
              kind: "commit",
              summary: "line one\nverbatim raw content that leaked",
              occurredAt: "2026-07-03T00:00:00.000Z",
            },
          ]),
      }),
    );
    const res = await caller.query.recentChanges({ workspaceId: KNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("RECENT_CHANGE_SANITIZATION_REJECTED");
  });

  it("recentChanges sorts by INSTANT, not lexicographically (variable ISO fractional precision)", async () => {
    const caller = makeCaller(
      fakePort({
        recentChanges: () =>
          ok([
            { changeId: "chg_nofrac", kind: "commit", summary: "no fractional seconds", occurredAt: "2026-07-03T00:00:00Z" },
            { changeId: "chg_frac", kind: "commit", summary: "half a second later", occurredAt: "2026-07-03T00:00:00.500Z" },
          ]),
      }),
    );
    const res = await caller.query.recentChanges({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    // ".500Z" is chronologically LATER → must sort first (DESC by instant). A lexicographic
    // sort would wrongly rank "...00Z" first ('Z' > '.').
    if (isOk(res)) expect(res.value.map((c) => c.changeId)).toEqual(["chg_frac", "chg_nofrac"]);
  });

  it("recentChanges CAPS at 50, keeping the newest rows (server cap AFTER sort)", async () => {
    // 51 rows, ascending time; the oldest (chg_0) must fall below the cap, newest first.
    const rows = Array.from({ length: 51 }, (_, i) => ({
      changeId: `chg_${i}`,
      kind: "commit",
      summary: `change ${i}`,
      occurredAt: `2026-07-01T00:00:${String(i).padStart(2, "0")}.000Z`,
    }));
    const caller = makeCaller(fakePort({ recentChanges: () => ok(rows) }));
    const res = await caller.query.recentChanges({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(50); // capped
      expect(res.value[0]!.changeId).toBe("chg_50"); // newest first
      expect(res.value.some((c) => c.changeId === "chg_0")).toBe(false); // oldest dropped
    }
  });

  it("projectList returns re-validated UI-safe project dashboards for a KNOWN workspace", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.projectList({ workspaceId: KNOWN_WORKSPACE });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      expect(fieldSet(res.value[0]!)).toEqual([...UI_SAFE_ALLOWLIST.projectDashboard].sort());
      expect(res.value[0]!.progress.percentComplete).toBe(40);
    }
  });

  it("projectList for an UNKNOWN workspace fails CLOSED (typed err)", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.projectList({ workspaceId: UNKNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("WORKSPACE_NOT_FOUND");
  });

  it("projectList REJECTS an inconsistent progress triple (REQ-F-011: percent === count-derived)", async () => {
    const bad = { ...validFakeProject, progress: { completedCount: 2, totalCount: 5, percentComplete: 99 } };
    const caller = makeCaller(fakePort({ projectDashboards: () => ok([bad]) }));
    const res = await caller.query.projectList({ workspaceId: KNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("PROJECT_DASHBOARD_SANITIZATION_REJECTED");
  });

  it("projectList REJECTS a task-less project claiming 100% (REQ-F-011: totalCount 0 ⇒ 0%)", async () => {
    const bad = { ...validFakeProject, progress: { completedCount: 0, totalCount: 0, percentComplete: 100 } };
    const caller = makeCaller(fakePort({ projectDashboards: () => ok([bad]) }));
    const res = await caller.query.projectList({ workspaceId: KNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("PROJECT_DASHBOARD_SANITIZATION_REJECTED");
  });

  it("projectList REJECTS completedCount > totalCount even when the percent happens to match (count-ordering check)", async () => {
    // computePercent(6, 5) CLAMPS to 100, so percentComplete: 100 passes the equality clause —
    // ONLY the `completedCount <= totalCount` check catches this impossible triple.
    const bad = { ...validFakeProject, progress: { completedCount: 6, totalCount: 5, percentComplete: 100 } };
    const caller = makeCaller(fakePort({ projectDashboards: () => ok([bad]) }));
    const res = await caller.query.projectList({ workspaceId: KNOWN_WORKSPACE });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("PROJECT_DASHBOARD_SANITIZATION_REJECTED");
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
  it("global query returns UI-SAFE sanitized projections — a summary + drill flag, NEVER the raw record", async () => {
    const caller = makeCaller(fakePort());
    const res = await caller.query.global();
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      const proj = res.value[0]!;
      expect(proj.visibilityLevel).toBe("sanitized");
      // UI-safe: a short SINGLE-LINE summary — never the open sanitizedPayload record.
      expect(typeof proj.summary).toBe("string");
      expect(proj.summary.length).toBeGreaterThan(0);
      expect(/[\r\n]/.test(proj.summary)).toBe(false);
      // drillable is the shared §5 gate: a `sanitized` (< full) projection is NOT drillable.
      expect(proj.drillable).toBe(false);
      // The raw record's open/internal fields NEVER cross the UI-safe boundary.
      const asRec = proj as unknown as Record<string, unknown>;
      expect(asRec["sanitizedPayload"]).toBeUndefined();
      expect(asRec["sourceRefs"]).toBeUndefined();
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

describe("buildQueryRouter — globalDrillDown (SAFETY: workspace-scoped, visibility-gated)", () => {
  const proj = (workspaceId: string, projectionType: string, visibilityLevel: string): GclProjection => ({
    workspaceId: workspaceId as GclProjection["workspaceId"],
    visibilityLevel: visibilityLevel as GclProjection["visibilityLevel"],
    projectionType,
    sanitizedPayload: { summary: "busy 9-11" },
    sourceRefs: [],
  });

  it("PERMITS a drill-down at 'full' → returns the WORKSPACE-SCOPED cards (one workspace, never blended)", async () => {
    const caller = makeCaller(
      fakePort({ globalSurface: () => ok([proj(KNOWN_WORKSPACE, "calendar_busy", "full")]) }),
    );
    const res = await caller.query.globalDrillDown({
      workspaceId: KNOWN_WORKSPACE,
      projectionType: "calendar_busy",
    });
    expect(isOk(res)).toBe(true);
    // The fake returns cards ONLY for KNOWN_WORKSPACE, so an other-workspace / blended
    // read is structurally impossible — the drill is a single-workspace query.
    if (isOk(res)) expect(res.value.map((c) => c.cardId)).toEqual(["card_ws"]);
  });

  it("DENIES a drill-down below 'full' (sanitized / coordination / isolated) — no cards, typed err", async () => {
    for (const level of ["sanitized", "coordination", "isolated"] as const) {
      const caller = makeCaller(
        fakePort({ globalSurface: () => ok([proj(KNOWN_WORKSPACE, "calendar_busy", level)]) }),
      );
      const res = await caller.query.globalDrillDown({
        workspaceId: KNOWN_WORKSPACE,
        projectionType: "calendar_busy",
      });
      expect(isErr(res)).toBe(true);
      if (isErr(res)) expect(res.error.cause?.code).toBe("DRILL_NOT_PERMITTED");
    }
  });

  it("IGNORES a renderer-SPOOFED visibility level in the input — the gate re-derives from the SERVER projection", async () => {
    // The input carries only workspaceId + projectionType; a spoofed `visibilityLevel`
    // / `drillable` must not force a drill. Server projection is `sanitized` → deny.
    const caller = makeCaller(
      fakePort({ globalSurface: () => ok([proj(KNOWN_WORKSPACE, "calendar_busy", "sanitized")]) }),
    );
    const res = await caller.query.globalDrillDown({
      workspaceId: KNOWN_WORKSPACE,
      projectionType: "calendar_busy",
      visibilityLevel: "full",
      drillable: true,
    } as never);
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("DRILL_NOT_PERMITTED");
  });

  it("FAILS CLOSED on mixed levels — if ANY matching projection is below full, the drill is denied", async () => {
    const caller = makeCaller(
      fakePort({
        globalSurface: () =>
          ok([
            proj(KNOWN_WORKSPACE, "calendar_busy", "full"),
            proj(KNOWN_WORKSPACE, "calendar_busy", "sanitized"),
          ]),
      }),
    );
    const res = await caller.query.globalDrillDown({
      workspaceId: KNOWN_WORKSPACE,
      projectionType: "calendar_busy",
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("DRILL_NOT_PERMITTED");
  });

  it("returns DRILL_TARGET_NOT_FOUND when no global projection matches (never a partial leak / probe)", async () => {
    const caller = makeCaller(
      fakePort({ globalSurface: () => ok([proj("ws_employer", "calendar_busy", "full")]) }),
    );
    const res = await caller.query.globalDrillDown({
      workspaceId: KNOWN_WORKSPACE,
      projectionType: "calendar_busy",
    });
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.cause?.code).toBe("DRILL_TARGET_NOT_FOUND");
  });

  it("a leaky (multi-line) global projection fails the §6 gate BEFORE any drill is served", async () => {
    const leaky: GclProjection = {
      workspaceId: KNOWN_WORKSPACE as GclProjection["workspaceId"],
      visibilityLevel: "full",
      projectionType: "note",
      sanitizedPayload: { body: "line one\nverbatim raw" },
      sourceRefs: [],
    };
    const caller = makeCaller(fakePort({ globalSurface: () => ok([leaky]) }));
    const res = await caller.query.globalDrillDown({
      workspaceId: KNOWN_WORKSPACE,
      projectionType: "note",
    });
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
